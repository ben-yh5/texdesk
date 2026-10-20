// Plugins: folders of snippet files. Built-in ones ship with the app (read-only; off until
// you turn them on), yours live in ~/.config/texdesk/plugins/<id>/ and a workspace's in
// .texdesk/plugins/<id>/ (both on unless turned off). The folder name is the id; a plugin
// with the same id further in (workspace > yours > built-in) replaces the other one.
// A plugin.json gives its name and description, and for a copy of a built-in one made to edit
// ("Duplicate to edit"), "forkedFrom": the built-in's id. For now plugins hold snippets and key
// handlers only; the manifest is where commands and templates would be declared later.

import { Host, join } from "../host/types";
import type { SourceFile } from "../snippets/loader";
import type { SnippetFolder } from "../snippets/watch";
import { PLUGINS_README, SNIPPETS_TSCONFIG, texdeskDts } from "../workspace/seed";
import markdownShortcuts from "./builtin/markdown-shortcuts.ts?raw";
import bulletLists from "./builtin/bullet-lists.ts?raw";
import matrixKeys from "./builtin/matrix-keys.ts?raw";
import castel from "./builtin/castel.ts?raw";
import tikz from "./builtin/tikz.ts?raw";

import { MANIFEST } from "./manifest";
export { MANIFEST };

export type PluginSource = "workspace" | "user" | "built-in";

export interface Plugin {
  id: string;
  name: string;
  description: string;
  source: PluginSource;
  /** Its folder (null for a built-in one). */
  dir: string | null;
  /** A built-in plugin's files. */
  files?: SourceFile[];
  /** Turned on (after settings, defaults and replacement). */
  enabled: boolean;
  /** Replaced by a plugin with the same id further in (a workspace plugin over yours). */
  replacedBy: PluginSource | null;
  /** Problems with plugin.json. */
  error?: string;
  /** The built-in plugin this one was copied from to edit ("forkedFrom" in plugin.json). */
  forkedFrom?: string;
  /** A workspace plugin that's off because you haven't allowed code from that workspace. */
  blocked?: boolean;
}

export const BUILTIN_PLUGINS: { id: string; name: string; description: string; files: SourceFile[] }[] = [
  {
    id: "castel", name: "Gilles Castel's snippets",
    description: "The UltiSnips setup from castel.dev's lecture-notes post: mk/dm for math, // and x/ fractions, auto subscripts, sr/cb/td powers, lr( brackets, pmat, set symbols…",
    files: [{ name: "castel.ts", code: castel }],
  },
  {
    id: "markdown-shortcuts", name: "Markdown shortcuts",
    description: "* and 1. lists, # headings, > quotes, **bold**, *emphasis*, `code` and [links](url), as you type",
    files: [{ name: "markdown-shortcuts.ts", code: markdownShortcuts }],
  },
  {
    id: "bullet-lists", name: "Bullet lists",
    description: "- at the start of a line starts an itemize (or a new \\item in one); in an itemize, Enter adds an \\item",
    files: [{ name: "bullet-lists.ts", code: bulletLists }],
  },
  {
    id: "matrix-keys", name: "Matrix & align keys",
    description: "Tab → & and Enter → \\\\ in matrices, cases, align, tabular…",
    files: [{ name: "matrix-keys.ts", code: matrixKeys }],
  },
  {
    id: "tikz", name: "TikZ diagrams",
    description: "tikz and a space inserts a tikzpicture and opens it in the diagram editor",
    files: [{ name: "tikz.ts", code: tikz }],
  },
];

const ORDER: PluginSource[] = ["workspace", "user", "built-in"];

