// File-system access for the frontend. Implemented by the Tauri backend in the app
// and by a Vite dev-server bridge when running in a plain browser.

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface WalkEntry {
  /** Path relative to the walked root, `/`-separated. */
  path: string;
  isDir: boolean;
}

export interface CompileRequest {
  file: string;
  searchPaths: string[];
  tectonic?: string | null;
}

export interface CompileResult {
  ok: boolean;
  cancelled: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The PDF in `.build/`, if produced. */
  pdf: string | null;
  /** Set when Tectonic couldn't be started. */
  launchError: string | null;
}

/** One entry in a native menu. */
export type MenuEntry =
  | { id: string; label: string; accelerator?: string | null }
  | { label: string; submenu: MenuEntry[] }
  | "separator"
  | { native: "cut" | "copy" | "paste" | "selectAll" | "about" | "services" | "hide" | "hideOthers" | "showAll" | "quit" | "minimize" | "fullscreen" | "closeWindow" | "bringAllToFront" };

/** A top-level menu (File, Edit, …). On macOS the first one is the app menu. */
export interface MenuSection {
  label: string;
  items: MenuEntry[];
}

export interface Host {
  readonly kind: "tauri" | "dev";
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  /** Creates a new file (and missing parent folders); fails if the path already exists. */
  createText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Moves a file or folder to the system Trash. */
  trash(path: string): Promise<void>;
  /** Renames/moves a file or folder; fails if `to` exists. */
  move(from: string, to: string): Promise<void>;
  readDir(path: string): Promise<DirEntry[]>;
  mkdirAll(path: string): Promise<void>;
  /** All files and folders under `root`, minus entries matching the gitignore-syntax patterns. */
  listFiles(root: string, ignore: string[]): Promise<WalkEntry[]>;
  /** Opens a file in the system default app. */
  openExternal(path: string): Promise<void>;
  /** Watches a whole tree, minus paths matching the gitignore-syntax `ignore` patterns. Returns an unwatch function. */
  watchTree(root: string, ignore: string[], onChange: (paths: string[]) => void): Promise<() => void>;
  /** Watches a directory (non-recursive); `onChange` gets the changed paths. Returns an unwatch function. */
  watch(dir: string, onChange: (paths: string[]) => void): Promise<() => void>;
  /** The user's home folder (global settings and snippets live in `~/.config/texdesk/`). */
  homeDir(): Promise<string>;
  /** File or folder to open at startup (CLI argument or URL parameter), if any. */
  initialFile(): Promise<string | null>;
  /** Shows an open-file dialog. */
  pickFile(): Promise<string | null>;
  /** Shows a save dialog for a PDF, starting in `dir` with `name` filled in. */
  pickSavePdf(dir: string, name: string): Promise<string | null>;
  /** Shows an open-folder dialog. */
  pickFolder(): Promise<string | null>;
  setTitle(title: string): void;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
  /** Replaces the native menu bar (a no-op outside the desktop app). */
  setMenu(sections: MenuSection[], onSelect: (id: string) => void): Promise<void>;
  /** Builds a .tex file with Tectonic. A new build of the same file cancels the previous one. */
  compile(req: CompileRequest): Promise<CompileResult>;
  cancelCompile(file: string): Promise<void>;
  /** SHA-256 (hex) of a file, or null if it doesn't exist. */
  sha256(path: string): Promise<string | null>;
  copyFile(src: string, dest: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  /** Creates a new binary file; fails if it exists. */
  createBinary(path: string, data: ArrayBuffer): Promise<void>;
  /** The clipboard's image as PNG bytes, or null if it holds no image. */
  readClipboardImage(): Promise<ArrayBuffer | null>;
  /** Reads and gunzips a text file (e.g. .synctex.gz). */
  readGzipText(path: string): Promise<string>;
  /** Created/modified times (ms since the epoch) for each path; null where it can't be read. */
  fileTimes(paths: string[]): Promise<(FileTimes | null)[]>;
  /** The misspelled words among `words`, with suggestions; null if there's no spellchecker. */
  checkSpelling(words: string[]): Promise<Misspelling[] | null>;
  /**
   * Whether an Anthropic API key is saved (in the macOS Keychain); "denied" when TeXdesk wasn't
   * allowed to read it. `retry` asks the Keychain again after that.
   */
  aiKeyStatus(retry?: boolean): Promise<AiKeyStatus>;
  /** Saves the API key; "" removes it. */
  aiSetKey(key: string): Promise<void>;
  /** Sends a Claude Messages API request (the body as the API takes it) with the saved key. */
  aiMessages(body: unknown): Promise<unknown>;
}

export type AiKeyStatus = "saved" | "none" | "denied";

export interface FileTimes {
  created: number;
  modified: number;
}

export interface Misspelling {
  word: string;
  suggestions: string[];
  /** What the system would autocorrect it to, when it's confident. */
  correction?: string | null;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

export function relative(root: string, p: string): string {
  return p === root ? "" : p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}
