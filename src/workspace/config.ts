// Settings: `~/.config/texdesk/settings.json` (global: applies in every workspace), a
// workspace's `settings` in `.texdesk/workspace.json` (on top of the global ones), and the
// `settings` of folder types and folders, which can override a few keys for everything inside.
// All of them are the same JSON shape, e.g. { "editor": { "font_size": 15 }, "vars": { … } }.

import { Host, join } from "../host/types";

export type CommandId =
  | "find_file" | "find_in_files" | "command_palette" | "open_folder" | "open_file" | "toggle_sidebar" | "toggle_pdf"
  | "show_in_pdf" | "paste_as_code" | "paste_image" | "toggle_math_preview" | "follow_link" | "insert_link"
  | "settings" | "close_tab" | "split_right" | "new_file" | "bracket_size" | "fix_spelling" | "jump_out" | "folder_overview";

export const DEFAULT_KEYS: Record<CommandId, string> = {
  find_file: "Mod-k",
  find_in_files: "Mod-Shift-f",
  command_palette: "Mod-Shift-k",
  open_folder: "Mod-Shift-o",
  open_file: "Mod-o",
  toggle_sidebar: "Mod-\\",
  toggle_pdf: "Mod-Shift-p",
  show_in_pdf: "Mod-Shift-j",
  paste_as_code: "Mod-Shift-v",
  paste_image: "Mod-Shift-i",
  toggle_math_preview: "Mod-Shift-m",
  follow_link: "Mod-Alt-Enter",
  insert_link: "Mod-Shift-l",
  settings: "Mod-,",
  close_tab: "Mod-w",
  new_file: "Mod-n",
  bracket_size: "Mod-Shift-e",
  jump_out: "Mod-Enter",
  fix_spelling: "Mod-l",
  split_right: "Mod-Alt-\\",
  folder_overview: "Mod-Alt-o",
};

export interface EditorSettings {
  theme: "system" | "light" | "dark";
  fontSize: number;
  fontFamily: string;
  lineNumbers: boolean;
  /** Line numbers count from the cursor's line (which shows its own number). */
  relativeLineNumbers: boolean;
  lineWrapping: boolean;
  mathPreview: boolean;
  /** Underline misspellings in the prose as you type (the macOS spellchecker). */
  spellcheck: boolean;
  /** After each build, scroll the PDF to the line you last edited. */
  followEdits: boolean;
  /** `{` → `{}` in text, `\{` → `\{\}`; typing a closer that's there steps over it. */
  autoPairBrackets: boolean;
  /** Brackets around \frac, \sum, \int… become \left…\right when you close them. */
  autoEnlargeBrackets: boolean;
  /** Vim keybindings (normal/insert/visual modes, :w saves). */
  vim: boolean;
}

/** Documents build on every save and whenever typing pauses; these are the timings. */
export interface BuildSettings {
  /** Wait after a save before building. */
  debounceMs: number;
  /** Pause in typing before saving and building (the build starts then, with no extra debounce). */
  autoCompileDelayMs: number;
}

/** Commands that no longer exist; a keys entry for one is ignored rather than an error. */
const REMOVED_COMMANDS = new Set(["compile", "add_problem"]);
/** Commands that were renamed: old name → new. */
const RENAMED_COMMANDS: Record<string, CommandId> = { ai_fix: "fix_spelling" };

export interface WorkspaceConfig {
  /**
   * Where pasted images go and an extra search path for builds, relative to the folder whose
   * config sets it. null = a `figures` folder next to each file.
   */
  figuresDir: string | null;
  /** Template variables (vars); typed folders add their fields. */
  vars: Record<string, string>;
  /** gitignore-syntax patterns hidden from the tree, ⌘K, and watchers. */
  ignore: string[];
  /** Name of the PDF exported next to a source after a build. */
  pdfName: string;
  /** Whether to export a copy of the PDF next to the source at all. */
  exportPdf: boolean;
  /** Clicking a folder's name in the file tree: opens its overview (and expands it), or only expands it. */
  folderClick: "overview" | "expand";
  /** Explicit path to the tectonic binary (default: search PATH and common locations). */
  tectonic: string | null;
  editor: EditorSettings;
  build: BuildSettings;
  /** Command → key (CodeMirror key syntax, e.g. "Mod-Shift-b"; "" disables). */
  keys: Record<CommandId, string>;
  /** Plugin id → on/off; plugins not listed use their default (yours on, built-in off). */
  plugins: Record<string, boolean>;
}

export const DEFAULT_IGNORE = [".git", "node_modules", ".venv", "__pycache__", ".build", ".DS_Store", ".obsidian"];