async function readManifest(host: Host, dir: string, id: string): Promise<{ name: string; description: string; error?: string; forkedFrom?: string }> {
  const p = join(dir, MANIFEST);
  if (!(await host.exists(p))) return { name: id, description: "" };
  try {
    const m = JSON.parse(await host.readText(p)) as { name?: unknown; description?: unknown; forkedFrom?: unknown };
    return {
      name: typeof m.name === "string" && m.name ? m.name : id, description: typeof m.description === "string" ? m.description : "",
      ...(typeof m.forkedFrom === "string" && m.forkedFrom ? { forkedFrom: m.forkedFrom } : {}),
    };
  } catch (e) {
    return { name: id, description: "", error: `${MANIFEST}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function pluginsIn(host: Host, dir: string | null, source: PluginSource): Promise<Plugin[]> {
  if (!dir || !(await host.exists(dir))) return [];
  const out: Plugin[] = [];
  for (const e of await host.readDir(dir)) {
    if (!e.isDir || e.name.startsWith(".")) continue;
    const pdir = join(dir, e.name);
    const m = await readManifest(host, pdir, e.name);
    out.push({ id: e.name, ...m, source, dir: pdir, enabled: true, replacedBy: null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every plugin: the workspace's (`workspaceDir`), yours (`userDir`) and the built-in ones,
 * in that order, each marked on or off from `enabled` (plugin id → on/off from settings).
 */
/**
 * Every plugin, with what's enabled worked out. `workspaceAllowed`: whether code from this
 * workspace may run (a folder you cloned or downloaded could hold anything); if not, its
 * plugins are listed but off, and don't replace yours.
 */
export async function listPlugins(host: Host, userDir: string | null, workspaceDir: string | null, enabled: Record<string, boolean>, workspaceAllowed = true): Promise<Plugin[]> {
  const all = [
    ...(await pluginsIn(host, workspaceDir, "workspace")).map((p) => (workspaceAllowed ? p : { ...p, blocked: true })),
    ...(await pluginsIn(host, userDir, "user")),
    ...BUILTIN_PLUGINS.map((b): Plugin => ({ ...b, source: "built-in", dir: null, enabled: false, replacedBy: null })),
  ];
  const first = new Map<string, PluginSource>();
  for (const p of all) {
    if (p.blocked) { p.enabled = false; continue; }
    const winner = first.get(p.id);
    if (winner) p.replacedBy = winner;
    else first.set(p.id, p.source);
    p.enabled = !p.replacedBy && (enabled[p.id] ?? p.source !== "built-in");
  }
  return all.sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source));
}

/** The snippet folders to load, highest priority first: enabled plugins, workspace before yours before built-in. */
export function snippetFolders(plugins: Plugin[]): SnippetFolder[] {
  return plugins.filter((p) => p.enabled).map((p) => ({ dir: p.dir, prefix: `${p.id}/`, files: p.files }));
}

/** Writes the shared support files (texdesk.d.ts, tsconfig.json, README.md) into a plugins folder. */
export async function ensurePluginsFolder(host: Host, dir: string): Promise<void> {
  await host.mkdirAll(dir);
  const dts = join(dir, "texdesk.d.ts");
  const want = texdeskDts();
  if (!(await host.exists(dts)) || (await host.readText(dts)) !== want) await host.writeText(dts, want);
  // Created only if missing (they're yours to edit); one made meanwhile (another window) is fine.
  const create = async (p: string, text: string) => {
    if (await host.exists(p)) return;
    try { await host.createText(p, text); } catch (err) { if (!(await host.exists(p))) throw err; }
  };
  await create(join(dir, "tsconfig.json"), SNIPPETS_TSCONFIG);
  await create(join(dir, "README.md"), PLUGINS_README);
}

/** A plugin folder name for `name`: "My snippets" → "my-snippets", unused in `dir`. */
export async function pluginIdFor(host: Host, dir: string, name: string): Promise<string> {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
  let id = base;
  for (let i = 2; await host.exists(join(dir, id)); i++) id = `${base}-${i}`;
  return id;
}

/** Creates a plugin folder with its manifest and (optionally) files. Returns its folder. */
export async function createPlugin(host: Host, dir: string, id: string, manifest: { name: string; description?: string; forkedFrom?: string }, files: SourceFile[] = []): Promise<string> {
  const pdir = join(dir, id);
  if (await host.exists(pdir)) throw new Error(`A plugin named ${id} already exists`);
  await ensurePluginsFolder(host, dir);
  const json = { name: manifest.name, description: manifest.description ?? "", version: "1", ...(manifest.forkedFrom ? { forkedFrom: manifest.forkedFrom } : {}) };
  await host.createText(join(pdir, MANIFEST), JSON.stringify(json, null, 2) + "\n");
  for (const f of files) await host.createText(join(pdir, f.name), f.code);
  return pdir;
}

export const NEW_PLUGIN_FILE = `// Snippets for this plugin. Every .ts file in this folder is loaded; see ../README.md.
import { snippets, s } from "texdesk";

export default snippets([
  // s("trigger", "replacement", { mode: "math", auto: true }),
]);
`;
