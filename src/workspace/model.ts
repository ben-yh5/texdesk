// `.texdesk/workspace.json`: a workspace's whole setup — its settings, folder types, which
// folders have which type, templates and overview layouts. The app reads and writes it; this
// module parses and validates it (bad parts are reported and left out, the rest still works),
// formats it, and answers questions about it (what's in effect in a folder, renames).

import { Raw, WorkspaceConfig, folderConfig } from "./config";
import type { FolderInfo } from "../snippets/types";
import { basename, dirname, join } from "../host/types";

export const WORKSPACE_FILE = "workspace.json";
export const SCHEMA_FILE = "workspace.schema.json";

export type SortKey = "created" | "modified" | "name";
export const SORT_KEYS: SortKey[] = ["created", "modified", "name"];

/** A value each folder of a type has, asked for when one is created (e.g. a class's name). */
export interface FieldDef {
  key: string;
  /** The question asked, e.g. "Course name, e.g. CS 101". */
  label: string;
  required?: boolean;
}

/** Made inside each new folder of a type: "notes/" is a folder; a file can start from a template. */
export type ScaffoldEntry = string | { path: string; template?: string };

export interface FolderType {
  label: string;
  /** Folder name pattern from its fields, e.g. "{{code}}"; unset = asked for. */
  name?: string;
  fields?: FieldDef[];
  /** Types allowed directly inside it (a term's classes). */
  children?: string[];
  scaffold?: ScaffoldEntry[];
  /** Default overview order of its folders' contents. */
  order?: string[];
  sort?: SortKey;
  /** figures_dir, pdf_name, export_pdf and vars for everything inside its folders. */
  settings?: Raw;
  /** Overview layout key in `overviews`. */
  overview?: string;
}

export interface FolderEntry {
  type?: string;
  fields?: Record<string, string>;
  order?: string[];
  sort?: SortKey;
  /** Overrides its type's settings (figures_dir, pdf_name, export_pdf, vars). */
  settings?: Raw;
  /** Its own overview layout (key in `overviews`), instead of its type's. */
  overview?: string;
}

export interface TemplateDef {
  label?: string;
  /** File in `.texdesk/templates/`. */
  body: string;
  /** A folder type: the file goes in the nearest folder of it. */
  in?: string;
  /** Subfolder of that folder. */
  dir?: string;
  /** File name pattern. */
  name?: string;
  /** Variable → question, asked before creating. */
  prompt?: Record<string, string>;
}

// ---- overview layouts ----------------------------------------------------------------

export interface HeaderBlock {
  type: "header"; fields?: string[]; up?: boolean;
  /** Files or folders to link to: workspace-relative, or "./…" relative to the folder. */
  links?: string[];
}
export interface TemplatesBlock {
  type: "templates";
  /** Template keys; unset = those whose `in` is this folder's type. */
  templates?: string[];
  /** Folder types to offer "New …" for; unset = the type's `children`. */
  folders?: string[];
}
export type FilesSort = "order" | "name" | "title" | "created" | "modified";
export type GroupBy = "subfolder" | "typed" | "none";
export interface FilesBlock {
  type: "files";
  title?: string;
  /** One subfolder (e.g. "hw"); with `inType`, that subfolder inside every folder of the type below. */
  subfolder?: string;
  inType?: string;
  /** Kinds of files listed (each defaults to true). */
  docs?: boolean;
  pdfs?: boolean;
  other?: boolean;
  /** Glob on the file name, e.g. "hw*.tex". */
  name?: string;
  /** Only files modified within this many days. */
  modifiedDays?: number;
  groupBy?: GroupBy;
  sort?: FilesSort;
  desc?: boolean;
  /** Columns (each defaults to true). */
  showTitle?: boolean;
  showDate?: boolean;
  showLinks?: boolean;
  showPdf?: boolean;
  limit?: number;
}
export interface SubfoldersBlock {
  type: "subfolders";
  title?: string;
  /** Only folders of this type (any typed folder if unset). */
  folderType?: string;
  /** "full": each one's own overview inline; "compact": one row each. */
  display?: "compact" | "full";
  /** Compact rows: fields to show. */
  fields?: string[];
  /** Compact rows: subfolders whose documents are counted ("notes 3 · hw 2"). */
  counts?: string[];
}
export type Block = HeaderBlock | TemplatesBlock | FilesBlock | SubfoldersBlock;
export const BLOCK_TYPES: Block["type"][] = ["header", "templates", "files", "subfolders"];

