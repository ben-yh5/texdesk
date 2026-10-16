// Upgrading from the old setup files: a workspace's `.texdesk/config.toml`, the
// `.texdesk.toml` files in its folders, `%%` headers in templates and folder templates
// (`templates/<Name>/template.toml`) become one `.texdesk/workspace.json`; the global
// `~/.config/texdesk/config.toml` becomes `settings.json` and the global snippets folder
// becomes the "LaTeX snippets" plugin. Planning reads only; applying writes the new files,
// then moves the old ones to the Trash.

import { parse as parseToml } from "smol-toml";
import { Host, WalkEntry, basename, dirname, join } from "../host/types";
import { Raw, applySettings, defaultConfig } from "./config";
import { FieldDef, FolderEntry, FolderType, SORT_KEYS, SortKey, TemplateDef, WorkspaceFile, emptyWorkspace, formatWorkspace } from "./model";
import { TEMPLATES_README, questionFor } from "./templates";
import { MANIFEST } from "../plugins/manifest";

/** The old per-folder settings file. */
export const LEGACY_FOLDER_FILE = ".texdesk.toml";
const LEGACY_CONFIG = ".texdesk/config.toml";

export interface MigrationPlan {
  ws: WorkspaceFile;
  /** Settings to add to the global settings.json (only keys it doesn't set yet). */
  globalSettings: Raw;
  /** Files to write (absolute path → text): rewritten template bodies, a new templates README. */
  writes: Map<string, string>;
  /** Files to move (absolute). */
  moves: { from: string; to: string }[];
  /** Old files and folders to move to the Trash once the new ones are written (absolute). */
  trash: string[];
  /** What couldn't be converted, for the person upgrading. */
  notes: string[];
}

const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const tomlAt = async (host: Host, p: string, notes: string[], where: string): Promise<Raw | null> => {
  try { return parseToml(await host.readText(p)) as Raw; } catch (e) { notes.push(`${where} couldn't be read (${e instanceof Error ? e.message : String(e)}); it was left out`); return null; }
};

/** Splits a template into its `%%` header (TOML, without the `%%`) and the rest. */
export function splitHeader(text: string): { header: string; body: string } {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && /^%%( |$)/.test(lines[i])) i++;
  return { header: lines.slice(0, i).map((l) => l.replace(/^%% ?/, "")).join("\n"), body: lines.slice(i).join("\n") };
}

/** Whether `root` still has old setup files (per a file listing). */
export function hasLegacySetup(entries: WalkEntry[]): boolean {
  return entries.some((e) => !e.isDir && (e.path === LEGACY_CONFIG || basename(e.path) === LEGACY_FOLDER_FILE));
}

/** Whether a setting's value is the default (so there's no need to carry it over). */
function isDefault(table: string, key: string, value: unknown): boolean {
  const raw: Raw = table ? { [table]: { [key]: value } } : { [key]: value };
  const errors: string[] = [];
  const next = applySettings(defaultConfig, raw, errors, "");
  return !errors.length && JSON.stringify(next) === JSON.stringify(defaultConfig);
}

/** Prompt table/list from a header, as name → question. */
function promptOf(p: unknown): Record<string, string> {
  if (Array.isArray(p)) return Object.fromEntries(p.filter((x) => typeof x === "string").map((n) => [n, questionFor(n)]));
  if (isObj(p)) return Object.fromEntries(Object.entries(p).filter(([, q]) => typeof q === "string")) as Record<string, string>;
  return {};
}

const FOLDER_SETTING_KEYS = ["figures_dir", "pdf_name", "export_pdf"];

/**
 * Plans the upgrade of workspace `root` (from a listing of its files). `globalRaw` is the
 * current global settings, so personal settings already set there aren't overridden.
 */
