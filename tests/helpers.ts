import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { EditorSelection, EditorState, Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { snippetExtension } from "../src/snippets/cm";
import { loadSnippetFiles, SourceFile } from "../src/snippets/loader";
import { SnippetRuntime } from "../src/snippets/runtime";
import type { DirEntry, Host, MenuSection } from "../src/host/types";

export function fixtureFiles(dir: "snippets" | "broken", only?: string[]): SourceFile[] {
  const base = path.join(__dirname, "fixtures", dir);
  return fs.readdirSync(base)
    .filter((n) => n.endsWith(".ts") && (!only || only.includes(n)))
    .map((name) => ({ name, code: fs.readFileSync(path.join(base, name), "utf8") }));
}

export function runtimeFrom(files: SourceFile[]): SnippetRuntime {
  const rt = new SnippetRuntime();
  const r = loadSnippetFiles(files);
  rt.replace(r.set, r.errors, r.loaded.length);
  return rt;
}

/** Creates an editor. `doc` marks the cursor with `|`. */
export function editor(doc: string, rt: SnippetRuntime, extra: Extension[] = []): EditorView {
  const c = doc.indexOf("|");
  if (c < 0) throw new Error("doc needs a | cursor marker");
  const text = doc.slice(0, c) + doc.slice(c + 1);
  const selection = EditorSelection.single(c);
  const state = EditorState.create({
    doc: text,
    selection,
    extensions: [history(), indentUnit.of("  "), snippetExtension(rt), ...extra],
  });
  return new EditorView({ state, parent: document.body });
}

/** Simulates typing, going through the editor's input handlers like real keyboard input. */
export function type(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection.main;
    const handlers = view.state.facet(EditorView.inputHandler);
    const deflt = () => view.state.update(view.state.replaceSelection(ch), { userEvent: "input.type" });
    if (!handlers.some((h) => h(view, from, to, ch, deflt))) view.dispatch(deflt());
  }
}

export function press(view: EditorView, key: string): boolean {
  const parts = key.split("-");
  const k = parts.pop()!;
  const ev = new KeyboardEvent("keydown", {
    key: k, shiftKey: parts.includes("Shift"), bubbles: true, cancelable: true,
    // CodeMirror's Mod is Cmd on macOS, Ctrl elsewhere (jsdom isn't macOS).
    ...(parts.includes("Mod") ? (/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }) : {}),
  });
  return runScopeHandlers(view, ev, "editor");
}

export function select(view: EditorView, from: number, to: number) {
  view.dispatch({ selection: EditorSelection.single(from, to) });
}

/** The document with the main selection marked: `|` for a cursor, `[…]` for a range. */
export function show(view: EditorView): string {
  const s = view.state;
  const ranges = [...s.selection.ranges].sort((x, y) => y.from - x.from);
  let text = s.doc.toString();
  for (const r of ranges) {
    text = r.empty ? text.slice(0, r.from) + "|" + text.slice(r.from) : text.slice(0, r.from) + "[" + text.slice(r.from, r.to) + "]" + text.slice(r.to);
  }
  return text;
}

