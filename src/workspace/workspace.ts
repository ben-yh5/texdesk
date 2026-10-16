// Locating the workspace for a file, reading and writing its workspace.json, seeding a
// workspace from a starter, and creating files and typed folders. Everything here only
// creates files that don't exist yet (except workspace.json and app-owned support files).

import { Host, basename, dirname, extname, join } from "../host/types";
import type { FileInfo } from "../snippets/types";
import type { WorkspaceConfig } from "./config";
import { TEXDESK_STY } from "./links";
import {
  FolderEntry, FolderType, SCHEMA_FILE, WORKSPACE_FILE, WorkspaceFile, emptyWorkspace, formatWorkspace, parseWorkspace, scopeFor,
} from "./model";
import { WORKSPACE_SCHEMA } from "./schema";
import { Starter, starterById } from "./starters";
import {
  DEFAULT_TEMPLATES, LoadedTemplate, PREAMBLE_STY, TEMPLATES_README, builtinVars, defaultName, nextNumber, numberPattern,
  renderName, renderTemplate, templatesDir,
} from "./templates";

/** Nearest ancestor directory of `file` containing `.texdesk/`, or null. */
export async function findWorkspace(host: Host, file: string): Promise<string | null> {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (await host.exists(join(dir, ".texdesk"))) return dir;
    if (dir === "/") return null;
  }
}

export const workspaceFile = (root: string) => join(root, ".texdesk", WORKSPACE_FILE);

/** The workspace's workspace.json (empty if it has none yet), and what's wrong with it. */
export async function readWorkspace(host: Host, root: string): Promise<{ ws: WorkspaceFile; exists: boolean; errors: string[] }> {
  const p = workspaceFile(root);
  const errors: string[] = [];
  if (!(await host.exists(p))) return { ws: emptyWorkspace(), exists: false, errors };
  try { return { ws: parseWorkspace(await host.readText(p), errors), exists: true, errors }; }
  catch (e) { errors.push(`workspace.json: ${e instanceof Error ? e.message : String(e)}`); return { ws: emptyWorkspace(), exists: true, errors }; }
}

export async function writeWorkspace(host: Host, root: string, ws: WorkspaceFile): Promise<void> {
  await host.mkdirAll(join(root, ".texdesk"));
  await host.writeText(workspaceFile(root), formatWorkspace(ws));
}

export function fileInfoFor(file: string, root: string, cfg: WorkspaceConfig, ws: WorkspaceFile): FileInfo {
  const scope = scopeFor(root, cfg, ws, dirname(file));
  return { path: file, workspace: root, vars: scope.vars, folders: scope.folders };
}

async function createIfMissing(host: Host, path: string, content: string, created: string[]) {
  if (await host.exists(path)) return;
  await host.createText(path, content);
  created.push(path);
}

/** Writes an app-owned file if it's missing or stale. */
async function refresh(host: Host, path: string, content: string) {
  if (!(await host.exists(path)) || (await host.readText(path)) !== content) await host.writeText(path, content);
}

/** Folder holding app-owned LaTeX packages (texdesk.sty); on every build's search path. */
export function texSupportDir(root: string): string {
  return join(root, ".texdesk", "tex");
}

/** Writes `.texdesk/tex/texdesk.sty` and `.texdesk/workspace.schema.json` (app-owned, refreshed when stale). */
export async function ensureSupportFiles(host: Host, root: string): Promise<void> {
  await host.mkdirAll(texSupportDir(root));
  await refresh(host, join(texSupportDir(root), "texdesk.sty"), TEXDESK_STY);
  await refresh(host, join(root, ".texdesk", SCHEMA_FILE), WORKSPACE_SCHEMA);
}

/**
 * Gives a workspace without a `.texdesk/templates/` folder one, with the built-in templates
 * as editable files. An existing folder is left as it is, so a deleted template stays deleted.
 */