export interface OverviewLayout { blocks: Block[] }

/** Header, New buttons, and every file grouped by folder: the overview of a folder with no layout. */
export const DEFAULT_LAYOUT: OverviewLayout = { blocks: [{ type: "header" }, { type: "templates" }, { type: "files" }] };

export interface WorkspaceFile {
  version: 1;
  settings: Raw;
  folderTypes: Record<string, FolderType>;
  /** Workspace-relative folder path → its type, fields and overrides. */
  folders: Record<string, FolderEntry>;
  templates: Record<string, TemplateDef>;
  overviews: Record<string, OverviewLayout>;
}

export const emptyWorkspace = (): WorkspaceFile => ({ version: 1, settings: {}, folderTypes: {}, folders: {}, templates: {}, overviews: {} });

// ---- parsing -----------------------------------------------------------------------------

const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
/** Keys usable in {{variables}}: letters, digits and _. */
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseFields(v: unknown, where: string, errors: string[]): FieldDef[] {
  if (!Array.isArray(v)) { errors.push(`${where}: fields must be a list`); return []; }
  const out: FieldDef[] = [];
  for (const [i, f] of v.entries()) {
    if (!isObj(f) || typeof f.key !== "string" || !KEY_RE.test(f.key)) { errors.push(`${where}: fields[${i}] needs a key (letters, digits and _)`); continue; }
    if (out.some((x) => x.key === f.key)) { errors.push(`${where}: field ${f.key} appears twice`); continue; }
    out.push({ key: f.key, label: typeof f.label === "string" && f.label ? f.label : f.key, ...(f.required === true ? { required: true } : {}) });
  }
  return out;
}

function parseScaffold(v: unknown, where: string, errors: string[]): ScaffoldEntry[] {
  if (!Array.isArray(v)) { errors.push(`${where}: scaffold must be a list`); return []; }
  const out: ScaffoldEntry[] = [];
  for (const e of v) {
    const p = typeof e === "string" ? e : isObj(e) && typeof e.path === "string" ? e.path : null;
    if (!p || p.startsWith("/") || p.split("/").some((x) => x === ".." || x === ".")) { errors.push(`${where}: scaffold entries are relative paths like "notes/" or "README.tex"`); continue; }
    if (typeof e === "string") out.push(e);
    else out.push({ path: p, ...(isObj(e) && typeof e.template === "string" ? { template: e.template } : {}) });
  }
  return out;
}

function parseSort(v: unknown, where: string, errors: string[]): SortKey | undefined {
  if (v === undefined) return undefined;
  if (SORT_KEYS.includes(v as SortKey)) return v as SortKey;
  errors.push(`${where}: sort must be ${SORT_KEYS.map((k) => `"${k}"`).join(", ")}`);
  return undefined;
}

function parseType(key: string, v: unknown, errors: string[]): FolderType | null {
  const where = `folder type ${key}`;
  if (!KEY_RE.test(key)) { errors.push(`${where}: the key must be letters, digits and _`); return null; }
  if (!isObj(v)) { errors.push(`${where}: must be an object`); return null; }
  const t: FolderType = { label: typeof v.label === "string" && v.label ? v.label : key };
  if (typeof v.name === "string" && v.name) t.name = v.name;
  if (v.fields !== undefined) t.fields = parseFields(v.fields, where, errors);
  if (v.children !== undefined) { if (isStrList(v.children)) t.children = v.children; else errors.push(`${where}: children must be a list of folder types`); }
  if (v.scaffold !== undefined) t.scaffold = parseScaffold(v.scaffold, where, errors);
  if (v.order !== undefined) { if (isStrList(v.order)) t.order = v.order; else errors.push(`${where}: order must be a list of names`); }
  const sort = parseSort(v.sort, where, errors);
  if (sort) t.sort = sort;
  if (v.settings !== undefined) { if (isObj(v.settings)) t.settings = v.settings; else errors.push(`${where}: settings must be an object`); }
  if (typeof v.overview === "string") t.overview = v.overview;
  return t;
}

