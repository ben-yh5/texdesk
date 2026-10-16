// Vite plugin exposing a tiny file-system API to the browser during `npm run dev`, so
// the frontend (including snippet hot reload) can run without the Tauri shell.
// Access is confined to TEXDESK_DEV_ROOT (default: ./dev-workspace, created if missing) and ~/.config/texdesk
// (global settings and snippets).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn, type ChildProcess } from "node:child_process";
import type { Plugin } from "vite";

export function devFs(): Plugin {
  const root = path.resolve(process.env.TEXDESK_DEV_ROOT ?? "dev-workspace");
  fs.mkdirSync(root, { recursive: true });
  const watchers = new Map<number, fs.FSWatcher>();
  let nextId = 1;
  const builds = new Map<string, ChildProcess>();
  const killGroup = (c: ChildProcess) => { try { process.kill(-c.pid!, "SIGKILL"); } catch { /* already gone */ } };

  const global = path.join(os.homedir(), ".config", "texdesk");
  const within = (abs: string, dir: string) => abs === dir || abs.startsWith(dir + path.sep);
  const safe = (p: unknown): string => {
    if (typeof p !== "string") throw new Error("path must be a string");
    const abs = path.resolve(p);
    if (!within(abs, root) && !within(abs, global)) throw new Error(`path outside dev root: ${abs}`);
    return abs;
  };

  return {
    name: "texdesk-dev-fs",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__texdesk/fs", (req, res) => {
        if (req.method === "GET" && req.url?.startsWith("/raw?")) {
          try {
            const p = new URLSearchParams(req.url.slice(5)).get("path");
            return res.end(fs.readFileSync(safe(p)));
          } catch (err) {
            res.statusCode = 400;
            return res.end(String(err));
          }
        }
        if (req.method === "POST" && req.url?.startsWith("/create-binary?")) {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            try {
              const p = safe(new URLSearchParams(req.url!.slice(15)).get("path"));
              fs.mkdirSync(path.dirname(p), { recursive: true });
              fs.writeFileSync(p, Buffer.concat(chunks), { flag: "wx" });
              res.end("null");
            } catch (err) {
              res.statusCode = 400;
              res.end(String(err));
            }
          });
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          const send = (v: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v ?? null)); };
          try {
            const a = body ? JSON.parse(body) : {};
            switch (req.url?.replace(/^\//, "")) {
              case "read": return send(fs.readFileSync(safe(a.path), "utf8"));
              case "write": fs.writeFileSync(safe(a.path), a.content); return send(null);
              case "exists": {
                // Walking up for .texdesk may leave the root; answer false there instead of erroring.
                const abs = path.resolve(a.path);
                return send((within(abs, root) || within(abs, global)) && fs.existsSync(abs));
              }
              case "list": return send(fs.readdirSync(safe(a.path), { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() })));
              case "mkdir": fs.mkdirSync(safe(a.path), { recursive: true }); return send(null);
              case "create": {
                const abs = safe(a.path);
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                fs.writeFileSync(abs, a.content, { flag: "wx" });
                return send(null);
              }
              case "root": return send(root);
              case "home": return send(os.homedir());
              case "trash": {
                // Dev only: "trash" into the OS temp folder instead of the real Trash.
                const abs = safe(a.path);
                const bin = fs.mkdtempSync(path.join(os.tmpdir(), "texdesk-trash-"));
                fs.renameSync(abs, path.join(bin, path.basename(abs)));
                return send(null);
              }
              case "move": {
                const from = safe(a.from), to = safe(a.to);
                if (fs.existsSync(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error(`${path.basename(to)} already exists`);
                if (to.startsWith(from + path.sep)) throw new Error("can't move a folder into itself");
                fs.renameSync(from, to);
                return send(null);
              }
              case "sha256": {
                const abs = safe(a.path);
                return send(fs.existsSync(abs) ? crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex") : null);
              }
              case "times": return send((a.paths as string[]).map((p) => {
                try { const st = fs.statSync(safe(p)); return { created: st.birthtimeMs || st.mtimeMs, modified: st.mtimeMs }; } catch { return null; }
              }));
              case "gunzip": return send(zlib.gunzipSync(fs.readFileSync(safe(a.path))).toString("utf8"));
              case "copy": fs.copyFileSync(safe(a.src), safe(a.dest)); return send(null);
              case "cancel-compile": { const c = builds.get(a.file); if (c) killGroup(c); builds.delete(a.file); return send(null); }
              case "compile": {
                const file = safe(a.file);
                const dir = path.dirname(file);
                fs.mkdirSync(path.join(dir, ".build"), { recursive: true });
                const args = ["--outdir", path.join(dir, ".build"), "--keep-logs", "--keep-intermediates", "--synctex", "--chatter", "minimal",
                  ...(a.searchPaths as string[]).flatMap((p) => ["-Z", `search-path=${p}`]), path.basename(file)];
                const prev = builds.get(file);
                if (prev) killGroup(prev);
                const started = Date.now();
                const child = spawn(a.tectonic || "tectonic", args, { cwd: dir, detached: true });
                builds.set(file, child);
                let stdout = "", stderr = "";
                child.stdout!.on("data", (d) => (stdout += d));
                child.stderr!.on("data", (d) => (stderr += d));
                const result = await new Promise<Record<string, unknown>>((resolve) => {
                  child.on("error", (e) => resolve({ ok: false, cancelled: false, exitCode: null, stdout, stderr, durationMs: 0, pdf: null,
                    launchError: `Tectonic isn't installed (or isn't on PATH): ${e.message}` }));
                  child.on("close", (code) => {
                    const cancelled = builds.get(file) !== child;
                    if (!cancelled) builds.delete(file);
                    const pdf = path.join(dir, ".build", path.basename(file).replace(/\.tex$/, ".pdf"));
                    resolve({ ok: code === 0 && !cancelled, cancelled, exitCode: code, stdout, stderr, durationMs: Date.now() - started,
                      pdf: code === 0 && fs.existsSync(pdf) ? pdf : null, launchError: null });
                  });
                });
                return send(result);
              }
              case "walk": {
                // Dev approximation of gitignore matching: patterns match a name or a glob on the name.
                const base = safe(a.path);
                const res = (a.ignore as string[]).map((p) => new RegExp("^" + p.replace(/\/$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
                const out: { path: string; isDir: boolean }[] = [];
                const walk = (dir: string) => {
                  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (res.some((r) => r.test(d.name))) continue;
                    const full = path.join(dir, d.name);
                    out.push({ path: path.relative(base, full), isDir: d.isDirectory() });
                    if (d.isDirectory()) walk(full);
                  }
                };
                walk(base);
                return send(out);
              }
              case "watch": {
                const dir = safe(a.path);
                const id = nextId++;
                watchers.set(id, fs.watch(dir, (_ev, name) => {
                  server.ws.send({ type: "custom", event: "texdesk:fs-change", data: { id, paths: [path.join(dir, String(name ?? ""))] } });
                }));
                return send(id);
              }
              case "watch-tree": {
                // Dev only: plain folder names in `ignore` are skipped (enough for the defaults).
                const dir = safe(a.path);
                const ignored = new Set<string>(a.ignore ?? []);
                const id = nextId++;
                watchers.set(id, fs.watch(dir, { recursive: true }, (_ev, name) => {
                  const rel = String(name ?? "");
                  if (rel.split(path.sep).some((part) => ignored.has(part))) return;
                  server.ws.send({ type: "custom", event: "texdesk:fs-change", data: { id, paths: [path.join(dir, rel)] } });
                }));
                return send(id);
              }
              case "unwatch": watchers.get(a.id)?.close(); watchers.delete(a.id); return send(null);
              default: res.statusCode = 404; return res.end("unknown op");
            }
          } catch (err) {
            res.statusCode = 400;
            res.end(err instanceof Error ? err.message : String(err));
          }
        });
      });
    },
  };
}