export async function ensureTemplates(host: Host, root: string): Promise<void> {
  const dir = templatesDir(root);
  if (await host.exists(dir)) return;
  for (const [name, text] of Object.entries(DEFAULT_TEMPLATES)) await createIfMissing(host, join(dir, name), text, []);
  await createIfMissing(host, join(dir, "README.md"), TEMPLATES_README, []);
}

/**
 * `ws` with a starter's folder types, templates and layouts added. Keys it already has are
 * kept unless listed in `replace`; `conflicts` lists them ("folder type class", …).
 */
export function applyStarter(ws: WorkspaceFile, starter: Starter, replace: Set<string> = new Set()): { ws: WorkspaceFile; conflicts: string[] } {
  const conflicts: string[] = [];
  const merge = <T,>(have: Record<string, T>, add: Record<string, T>, what: string): Record<string, T> => {
    const out = { ...have };
    for (const [k, v] of Object.entries(add)) {
      const id = `${what} ${k}`;
      if (k in have && JSON.stringify(have[k]) !== JSON.stringify(v)) { conflicts.push(id); if (!replace.has(id)) continue; }
      out[k] = v;
    }
    return out;
  };
  return {
    ws: {
      ...ws,
      folderTypes: merge(ws.folderTypes, starter.folderTypes, "folder type"),
      templates: merge(ws.templates, starter.templates, "template"),
      overviews: merge(ws.overviews, starter.overviews, "layout"),
    },
    conflicts,
  };
}

/** Writes a starter's template bodies; existing files are kept unless `overwrite`. Returns created paths. */
export async function writeStarterBodies(host: Host, root: string, starter: Starter, overwrite = false): Promise<string[]> {
  const created: string[] = [];
  for (const [name, text] of Object.entries(starter.bodies)) {
    const p = join(templatesDir(root), name);
    if (overwrite && (await host.exists(p))) await host.writeText(p, text);
    else await createIfMissing(host, p, text, created);
  }
  return created;
}

/**
 * Sets up `.texdesk/` (workspace.json from a starter, templates) and `preamble.sty` in
 * `root`. Existing files are left alone. Returns created paths.
 */
export async function seedWorkspace(host: Host, root: string, starterId = "blank"): Promise<string[]> {
  const starter = starterById(starterId);
  if (!starter) throw new Error(`unknown starter ${starterId}`);
  const created: string[] = [];
  const p = workspaceFile(root);
  if (!(await host.exists(p))) {
    await host.createText(p, formatWorkspace(applyStarter(emptyWorkspace(), starter).ws));
    created.push(p);
  }
  created.push(...(await writeStarterBodies(host, root, starter)));
  await createIfMissing(host, join(templatesDir(root), "README.md"), TEMPLATES_README, created);
  await createIfMissing(host, join(root, "preamble.sty"), PREAMBLE_STY, created);
  await ensureSupportFiles(host, root);
  return created;
}

// ---------------------------------------------------------------------------------------
// New files and folders

export interface Created {
  path: string;
  /** Where the cursor should go when the file is opened (-1 for a folder). */
  cursor: number;
  isDir: boolean;
}

/**
 * Creates a file in `dir` from template `t`. `vars` are the folder's variables plus any
 * answers to its prompts; `name` is a name the user typed instead of the template's own (its
 * number, if the template's name has `{{n}}`, is used as `{{n}}`). Never overwrites.
 */
export async function createFromTemplate(
  host: Host, t: LoadedTemplate, dir: string, vars: Record<string, string>, opts: { name?: string; now?: Date } = {},
): Promise<Created> {
  const pattern = t.header.name ?? defaultName();
  const all: Record<string, string> = { ...builtinVars(opts.now ?? new Date()), ...vars };
  if (numberPattern(pattern)) {
    const m = opts.name !== undefined ? numberPattern(pattern)!.exec(opts.name) : null;
    all.n = m ? m[1] : String(await nextNumber(host, dir, pattern, false));
  }
  let name = opts.name ?? renderName(pattern, all);
  if (!extname(name)) name += ".tex";
  const path = join(dir, name);
  if (await host.exists(path)) throw new Error(`${name} already exists`);
  all.stem = name.replace(/\.tex$/, "");
  all.title ??= all.stem;
  const { text, cursor } = renderTemplate(t.body, all);
  await host.createText(path, text);
  return { path, cursor, isDir: false };
}