function parseFolder(path: string, v: unknown, errors: string[]): FolderEntry | null {
  const where = `folder ${path}`;
  if (!isObj(v)) { errors.push(`${where}: must be an object`); return null; }
  const f: FolderEntry = {};
  if (typeof v.type === "string") f.type = v.type;
  if (v.fields !== undefined) {
    if (isObj(v.fields)) f.fields = Object.fromEntries(Object.entries(v.fields).filter(([, x]) => typeof x === "string" || typeof x === "number").map(([k, x]) => [k, String(x)]));
    else errors.push(`${where}: fields must be an object`);
  }
  if (v.order !== undefined) { if (isStrList(v.order)) f.order = v.order; else errors.push(`${where}: order must be a list of names`); }
  const sort = parseSort(v.sort, where, errors);
  if (sort) f.sort = sort;
  if (v.settings !== undefined) { if (isObj(v.settings)) f.settings = v.settings; else errors.push(`${where}: settings must be an object`); }
  if (typeof v.overview === "string") f.overview = v.overview;
  return f;
}

function parseTemplate(key: string, v: unknown, errors: string[]): TemplateDef | null {
  const where = `template ${key}`;
  if (!isObj(v) || typeof v.body !== "string" || !v.body) { errors.push(`${where}: needs a body (a file in .texdesk/templates)`); return null; }
  if (v.body.includes("/") || v.body.startsWith(".")) { errors.push(`${where}: body must be a file name in .texdesk/templates`); return null; }
  const t: TemplateDef = { body: v.body };
  for (const k of ["label", "in", "dir", "name"] as const) {
    if (v[k] === undefined) continue;
    if (typeof v[k] === "string") { if (v[k]) t[k] = v[k] as string; } else errors.push(`${where}: ${k} must be a string`);
  }
  if (v.prompt !== undefined) {
    if (isObj(v.prompt) && Object.values(v.prompt).every((x) => typeof x === "string")) t.prompt = v.prompt as Record<string, string>;
    else errors.push(`${where}: prompt must map variable names to questions`);
  }
  return t;
}

function parseBlock(v: unknown, where: string, errors: string[]): Block | null {
  if (!isObj(v) || !BLOCK_TYPES.includes(v.type as Block["type"])) { errors.push(`${where}: each block needs a type: ${BLOCK_TYPES.join(", ")}`); return null; }
  // Blocks are small flat objects; keep the keys we know, with the right types.
  const out: Raw = { type: v.type };
  const spec: Record<string, "string" | "number" | "boolean" | "list"> = {
    fields: "list", up: "boolean", links: "list", templates: "list", folders: "list", title: "string", subfolder: "string", inType: "string",
    docs: "boolean", pdfs: "boolean", other: "boolean", name: "string", modifiedDays: "number", groupBy: "string", sort: "string",
    desc: "boolean", showTitle: "boolean", showDate: "boolean", showLinks: "boolean", showPdf: "boolean", limit: "number",
    folderType: "string", display: "string", counts: "list",
  };
  for (const [k, x] of Object.entries(v)) {
    if (k === "type") continue;
    const want = spec[k];
    if (!want) continue;
    const ok = want === "list" ? isStrList(x) : typeof x === want;
    if (ok) out[k] = x; else errors.push(`${where}: ${k} has the wrong type`);
  }
  if (out.groupBy !== undefined && !["subfolder", "typed", "none"].includes(out.groupBy as string)) { errors.push(`${where}: groupBy must be "subfolder", "typed" or "none"`); delete out.groupBy; }
  if (out.sort !== undefined && !["order", "name", "title", "created", "modified"].includes(out.sort as string)) { errors.push(`${where}: unknown sort ${out.sort}`); delete out.sort; }
  if (out.display !== undefined && !["compact", "full"].includes(out.display as string)) { errors.push(`${where}: display must be "compact" or "full"`); delete out.display; }
  return out as unknown as Block;
}