/** In-memory host; `touch` fires watchers like the real file watcher would. */
export function memoryHost(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const watchers: { dir: string; fn: (p: string[]) => void }[] = [];
  const isDir = (p: string) => [...files.keys()].some((f) => f.startsWith(p + "/"));
  const opened: string[] = [];
  const trashed: string[] = [];
  const treeWatchers: { root: string; ignore: string[]; fn: (p: string[]) => void }[] = [];
  const clipboard = { text: "" };
  const menu: { sections: MenuSection[]; select: (id: string) => void } = { sections: [], select: () => {} };
  /** File times for fileTimes (others that exist read as 0). */
  const times: Record<string, { created: number; modified: number }> = {};
  /** A stand-in spellchecker: misspelled word → suggestions (null = no spellchecker). */
  const spelling: { misspelled: Record<string, string[]> | null; corrections: Record<string, string>; asked: string[][] } = { misspelled: {}, corrections: {}, asked: [] };
  /** A stand-in Claude API: the saved key, the requests sent, and what to answer them with. */
  const ai: { key: string; denied: boolean; retries: number; requests: unknown[]; respond: (body: unknown) => unknown } = { key: "", denied: false, retries: 0, requests: [], respond: () => { throw new Error("no AI in tests"); } };
  const host: Host & { files: typeof files; opened: string[]; trashed: string[]; clipboard: { text: string }; menu: typeof menu; spelling: typeof spelling; times: typeof times; ai: typeof ai; touch(p: string, content?: string | null): void } = {
    kind: "dev",
    files,
    opened,
    trashed,
    clipboard,
    menu,
    spelling,
    times,
    ai,
    aiKeyStatus: async (retry) => { if (retry) ai.retries++; return ai.denied ? "denied" : ai.key ? "saved" : "none"; },
    aiSetKey: async (key) => { ai.key = key.trim(); },
    aiMessages: async (body) => { ai.requests.push(body); return ai.respond(body); },
    readText: async (p) => { const c = files.get(p); if (c === undefined) throw new Error(`ENOENT ${p}`); return c; },
    writeText: async (p, c) => { files.set(p, c); },
    createText: async (p, c) => {
      if (files.has(p) || isDir(p)) throw new Error(`EEXIST ${p}`);
      files.set(p, c);
    },
    listFiles: async (root, ignore) => {
      const out = new Map<string, boolean>();
      for (const f of files.keys()) {
        if (!f.startsWith(root + "/")) continue;
        const parts = f.slice(root.length + 1).split("/");
        if (parts.some((x) => ignore.includes(x))) continue;
        for (let i = 1; i <= parts.length; i++) {
          const rel = parts.slice(0, i).join("/");
          const dir = i < parts.length;
          if (!dir && parts[i - 1] === ".keep") continue;
          out.set(rel, dir || out.get(rel) === true);
        }
      }
      return [...out].map(([path, isDir]) => ({ path, isDir }));
    },
    openExternal: async (p) => { opened.push(p); },
    homeDir: async () => "/home",
    pickFolder: async () => null,
    pickSavePdf: async () => null,
    readClipboardText: async () => clipboard.text,
    writeClipboardText: async (t) => { clipboard.text = t; },
    setMenu: async (sections, onSelect) => { menu.sections = sections; menu.select = onSelect; },
    compile: async () => ({ ok: false, cancelled: false, exitCode: null, stdout: "", stderr: "", durationMs: 0, pdf: null, launchError: "no compiler in tests" }),
    cancelCompile: async () => {},
    fileTimes: async (paths) => paths.map((p) => times[p] ?? (files.has(p) || isDir(p) ? { created: 0, modified: 0 } : null)),
    checkSpelling: async (words) => {
      spelling.asked.push(words);
      const m = spelling.misspelled;
      return m && words.filter((w) => Object.hasOwn(m, w)).map((word) => ({ word, suggestions: m[word], correction: spelling.corrections[word] ?? null }));
    },
    sha256: async (p) => (files.has(p) ? createHash("sha256").update(files.get(p)!).digest("hex") : null),
    readBinary: async (p) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return new TextEncoder().encode(c).buffer as ArrayBuffer;
    },
    createBinary: async (p, data) => {
      if (files.has(p)) throw new Error(`EEXIST ${p}`);
      files.set(p, `<binary ${data.byteLength} bytes>`);
    },
    readClipboardImage: async () => null,
    readGzipText: async (p) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c; // tests store synctex uncompressed
    },
    copyFile: async (src, dest) => {
      const c = files.get(src);
      if (c === undefined) throw new Error(`ENOENT ${src}`);
      files.set(dest, c);
    },
    exists: async (p) => files.has(p) || isDir(p),
    trash: async (p) => {
      if (!files.has(p) && !isDir(p)) throw new Error(`ENOENT ${p}`);
      for (const f of [...files.keys()]) if (f === p || f.startsWith(p + "/")) files.delete(f);
      trashed.push(p);
    },
    move: async (from, to) => {
      if (!files.has(from) && !isDir(from)) throw new Error(`ENOENT ${from}`);
      if (files.has(to) || isDir(to)) throw new Error(`${to.slice(to.lastIndexOf("/") + 1)} already exists`);
      if (to.startsWith(from + "/")) throw new Error("can't move a folder into itself");
      for (const [f, c] of [...files]) {
        if (f === from || f.startsWith(from + "/")) { files.delete(f); files.set(to + f.slice(from.length), c); }
      }
    },
    readDir: async (dir) => {
      if (!isDir(dir)) throw new Error(`ENOTDIR ${dir}`);
      const out = new Map<string, DirEntry>();
      for (const f of files.keys()) {
        if (!f.startsWith(dir + "/")) continue;
        const rest = f.slice(dir.length + 1);
        const name = rest.split("/")[0];
        if (name === ".keep") continue;
        out.set(name, { name, isDir: rest.includes("/") });
      }
      return [...out.values()];
    },
    mkdirAll: async (p) => { if (!isDir(p)) files.set(p + "/.keep", ""); },
    watch: async (dir, fn) => { const w = { dir, fn }; watchers.push(w); return () => watchers.splice(watchers.indexOf(w), 1); },
    watchTree: async (root, ignore, fn) => {
      const w = { root, ignore, fn };
      treeWatchers.push(w);
      return () => treeWatchers.splice(treeWatchers.indexOf(w), 1);
    },
    initialFile: async () => null,
    pickFile: async () => null,
    setTitle: () => {},
    touch(p, content) {
      if (content === null) files.delete(p); else if (content !== undefined) files.set(p, content);
      for (const w of watchers) if (path.dirname(p) === w.dir) w.fn([p]);
      for (const w of treeWatchers) {
        if (p.startsWith(w.root + "/") && !p.slice(w.root.length + 1).split("/").some((x) => w.ignore.includes(x))) w.fn([p]);
      }
    },
  };
  return host;
}

export const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