export const defaultConfig: WorkspaceConfig = {
  figuresDir: null,
  vars: { author: "" },
  ignore: DEFAULT_IGNORE,
  pdfName: "{{stem}}.pdf",
  exportPdf: false,
  folderClick: "overview",
  tectonic: null,
  editor: { theme: "system", fontSize: 14.5, fontFamily: "", lineNumbers: true, relativeLineNumbers: false, lineWrapping: true, mathPreview: true, spellcheck: true, followEdits: true, autoPairBrackets: true, autoEnlargeBrackets: true, vim: false },
  build: { debounceMs: 300, autoCompileDelayMs: 500 },
  keys: DEFAULT_KEYS,
  plugins: {},
};

export type Raw = Record<string, unknown>;

/**
 * `base` with the settings in `raw` applied (bad values are reported in `errors` and skipped).
 * `addIgnore`: `ignore` adds to the list instead of replacing it (a workspace's own patterns).
 */
export function applySettings(base: WorkspaceConfig, raw: Raw, errors: string[], where: string, opts: { addIgnore?: boolean } = {}): WorkspaceConfig {
  const out = { ...base };
  const str = (k: string) => {
    const v = raw[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string") { errors.push(`${where}: ${k} must be a string`); return undefined; }
    return v;
  };
  const figures = str("figures_dir");
  if (figures !== undefined) out.figuresDir = figures || null;
  out.pdfName = str("pdf_name") ?? out.pdfName;
  const tectonic = str("tectonic");
  if (tectonic !== undefined) out.tectonic = tectonic || null; // "" = find it automatically
  if (raw.export_pdf !== undefined) {
    if (typeof raw.export_pdf === "boolean") out.exportPdf = raw.export_pdf;
    else errors.push(`${where}: export_pdf must be true or false`);
  }
  const click = str("folder_click");
  if (click !== undefined) {
    if (click === "overview" || click === "expand") out.folderClick = click;
    else errors.push(`${where}: folder_click must be "overview" or "expand"`);
  }
  if (raw.ignore !== undefined) {
    if (Array.isArray(raw.ignore) && raw.ignore.every((x) => typeof x === "string")) {
      out.ignore = opts.addIgnore ? [...new Set([...out.ignore, ...(raw.ignore as string[])])] : raw.ignore as string[];
    }
    else errors.push(`${where}: ignore must be a list of strings`);
  }

  const table = (k: string): Raw | undefined => {
    const v = raw[k];
    if (v === undefined) return undefined;
    if (typeof v !== "object" || v === null || Array.isArray(v)) { errors.push(`${where}: ${k} must be an object`); return undefined; }
    return v as Raw;
  };
  const typed = <T,>(t: Raw, k: string, type: "string" | "number" | "boolean", sec: string): T | undefined => {
    const v = t[k];
    if (v === undefined) return undefined;
    if (typeof v !== type) { errors.push(`${where}: ${sec}.${k} must be a ${type}`); return undefined; }
    return v as T;
  };

  const v = table("vars");
  if (v) {
    const vars = { ...out.vars };
    for (const [name, x] of Object.entries(v)) {
      if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") vars[name] = String(x);
      else errors.push(`${where}: vars.${name} must be a string`);
    }
    out.vars = vars;
  }

  const ed = table("editor");
  if (ed) {
    const e = { ...out.editor };
    const theme = typed<string>(ed, "theme", "string", "editor");
    if (theme !== undefined) {
      if (theme === "system" || theme === "light" || theme === "dark") e.theme = theme;
      else errors.push(`${where}: editor.theme must be "system", "light" or "dark"`);
    }
    e.fontSize = typed<number>(ed, "font_size", "number", "editor") ?? e.fontSize;
    e.fontFamily = typed<string>(ed, "font_family", "string", "editor") ?? e.fontFamily;
    e.lineNumbers = typed<boolean>(ed, "line_numbers", "boolean", "editor") ?? e.lineNumbers;
    e.relativeLineNumbers = typed<boolean>(ed, "relative_line_numbers", "boolean", "editor") ?? e.relativeLineNumbers;
    e.lineWrapping = typed<boolean>(ed, "line_wrapping", "boolean", "editor") ?? e.lineWrapping;
    e.mathPreview = typed<boolean>(ed, "math_preview", "boolean", "editor") ?? e.mathPreview;
    e.spellcheck = typed<boolean>(ed, "spellcheck", "boolean", "editor") ?? e.spellcheck;
    e.followEdits = typed<boolean>(ed, "follow_edits", "boolean", "editor") ?? e.followEdits;
    e.autoPairBrackets = typed<boolean>(ed, "auto_pair_brackets", "boolean", "editor") ?? e.autoPairBrackets;
    e.autoEnlargeBrackets = typed<boolean>(ed, "auto_enlarge_brackets", "boolean", "editor") ?? e.autoEnlargeBrackets;
    e.vim = typed<boolean>(ed, "vim", "boolean", "editor") ?? e.vim;
    out.editor = e;
  }

  const b = table("build");
  if (b) {
    out.build = {
      debounceMs: typed<number>(b, "debounce_ms", "number", "build") ?? out.build.debounceMs,
      autoCompileDelayMs: typed<number>(b, "auto_compile_delay_ms", "number", "build") ?? out.build.autoCompileDelayMs,
    };
  }

  const k = table("keys");
  if (k) {
    const keys = { ...out.keys };
    for (const [name, v] of Object.entries(k)) {
      if (REMOVED_COMMANDS.has(name)) continue;
      const id = RENAMED_COMMANDS[name] ?? name;
      if (!(id in DEFAULT_KEYS)) { errors.push(`${where}: unknown command in keys: ${name}`); continue; }
      if (typeof v !== "string") { errors.push(`${where}: keys.${name} must be a string`); continue; }
      keys[id as CommandId] = v;
    }
    out.keys = keys;
  }

  const pl = table("plugins");
  if (pl) {
    const plugins = { ...out.plugins };
    for (const [id, on] of Object.entries(pl)) {
      if (typeof on === "boolean") plugins[id] = on;
      else errors.push(`${where}: plugins.${id} must be true or false`);
    }
    out.plugins = plugins;
  }
  return out;
}

/**
 * Global settings and snippets: `~/.config/texdesk/` (not `~/.texdesk/`, which would make the
 * home folder look like a workspace).
 */
export function globalDir(home: string): string {
  return join(home, ".config", "texdesk");
}

/** The global settings file, in `dir` (from `globalDir`). */
export const GLOBAL_SETTINGS = "settings.json";

/** Reads a JSON settings object from `p` ({} if the file is missing). */
export async function readSettingsFile(host: Host, p: string, errors: string[], where: string): Promise<Raw> {
  if (!(await host.exists(p))) return {};
  try {
    const v = JSON.parse(await host.readText(p));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Raw;
    errors.push(`${where}: must be a JSON object`);
  } catch (e) {
    errors.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {};
}

/** The global `settings.json` (in `dir`, from `globalDir`) over the defaults, and the raw object. */
export async function loadGlobalConfig(host: Host, dir: string): Promise<{ config: WorkspaceConfig; raw: Raw; errors: string[] }> {
  const errors: string[] = [];
  const raw = await readSettingsFile(host, join(dir, GLOBAL_SETTINGS), errors, "~/.config/texdesk/settings.json");
  return { config: applySettings(defaultConfig, raw, errors, "~/.config/texdesk/settings.json"), raw, errors };
}

/** A workspace's `settings` (from workspace.json) over `base` (the global settings). */
export function workspaceConfig(base: WorkspaceConfig, raw: Raw, errors: string[]): WorkspaceConfig {
  return applySettings(base, raw, errors, "workspace.json settings", { addIgnore: true });
}

/** Keys a folder type's or folder's `settings` may set (everything else is workspace-wide). */
export const FOLDER_KEYS = new Set(["vars", "figures_dir", "pdf_name", "export_pdf"]);

/** `cfg` with a folder type's or folder's settings applied. Keys it can't set are reported, not applied. */
export function folderConfig(cfg: WorkspaceConfig, raw: Raw, errors: string[], where: string): WorkspaceConfig {
  const allowed: Raw = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FOLDER_KEYS.has(k)) allowed[k] = v;
    else errors.push(`${where}: ${k} can only be set for the whole workspace`);
  }
  return applySettings(cfg, allowed, errors, where);
}

/**
 * `settings` with one key set (`table` "" = the top level), or removed when `value` is
 * undefined. Empty tables are dropped. Returns a new object.
 */
export function setSettingKey(settings: Raw, table: string, key: string, value: unknown): Raw {
  const out: Raw = { ...settings };
  if (!table) {
    if (value === undefined) delete out[key]; else out[key] = value;
    return out;
  }
  const t = { ...((out[table] && typeof out[table] === "object" && !Array.isArray(out[table]) ? out[table] : {}) as Raw) };
  if (value === undefined) delete t[key]; else t[key] = value;
  if (Object.keys(t).length) out[table] = t; else delete out[table];
  return out;
}

/** Whether `settings` sets `table.key` (`table` "" = the top level). */
export function hasSettingKey(settings: Raw, table: string, key: string): boolean {
  const t = table ? settings[table] : settings;
  return !!t && typeof t === "object" && Object.hasOwn(t as Raw, key);
}

/** Writes a settings object as JSON, as people would format it. */
export const formatJson = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