/** Parses workspace.json. Problems go in `errors`; what's valid is kept. */
export function parseWorkspace(text: string, errors: string[]): WorkspaceFile {
  const ws = emptyWorkspace();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { errors.push(`workspace.json: ${e instanceof Error ? e.message : String(e)}`); return ws; }
  if (!isObj(raw)) { errors.push("workspace.json: must be a JSON object"); return ws; }
  for (const k of Object.keys(raw)) {
    if (!["$schema", "version", "settings", "folderTypes", "folders", "templates", "overviews"].includes(k)) errors.push(`workspace.json: unknown key ${k}`);
  }
  if (raw.version !== undefined && raw.version !== 1) errors.push(`workspace.json: version ${String(raw.version)} is newer than this TeXdesk understands`);
  const section = (k: string): Raw => {
    const v = raw as Raw;
    if (v[k] === undefined) return {};
    if (isObj(v[k])) return v[k] as Raw;
    errors.push(`workspace.json: ${k} must be an object`);
    return {};
  };
  ws.settings = section("settings");
  for (const [k, v] of Object.entries(section("folderTypes"))) { const t = parseType(k, v, errors); if (t) ws.folderTypes[k] = t; }
  for (const [k, v] of Object.entries(section("folders"))) {
    const p = normalizeRel(k);
    if (p === null) { errors.push(`folders: "${k}" isn't a relative folder path`); continue; }
    const f = parseFolder(p, v, errors);
    if (f) ws.folders[p] = f;
  }
  for (const [k, v] of Object.entries(section("templates"))) { const t = parseTemplate(k, v, errors); if (t) ws.templates[k] = t; }
  for (const [k, v] of Object.entries(section("overviews"))) {
    if (!isObj(v) || !Array.isArray(v.blocks)) { errors.push(`overview ${k}: needs a list of blocks`); continue; }
    ws.overviews[k] = { blocks: v.blocks.map((b, i) => parseBlock(b, `overview ${k}, block ${i + 1}`, errors)).filter((b): b is Block => !!b) };
  }
  // References that point nowhere: reported, and harmless where used.
  for (const [p, f] of Object.entries(ws.folders)) if (f.type && !ws.folderTypes[f.type]) errors.push(`folder ${p}: there's no folder type "${f.type}"`);
  for (const [k, t] of Object.entries(ws.folderTypes)) {
    for (const c of t.children ?? []) if (!ws.folderTypes[c]) errors.push(`folder type ${k}: child type "${c}" doesn't exist`);
    if (t.overview && !ws.overviews[t.overview]) errors.push(`folder type ${k}: there's no overview layout "${t.overview}"`);
  }
  for (const [k, t] of Object.entries(ws.templates)) if (t.in && !ws.folderTypes[t.in]) errors.push(`template ${k}: there's no folder type "${t.in}"`);
  return ws;
}

/** "a/b/" → "a/b"; "" is the workspace root; null for absolute or ../ paths. */
export function normalizeRel(p: string): string | null {
  const parts = p.split("/").filter((x) => x && x !== ".");
  if (p.startsWith("/") || parts.includes("..")) return null;
  return parts.join("/");
}

/** workspace.json as written to disk: stable key order, empty sections left out, 2-space indent. */
export function formatWorkspace(ws: WorkspaceFile): string {
  const out: Raw = { $schema: `./${SCHEMA_FILE}`, version: 1 };
  if (Object.keys(ws.settings).length) out.settings = ws.settings;
  if (Object.keys(ws.folderTypes).length) out.folderTypes = ws.folderTypes;
  if (Object.keys(ws.folders).length) {
    out.folders = Object.fromEntries(Object.entries(ws.folders).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })));
  }
  if (Object.keys(ws.templates).length) out.templates = ws.templates;
  if (Object.keys(ws.overviews).length) out.overviews = ws.overviews;
  return JSON.stringify(out, null, 2) + "\n";
}

// ---- what applies in a folder ---------------------------------------------------------

/** What applies inside a folder: the workspace settings with every typed folder above it applied. */
export interface Scope {
  config: WorkspaceConfig;
  /** Template variables, nearest folder winning. */
  vars: Record<string, string>;
  /** Folders above (and including) the one asked about that have an entry, outermost first. */
  folders: FolderInfo[];
  /** Absolute figures folder, or null for `figures/` next to each file. */
  figuresDir: string | null;
  errors: string[];
}

const relOf = (root: string, abs: string) => (abs === root ? "" : abs.slice(root.length + 1));

/**
 * The settings and variables in effect in `dir` (absolute, inside workspace `root`). `cfg` is
 * the workspace's config (global settings with workspace.json's on top).
 */