export async function planMigration(host: Host, root: string, entries: WalkEntry[], globalRaw: Raw): Promise<MigrationPlan> {
  const ws = emptyWorkspace();
  const notes: string[] = [];
  const writes = new Map<string, string>();
  const moves: MigrationPlan["moves"] = [];
  const trash: string[] = [];
  const globalSettings: Raw = {};
  const files = entries.filter((e) => !e.isDir).map((e) => e.path);
  const dirs = new Set(entries.filter((e) => e.isDir).map((e) => e.path));

  // ---- .texdesk/config.toml → settings (personal ones → the global settings, if not set there)
  if (files.includes(LEGACY_CONFIG)) {
    const raw = await tomlAt(host, join(root, LEGACY_CONFIG), notes, LEGACY_CONFIG);
    if (raw) {
      for (const [k, v] of Object.entries(raw)) {
        if (["editor", "build", "ai", "keys"].includes(k) && isObj(v)) {
          const g = isObj(globalRaw[k]) ? globalRaw[k] as Raw : {};
          for (const [kk, vv] of Object.entries(v)) {
            if ((k === "editor" && kk === "list_editing") || (k === "keys" && kk === "add_problem")) continue; // removed
            if (isDefault(k, kk, vv)) continue;
            if (kk in g) ((ws.settings[k] ??= {}) as Raw)[kk] = vv; // global has its own: keep this workspace's here
            else ((globalSettings[k] ??= {}) as Raw)[kk] = vv;
          }
        } else if (k === "vars" && isObj(v)) {
          const vars = Object.fromEntries(Object.entries(v).filter(([kk, vv]) => !isDefault("vars", kk, vv)));
          if (Object.keys(vars).length) ws.settings.vars = vars;
        } else if (!isDefault("", k, v)) ws.settings[k] = v;
      }
    }
    trash.push(join(root, LEGACY_CONFIG));
  }

  // ---- folder templates: templates/<Name>/ with template.toml → folder types
  const tdir = ".texdesk/templates";
  const folderTemplates = [...dirs].filter((d) => dirname("/" + d).slice(1) === tdir);
  /** Folder template name → the kind its .texdesk.toml sets (the type it makes). */
  const typeOfTemplate = new Map<string, string>();
  const scaffoldFiles: { type: string; path: string; text: string }[] = [];
  for (const d of folderTemplates) {
    const name = basename(d);
    const header = files.includes(`${d}/template.toml`) ? await tomlAt(host, join(root, d, "template.toml"), notes, `${d}/template.toml`) : {};
    const inner = files.includes(`${d}/${LEGACY_FOLDER_FILE}`) ? await tomlAt(host, join(root, d, LEGACY_FOLDER_FILE), notes, `${d}/${LEGACY_FOLDER_FILE}`) : null;
    const kind = typeof inner?.kind === "string" ? inner.kind : name.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    typeOfTemplate.set(name, kind);
    const prompt = promptOf(header?.prompt);
    const t: FolderType = { label: typeof header?.label === "string" ? header.label : name };
    // Fields: the prompts (in order), plus vars the folder's .texdesk.toml fills from them.
    const fields: FieldDef[] = Object.entries(prompt).map(([key, label]) => ({ key, label }));
    const typeVars: Raw = {};
    for (const [k, v] of Object.entries(isObj(inner?.vars) ? inner!.vars as Raw : {})) {
      const m = typeof v === "string" ? /^\{\{(\w+)\}\}$/.exec(v) : null;
      if (m) {
        // course = "{{course}}": a field named after the variable, asked with the prompt's question.
        const at = fields.findIndex((f) => f.key === m[1]);
        if (at >= 0) fields[at] = { ...fields[at], key: k };
        else if (!fields.some((f) => f.key === k)) fields.push({ key: k, label: questionFor(k) });
      } else typeVars[k] = v;
    }
    if (typeof header?.name === "string") {
      t.name = header.name;
      for (const f of fields) if (header.name.includes(`{{${f.key}}}`)) f.required = true;
    }
    if (fields.length) t.fields = fields;
    const settings: Raw = {};
    for (const k of FOLDER_SETTING_KEYS) if (inner && inner[k] !== undefined) settings[k] = inner[k];
    if (Object.keys(typeVars).length) settings.vars = typeVars;
    if (Object.keys(settings).length) t.settings = settings;
    if (inner && Array.isArray(inner.order)) t.order = inner.order.filter((x): x is string => typeof x === "string");
    if (inner && SORT_KEYS.includes(inner.sort as SortKey)) t.sort = inner.sort as SortKey;
    // The template folder's contents (other than its settings) are what each new folder starts with.
    const scaffold: (string | { path: string; template?: string })[] = [];
    for (const e of entries) {
      if (!e.path.startsWith(d + "/")) continue;
      const rel = e.path.slice(d.length + 1);
      if (rel === "template.toml" || rel === LEGACY_FOLDER_FILE || basename(rel) === ".keep") continue;
      if (e.isDir) { if (!entries.some((x) => x.path.startsWith(e.path + "/") && !x.isDir && basename(x.path) !== ".keep")) scaffold.push(rel + "/"); }
      else scaffoldFiles.push({ type: kind, path: rel, text: await host.readText(join(root, e.path)) });
    }
    if (scaffold.length) t.scaffold = scaffold;
    // Another folder template may have named this type as its parent already.
    const before = ws.folderTypes[kind]?.children;
    if (before) t.children = [...new Set([...before, ...(t.children ?? [])])];
    ws.folderTypes[kind] = t;
    if (typeof header?.in === "string") {
      const parent = (ws.folderTypes[header.in] ??= { label: header.in.charAt(0).toUpperCase() + header.in.slice(1) });
      parent.children = [...new Set([...(parent.children ?? []), kind])];
    }
    trash.push(join(root, d));
  }
  // Files inside a folder template become templates that the type's scaffold uses.
  for (const f of scaffoldFiles) {
    const body = `${f.type}-${f.path.replace(/\//g, "-")}`;
    const key = body.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]+/g, "_");
    ws.templates[key] = { body };
    writes.set(join(root, tdir, body), f.text);
    const t = ws.folderTypes[f.type];
    t.scaffold = [...(t.scaffold ?? []), { path: f.path, template: key }];
  }

  // ---- folders' .texdesk.toml → folders entries
  const legacyFolders = files.filter((p) => basename(p) === LEGACY_FOLDER_FILE && !p.startsWith(".texdesk/"));
  for (const p of legacyFolders) {
    const rel = p.includes("/") ? dirname("/" + p).slice(1) : "";
    const raw = await tomlAt(host, join(root, p), notes, p);
    trash.push(join(root, p));
    if (!raw) continue;
    const entry: FolderEntry = {};
    if (typeof raw.kind === "string") {
      entry.type = raw.kind;
      ws.folderTypes[raw.kind] ??= { label: raw.kind.charAt(0).toUpperCase() + raw.kind.slice(1) };
    }
    if (isObj(raw.vars)) {
      const fields = Object.fromEntries(Object.entries(raw.vars).map(([k, v]) => [k, String(v)]));
      if (Object.keys(fields).length) entry.fields = fields;
    }
    if (Array.isArray(raw.order)) entry.order = raw.order.filter((x): x is string => typeof x === "string");
    if (SORT_KEYS.includes(raw.sort as SortKey)) entry.sort = raw.sort as SortKey;
    const settings: Raw = {};
    for (const k of FOLDER_SETTING_KEYS) if (raw[k] !== undefined) settings[k] = raw[k];
    if (Object.keys(settings).length) entry.settings = settings;
    for (const k of Object.keys(raw)) if (!["kind", "vars", "order", "sort", ...FOLDER_SETTING_KEYS].includes(k)) notes.push(`${p}: ${k} isn't a folder setting any more; it was left out`);
    ws.folders[rel] = entry;
  }

  // A type named by one field ({{code}}): its folders' names are that field's values.
  for (const [rel, f] of Object.entries(ws.folders)) {
    const m = f.type ? /^\{\{(\w+)\}\}$/.exec(ws.folderTypes[f.type]?.name ?? "") : null;
    if (m && rel && f.fields?.[m[1]] === undefined) f.fields = { [m[1]]: basename(rel), ...f.fields };
  }

  // Fields: every folder's values become fields of its type (if the type doesn't list them).
  for (const [key, t] of Object.entries(ws.folderTypes)) {
    const mine = Object.values(ws.folders).filter((f) => f.type === key);
    for (const f of mine) for (const k of Object.keys(f.fields ?? {})) {
      if (!(t.fields ?? []).some((x) => x.key === k)) t.fields = [...(t.fields ?? []), { key: k, label: questionFor(k) }];
    }
    // What every folder of the type agrees on moves to the type.
    if (!mine.length) continue;
    const same = <T,>(get: (f: FolderEntry) => T | undefined): T | undefined => {
      const vals = mine.map(get);
      return vals.every((v) => v !== undefined && JSON.stringify(v) === JSON.stringify(vals[0])) ? vals[0] : undefined;
    };
    const order = same((f) => f.order);
    if (order && (!t.order || JSON.stringify(t.order) === JSON.stringify(order))) { t.order = order; for (const f of mine) delete f.order; }
    const sort = same((f) => f.sort);
    if (sort && (!t.sort || t.sort === sort)) { t.sort = sort; for (const f of mine) delete f.sort; }
    for (const k of FOLDER_SETTING_KEYS) {
      const v = same((f) => f.settings?.[k]);
      const have = t.settings?.[k];
      if (v === undefined || (have !== undefined && JSON.stringify(have) !== JSON.stringify(v))) continue;
      t.settings = { ...t.settings, [k]: v };
      for (const f of mine) { delete f.settings![k]; if (!Object.keys(f.settings!).length) delete f.settings; }
    }
  }

  // ---- %% headers in templates/*.tex → templates entries; bodies lose the header
  for (const p of files) {
    if (dirname("/" + p).slice(1) !== tdir || !p.endsWith(".tex")) continue;
    const text = await host.readText(join(root, p));
    const { header, body } = splitHeader(text);
    if (header === "" && !text.startsWith("%%")) continue;
    let h: Raw = {};
    try { h = parseToml(header) as Raw; } catch (e) { notes.push(`${p}: its %% header couldn't be read (${e instanceof Error ? e.message : String(e)}), so it was left as it is`); continue; }
    writes.set(join(root, p), body);
    const file = basename(p);
    const t: TemplateDef = { body: file };
    for (const k of ["label", "in", "dir", "name"] as const) if (typeof h[k] === "string" && h[k]) t[k] = h[k] as string;
    const prompt = promptOf(h.prompt);
    if (Object.keys(prompt).length) t.prompt = prompt;
    if (t.in && !ws.folderTypes[t.in]) ws.folderTypes[t.in] = { label: t.in.charAt(0).toUpperCase() + t.in.slice(1) };
    // A header that's only comments (the old default article.tex) gives no entry; the body still works.
    if (Object.keys(t).length > 1) ws.templates[file.replace(/\.tex$/, "").replace(/[^A-Za-z0-9_]+/g, "_")] = t;
  }
  if (files.includes(`${tdir}/README.md`)) writes.set(join(root, tdir, "README.md"), TEMPLATES_README);

  // Templates folders below the root aren't used any more.
  for (const d of dirs) {
    if (d.endsWith("/.texdesk/templates") && d !== tdir) notes.push(`${d}: templates in subfolders aren't used any more — move any you need to .texdesk/templates`);
  }

  // ---- .texdesk/snippets → a workspace plugin (if it has snippets of its own)
  const snip = ".texdesk/snippets";
  if (dirs.has(snip)) {
    const own = files.filter((p) => dirname("/" + p).slice(1) === snip && p.endsWith(".ts") && !p.endsWith(".d.ts"));
    if (own.length) {
      const dest = join(root, ".texdesk", "plugins", "workspace-snippets");
      for (const p of own) moves.push({ from: join(root, p), to: join(dest, basename(p)) });
      writes.set(join(dest, MANIFEST), JSON.stringify({ name: "Workspace snippets", description: `Snippets from ${snip}`, version: "1" }, null, 2) + "\n");
    }
    trash.push(join(root, snip));
  }

  return { ws, globalSettings, writes, moves, trash, notes };
}