/** The questions to ask for a new folder of `type`: its fields, or just a name if its name pattern doesn't come from them. */
export function folderQuestions(type: FolderType): { key: string; label: string; required: boolean }[] {
  const fields = (type.fields ?? []).map((f) => ({ key: f.key, label: f.label, required: !!f.required || !!type.name?.includes(`{{${f.key}}}`) }));
  return type.name ? fields : [{ key: "name", label: `Name of the new ${type.label}`, required: true }, ...fields];
}

/**
 * Creates a folder of `typeKey` inside `parent` (absolute), named from its pattern and
 * `answers`, with its scaffold. Returns the new folder and its workspace.json entry (the
 * caller saves it). `templateBody` reads a scaffold file's template.
 */
export async function createFolderOfType(
  host: Host, root: string, ws: WorkspaceFile, parent: string, typeKey: string, answers: Record<string, string>,
  opts: { now?: Date; config: WorkspaceConfig; templateBody?: (key: string) => Promise<string | null> },
): Promise<{ path: string; rel: string; entry: FolderEntry }> {
  const type = ws.folderTypes[typeKey];
  if (!type) throw new Error(`There's no folder type “${typeKey}”`);
  const scope = scopeFor(root, opts.config, ws, parent);
  const vars: Record<string, string> = { ...builtinVars(opts.now ?? new Date()), ...scope.vars, ...answers };
  const pattern = type.name ?? "{{name}}";
  if (numberPattern(pattern)) vars.n = String(await nextNumber(host, parent, pattern, true));
  const name = renderName(pattern, vars);
  if (/\{\{/.test(name)) throw new Error(`The name pattern ${pattern} needs a value for ${name.match(/\{\{([^}]+)\}\}/)![1]}`);
  const path = join(parent, name);
  if (await host.exists(path)) throw new Error(`${name} already exists`);
  await host.mkdirAll(path);
  const rel = path.slice(root.length + 1);
  const fields: Record<string, string> = {};
  for (const f of type.fields ?? []) if (answers[f.key] !== undefined && answers[f.key] !== "") fields[f.key] = answers[f.key];
  const entry: FolderEntry = { type: typeKey, ...(Object.keys(fields).length ? { fields } : {}) };
  // Scaffold files are filled in with the new folder's own variables.
  const inner = scopeFor(root, opts.config, { ...ws, folders: { ...ws.folders, [rel]: entry } }, path);
  const fileVars = { ...builtinVars(opts.now ?? new Date()), ...inner.vars };
  for (const s of type.scaffold ?? []) {
    const p = typeof s === "string" ? s : s.path;
    if (p.endsWith("/")) { await host.mkdirAll(join(path, p.slice(0, -1))); continue; }
    const target = join(path, p);
    if (await host.exists(target)) continue;
    const body = typeof s !== "string" && s.template && opts.templateBody ? await opts.templateBody(s.template) : null;
    await host.mkdirAll(dirname(target));
    await host.createText(target, body !== null ? renderTemplate(body, { ...fileVars, stem: basename(p).replace(/\.tex$/, ""), title: basename(p).replace(/\.tex$/, "") }).text : "");
  }
  return { path, rel, entry };
}

export async function createFile(host: Host, path: string): Promise<Created> {
  if (await host.exists(path)) throw new Error(`${basename(path)} already exists`);
  await host.createText(path, "");
  return { path, cursor: 0, isDir: false };
}