export function scopeFor(root: string, cfg: WorkspaceConfig, ws: WorkspaceFile, dir: string): Scope {
  const chain: string[] = [];
  for (let d = dir; d.startsWith(root + "/"); d = dirname(d)) chain.unshift(d);
  let config = cfg;
  let figuresDir = cfg.figuresDir ? join(root, cfg.figuresDir) : null;
  const folders: FolderInfo[] = [];
  const errors: string[] = [];
  const vars: Record<string, string> = { ...cfg.vars };
  for (const d of chain) {
    const rel = relOf(root, d);
    const entry = ws.folders[rel];
    if (!entry) continue;
    const type = entry.type ? ws.folderTypes[entry.type] : undefined;
    for (const [settings, where] of [[type?.settings, `folder type ${entry.type}`], [entry.settings, `folder ${rel}`]] as const) {
      if (!settings) continue;
      config = folderConfig(config, settings, errors, where);
      if (typeof settings.figures_dir === "string") figuresDir = settings.figures_dir ? join(d, settings.figures_dir) : null;
      if (isObj(settings.vars)) {
        for (const [k, v] of Object.entries(settings.vars)) if (["string", "number", "boolean"].includes(typeof v)) vars[k] = String(v);
      }
    }
    // A typed folder's name and fields: {{class_folder}}, {{course}}, {{class.course}}.
    if (entry.type) {
      vars[`${entry.type}_folder`] = basename(d);
      for (const [k, v] of Object.entries(entry.fields ?? {})) { vars[k] = v; vars[`${entry.type}.${k}`] = v; }
    } else {
      for (const [k, v] of Object.entries(entry.fields ?? {})) vars[k] = v;
    }
    folders.push({ path: d, kind: entry.type ?? null });
  }
  return { config: { ...config, vars }, vars, folders, figuresDir, errors };
}

/** The nearest folder of `type` in a scope, or null. */
export function nearestOfType(scope: Scope, type: string): string | null {
  for (let i = scope.folders.length - 1; i >= 0; i--) if (scope.folders[i].kind === type) return scope.folders[i].path;
  return null;
}

/** Workspace-relative paths of every folder of `type` that exists (per `dirs`). */
export function foldersOfType(ws: WorkspaceFile, type: string, dirs?: Set<string>): string[] {
  return Object.entries(ws.folders).filter(([p, f]) => f.type === type && (!dirs || dirs.has(p))).map(([p]) => p);
}

/** Entries whose folder is gone (per `dirs`, the workspace's folders, relative). */
export function missingFolders(ws: WorkspaceFile, dirs: Set<string>): string[] {
  return Object.keys(ws.folders).filter((p) => p !== "" && !dirs.has(p));
}

/** The layout an overview of folder `rel` uses: its own, its type's, or the default. */
export function layoutFor(ws: WorkspaceFile, rel: string): { key: string | null; layout: OverviewLayout } {
  const entry = ws.folders[rel];
  const key = entry?.overview ?? (entry?.type ? ws.folderTypes[entry.type]?.overview : undefined) ?? null;
  const layout = key ? ws.overviews[key] : undefined;
  return layout ? { key, layout } : { key: null, layout: DEFAULT_LAYOUT };
}

/** Folders (relative paths) whose overview uses layout `key`. */
export function foldersUsingLayout(ws: WorkspaceFile, key: string): string[] {
  return Object.entries(ws.folders)
    .filter(([, f]) => (f.overview ?? (f.type ? ws.folderTypes[f.type]?.overview : undefined)) === key)
    .map(([p]) => p);
}

// ---- changes -------------------------------------------------------------------------

/** After a folder or file at `from` moves to `to` (relative), entries for it and inside it follow. */
export function moveFolderEntries(ws: WorkspaceFile, from: string, to: string): WorkspaceFile {
  let changed = false;
  const folders: Record<string, FolderEntry> = {};
  for (const [p, f] of Object.entries(ws.folders)) {
    if (p === from || p.startsWith(from + "/")) { folders[to + p.slice(from.length)] = f; changed = true; }
    else folders[p] = f;
  }
  // A renamed name keeps its place in its folder's order.
  const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const order = folders[parent]?.order;
  const name = basename("/" + from);
  if (order?.includes(name)) {
    const sameDir = (to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "") === parent;
    folders[parent] = { ...folders[parent], order: sameDir ? order.map((n) => (n === name ? basename("/" + to) : n)) : order.filter((n) => n !== name) };
    changed = true;
  }
  return changed ? { ...ws, folders } : ws;
}

/** Entries for a deleted folder (and everything inside it) removed. */
export function removeFolderEntries(ws: WorkspaceFile, rel: string): WorkspaceFile {
  const keep = Object.entries(ws.folders).filter(([p]) => p !== rel && !p.startsWith(rel + "/"));
  return keep.length === Object.keys(ws.folders).length ? ws : { ...ws, folders: Object.fromEntries(keep) };
}