/** What `planMigration` found, in a sentence or two. */
export function describePlan(plan: MigrationPlan): string {
  const types = Object.values(plan.ws.folderTypes).map((t) => t.label);
  const parts = [
    types.length ? `${types.length} folder type${types.length === 1 ? "" : "s"} (${types.join(", ")})` : "",
    Object.keys(plan.ws.folders).length ? `${Object.keys(plan.ws.folders).length} folder${Object.keys(plan.ws.folders).length === 1 ? "" : "s"}` : "",
    Object.keys(plan.ws.templates).length ? `${Object.keys(plan.ws.templates).length} template${Object.keys(plan.ws.templates).length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "your settings";
}

/**
 * Writes workspace.json and the other new files, moves files, then moves the old setup files
 * to the Trash. `addGlobal` saves the personal settings the plan moves to settings.json.
 */
export async function applyMigration(host: Host, root: string, plan: MigrationPlan, addGlobal: (raw: Raw) => Promise<void>): Promise<void> {
  await host.mkdirAll(join(root, ".texdesk"));
  await host.writeText(join(root, ".texdesk", "workspace.json"), formatWorkspace(plan.ws));
  if (Object.keys(plan.globalSettings).length) await addGlobal(plan.globalSettings);
  for (const [p, text] of plan.writes) {
    await host.mkdirAll(dirname(p));
    if (await host.exists(p)) await host.writeText(p, text); else await host.createText(p, text);
  }
  for (const m of plan.moves) { await host.mkdirAll(dirname(m.to)); await host.move(m.from, m.to); }
  for (const p of plan.trash) if (await host.exists(p)) await host.trash(p);
}

/** Merges `add` into `into` (one level of tables deep), keeping what `into` already sets. */
export function mergeSettings(into: Raw, add: Raw): Raw {
  const out: Raw = { ...into };
  for (const [k, v] of Object.entries(add)) {
    if (isObj(v) && isObj(out[k])) out[k] = { ...v, ...(out[k] as Raw) };
    else if (!(k in out)) out[k] = v;
  }
  return out;
}

export interface GlobalMigration {
  /** The old config.toml's settings, for settings.json (null if there's nothing to move). */
  settings: Raw | null;
  /** Snippet files moving into the LaTeX snippets plugin. */
  moves: { from: string; to: string }[];
  manifest: string | null;
  trash: string[];
  notes: string[];
}

/** Plans moving `~/.config/texdesk/` (`dir`) to settings.json and plugins/. */
export async function planGlobalMigration(host: Host, dir: string): Promise<GlobalMigration> {
  const out: GlobalMigration = { settings: null, moves: [], manifest: null, trash: [], notes: [] };
  const toml = join(dir, "config.toml");
  if (await host.exists(toml)) {
    const raw = await tomlAt(host, toml, out.notes, "~/.config/texdesk/config.toml");
    if (raw) {
      if (isObj(raw.editor)) delete raw.editor.list_editing;
      if (isObj(raw.keys)) delete raw.keys.add_problem;
      out.settings = raw;
      out.trash.push(toml);
    }
  }
  const snippets = join(dir, "snippets");
  if (await host.exists(snippets)) {
    const own = (await host.readDir(snippets)).filter((e) => !e.isDir && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")).map((e) => e.name);
    const plugin = join(dir, "plugins", "latex-snippets");
    if (own.length && !(await host.exists(plugin))) {
      for (const n of own) out.moves.push({ from: join(snippets, n), to: join(plugin, n) });
      out.manifest = join(plugin, MANIFEST);
    }
    if (!own.length || !(await host.exists(plugin))) out.trash.push(snippets);
    else out.notes.push("~/.config/texdesk/snippets wasn't moved: there's already a latex-snippets plugin");
  }
  return out;
}

export async function applyGlobalMigration(host: Host, dir: string, m: GlobalMigration, existing: Raw): Promise<void> {
  if (m.settings) await host.writeText(join(dir, "settings.json"), JSON.stringify(mergeSettings(existing, m.settings), null, 2) + "\n");
  for (const mv of m.moves) { await host.mkdirAll(dirname(mv.to)); await host.move(mv.from, mv.to); }
  if (m.manifest) {
    const suite = m.moves.some((mv) => basename(mv.from).startsWith("imported-latex-suite"));
    const manifest = suite
      ? { name: "LaTeX Suite snippets", description: "Imported from Obsidian LaTeX Suite, plus anything else you had in ~/.config/texdesk/snippets", version: "1" }
      : { name: "LaTeX snippets", description: "Your snippets, from ~/.config/texdesk/snippets", version: "1" };
    await host.createText(m.manifest, JSON.stringify(manifest, null, 2) + "\n");
  }
  for (const p of m.trash) if (await host.exists(p)) await host.trash(p);
}
