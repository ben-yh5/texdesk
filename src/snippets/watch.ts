// Loads snippet folders (one per enabled plugin) into a runtime and reloads them on change.

import { Host, basename, join } from "../host/types";
import { SourceFile, isSnippetFile, loadSnippetFiles } from "./loader";
import type { SnippetRuntime } from "./runtime";
import type { SnippetSet } from "./engine";

const DEBOUNCE_MS = 80;

export interface SnippetFolder {
  /** Folder on disk; null for files that ship with the app (`files`). */
  dir: string | null;
  /** Put before file names in errors and the debug view ("" for none), e.g. "latex-snippets/". */
  prefix: string;
  /** The files themselves, for a folder that isn't on disk (a built-in plugin). */
  files?: SourceFile[];
}

/**
 * Loads every folder, highest priority first: on a tie, a snippet from an earlier folder wins.
 * Each folder is loaded on its own, so its files can only import each other.
 */
export async function reloadSnippets(host: Host, folders: SnippetFolder[], rt: SnippetRuntime): Promise<void> {
  const set: SnippetSet = { snippets: [], keys: [] };
  const errors: SnippetRuntime["loadErrors"] = [];
  let count = 0;
  let offset = 0;
  for (const { dir, prefix, files: given } of folders) {
    let files = given;
    if (!files) {
      if (!dir || !(await host.exists(dir))) continue;
      const names = (await host.readDir(dir)).filter((e) => !e.isDir && isSnippetFile(e.name)).map((e) => e.name);
      files = await Promise.all(names.map(async (name) => ({ name, code: await host.readText(join(dir, name)) })));
    }
    const result = loadSnippetFiles(files);
    const n = result.set.snippets.length + result.set.keys.length;
    set.snippets.push(...result.set.snippets.map((e) => ({ ...e, file: prefix + e.file, order: e.order + offset })));
    set.keys.push(...result.set.keys.map((e) => ({ ...e, file: prefix + e.file, order: e.order + offset })));
    errors.push(...result.errors.map((e) => ({ ...e, file: prefix + e.file })));
    count += result.loaded.length;
    offset += n;
  }
  rt.replace(set, errors, count);
}

export async function watchSnippets(host: Host, folders: SnippetFolder[], rt: SnippetRuntime): Promise<() => void> {
  await reloadSnippets(host, folders, rt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onChange = (paths: string[]) => {
    if (!paths.some((p) => isSnippetFile(basename(p)))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      reloadSnippets(host, folders, rt).catch((err) =>
        rt.replace(rt.set, [{ file: "(snippets folder)", kind: "load", message: String(err) }], rt.fileCount));
    }, DEBOUNCE_MS);
  };
  const unwatch: (() => void)[] = [];
  for (const { dir } of folders) if (dir && (await host.exists(dir))) unwatch.push(await host.watch(dir, onChange));
  return () => { clearTimeout(timer); for (const u of unwatch) u(); };
}