/** Rewrites `{{old_folder}}` and `{{old.x}}` in a template body after a type's key changes. */
export function renameTypeInText(text: string, from: string, to: string): string {
  const e = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\{\\{${e}_folder\\}\\}`, "g"), `{{${to}_folder}}`).replace(new RegExp(`\\{\\{${e}\\.(\\w+)\\}\\}`, "g"), `{{${to}.$1}}`);
}

/** Rewrites `{{old}}` and `{{type.old}}` in a template body after a field's key changes. */
export function renameFieldInText(text: string, type: string, from: string, to: string): string {
  const e = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\{\\{${e(from)}\\}\\}`, "g"), `{{${to}}}`).replace(new RegExp(`\\{\\{${e(type)}\\.${e(from)}\\}\\}`, "g"), `{{${type}.${to}}}`);
}

/** The workspace with folder type `from` renamed to `to` everywhere it's referred to (not template bodies). */
export function renameType(ws: WorkspaceFile, from: string, to: string): WorkspaceFile {
  if (from === to || !ws.folderTypes[from]) return ws;
  if (ws.folderTypes[to]) throw new Error(`There's already a folder type “${to}”`);
  if (!KEY_RE.test(to)) throw new Error("Use letters, digits and _ (it's used in variables like {{" + to + "_folder}})");
  const folderTypes: Record<string, FolderType> = {};
  for (const [k, t] of Object.entries(ws.folderTypes)) {
    const next = t.children?.includes(from) ? { ...t, children: t.children.map((c) => (c === from ? to : c)) } : t;
    folderTypes[k === from ? to : k] = next;
  }
  const folders = Object.fromEntries(Object.entries(ws.folders).map(([p, f]) => [p, f.type === from ? { ...f, type: to } : f]));
  const templates = Object.fromEntries(Object.entries(ws.templates).map(([k, t]) => [k, t.in === from ? { ...t, in: to } : t]));
  const overviews = Object.fromEntries(Object.entries(ws.overviews).map(([k, l]) => [k, {
    blocks: l.blocks.map((b) => {
      if (b.type === "templates" && b.folders?.includes(from)) return { ...b, folders: b.folders.map((x) => (x === from ? to : x)) };
      if (b.type === "files" && b.inType === from) return { ...b, inType: to };
      if (b.type === "subfolders" && b.folderType === from) return { ...b, folderType: to };
      return b;
    }),
  }]));
  return { ...ws, folderTypes, folders, templates, overviews };
}

/** The workspace with field `from` of type `type` renamed to `to` (definitions, values and name pattern). */
export function renameField(ws: WorkspaceFile, type: string, from: string, to: string): WorkspaceFile {
  const t = ws.folderTypes[type];
  if (!t || from === to) return ws;
  if (!KEY_RE.test(to)) throw new Error("Use letters, digits and _");
  if (t.fields?.some((f) => f.key === to)) throw new Error(`${t.label} already has a field “${to}”`);
  const nt: FolderType = {
    ...t,
    fields: t.fields?.map((f) => (f.key === from ? { ...f, key: to } : f)),
    ...(t.name ? { name: renameFieldInText(t.name, type, from, to) } : {}),
  };
  const folders = Object.fromEntries(Object.entries(ws.folders).map(([p, f]) => {
    if (f.type !== type || !f.fields || !(from in f.fields)) return [p, f];
    const fields = Object.fromEntries(Object.entries(f.fields).map(([k, v]) => [k === from ? to : k, v]));
    return [p, { ...f, fields }];
  }));
  const overviews = Object.fromEntries(Object.entries(ws.overviews).map(([k, l]) => [k, {
    blocks: l.blocks.map((b) => (b.type === "header" || b.type === "subfolders") && b.fields?.includes(from) ? { ...b, fields: b.fields.map((x) => (x === from ? to : x)) } : b),
  }]));
  return { ...ws, folderTypes: { ...ws.folderTypes, [type]: nt }, folders, overviews };
}

/** A key for a new thing named `label`, unused among `taken`: "Lab report" → "lab_report". */
export function keyFor(label: string, taken: Iterable<string>): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "_$1") || "item";
  const used = new Set(taken);
  let k = base;
  for (let i = 2; used.has(k); i++) k = `${base}_${i}`;
  return k;
}
