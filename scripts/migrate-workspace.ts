// Upgrades workspaces from the old setup files (config.toml, .texdesk.toml, %% template
// headers, folder templates) to .texdesk/workspace.json, and ~/.config/texdesk to
// settings.json + plugins/ — the same upgrade TeXdesk offers when it opens one.
//
//   npx tsx scripts/migrate-workspace.ts [--dry-run] [--global] [--rename old=new] [--backup dir] <workspace>…
//
// Old files go to the Trash (~/.Trash), or into --backup dir. --rename renames a folder type afterwards (e.g.
// course=class), rewriting template bodies that use it, like the type editor does.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Host, WalkEntry } from "../src/host/types";
import { applyGlobalMigration, applyMigration, describePlan, hasLegacySetup, mergeSettings, planGlobalMigration, planMigration } from "../src/workspace/migrate";
import { formatWorkspace, renameType, renameTypeInText } from "../src/workspace/model";
import { ensureSupportFiles, readWorkspace, writeWorkspace } from "../src/workspace/workspace";
import { listTemplates } from "../src/workspace/templates";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (name: string) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const dry = flag("--dry-run");
const global = flag("--global");
const rename = opt("--rename");
const backup = opt("--backup");

/** The parts of the app's Host the upgrade uses, on the real file system. */
function nodeHost(): Host {
  const trashDir = backup ? path.resolve(backup) : path.join(os.homedir(), ".Trash");
  fs.mkdirSync(trashDir, { recursive: true });
  const h: Partial<Host> = {
    readText: async (p) => fs.readFileSync(p, "utf8"),
    writeText: async (p, c) => fs.writeFileSync(p, c),
    createText: async (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, { flag: "wx" }); },
    exists: async (p) => fs.existsSync(p),
    mkdirAll: async (p) => { fs.mkdirSync(p, { recursive: true }); },
    readDir: async (p) => fs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() })),
    move: async (a, b) => { if (fs.existsSync(b)) throw new Error(`${b} already exists`); fs.renameSync(a, b); },
    trash: async (p) => {
      let dest = path.join(trashDir, path.basename(p));
      for (let i = 2; fs.existsSync(dest); i++) dest = path.join(trashDir, `${path.basename(p)} ${i}`);
      fs.renameSync(p, dest);
    },
    listFiles: async (root) => {
      const out: WalkEntry[] = [];
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if ([".git", "node_modules", ".build", ".DS_Store"].includes(e.name)) continue;
          const abs = path.join(dir, e.name);
          out.push({ path: path.relative(root, abs).split(path.sep).join("/"), isDir: e.isDirectory() });
          if (e.isDirectory()) walk(abs);
        }
      };
      walk(root);
      return out;
    },
  };
  return h as Host;
}

const host = nodeHost();
const gdir = path.join(os.homedir(), ".config", "texdesk");
const gfile = path.join(gdir, "settings.json");
const readGlobal = () => (fs.existsSync(gfile) ? JSON.parse(fs.readFileSync(gfile, "utf8")) : {});

if (global) {
  const m = await planGlobalMigration(host, gdir);
  console.log(`~/.config/texdesk: ${m.settings ? "config.toml → settings.json; " : ""}${m.moves.length ? `${m.moves.length} snippet files → plugins/latex-snippets; ` : ""}${m.trash.length ? `to the Trash: ${m.trash.map((p) => path.relative(gdir, p)).join(", ")}` : "nothing to do"}`);
  for (const n of m.notes) console.log(`  note: ${n}`);
  if (!dry) await applyGlobalMigration(host, gdir, m, readGlobal()); // TeXdesk adds the plugins folder's support files when it starts
}

for (const target of args) {
  const root = path.resolve(target);
  const entries = await host.listFiles(root, []);
  if (!hasLegacySetup(entries)) console.log(`${root}: already on workspace.json`);
  else {
    const plan = await planMigration(host, root, entries, readGlobal());
    console.log(`${root}: ${describePlan(plan)}`);
    if (Object.keys(plan.globalSettings).length) console.log(`  to your global settings: ${JSON.stringify(plan.globalSettings)}`);
    for (const p of plan.trash) console.log(`  to the Trash: ${path.relative(root, p)}`);
    for (const n of plan.notes) console.log(`  note: ${n}`);
    if (dry) { console.log(formatWorkspace(plan.ws)); continue; }
    await applyMigration(host, root, plan, async (add) => {
      fs.mkdirSync(gdir, { recursive: true });
      fs.writeFileSync(gfile, JSON.stringify(mergeSettings(readGlobal(), add), null, 2) + "\n");
    });
    await ensureSupportFiles(host, root);
  }
  if (rename && !dry) {
    const [from, to] = rename.split("=");
    const { ws } = await readWorkspace(host, root);
    if (!ws.folderTypes[from]) { console.log(`  no folder type ${from} to rename`); continue; }
    for (const t of await listTemplates(host, root, ws)) {
      if (!t.path) continue;
      const text = fs.readFileSync(t.path, "utf8");
      const next = renameTypeInText(text, from, to);
      if (next !== text) { fs.writeFileSync(t.path, next); console.log(`  rewrote ${path.relative(root, t.path)}`); }
    }
    await writeWorkspace(host, root, renameType(ws, from, to));
    console.log(`  renamed the folder type ${from} to ${to}`);
  }
}
