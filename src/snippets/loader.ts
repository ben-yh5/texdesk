// Loads `.texdesk/snippets/*.ts`: transpiles with sucrase, evaluates each file as a
// CommonJS module, and collects its `default` (snippets) and `keys` exports.
//
// Evaluation uses `new Function`, which requires 'unsafe-eval' in the webview CSP
// (see src-tauri/tauri.conf.json). The code evaluated is the user's own snippet files.

import { transform } from "sucrase";
import { api } from "./api";
import { entryFromSnippet, KeyEntry, SnippetEntry, SnippetSet } from "./engine";
import type { SnippetProblem } from "./runtime";
import type { KeyHandler, Snippet } from "./types";

export interface SourceFile {
  /** File name within the snippets folder, e.g. "greek.ts". */
  name: string;
  code: string;
}

export interface LoadResult {
  set: SnippetSet;
  errors: SnippetProblem[];
  /** Files whose exports loaded without error. */
  loaded: string[];
}

export function isSnippetFile(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".d.ts");
}

function resolve(spec: string, from: string): string {
  let name = spec.replace(/^\.\//, "");
  if (name.includes("/")) throw new Error(`cannot import "${spec}" from ${from}: only files directly in the snippets folder can be imported`);
  if (!name.endsWith(".ts")) name += ".ts";
  return name;
}

interface Module { exports: Record<string, unknown> }

export function loadSnippetFiles(files: SourceFile[]): LoadResult {
  const sources = new Map(files.filter((f) => isSnippetFile(f.name)).map((f) => [f.name, f.code]));
  const cache = new Map<string, Module>();

  const load = (name: string): Module => {
    const cached = cache.get(name);
    if (cached) return cached; // also handles import cycles (partial exports, like Node)
    const src = sources.get(name);
    if (src === undefined) throw new Error(`no snippet file named ${name}`);
    let code: string;
    try {
      code = transform(src, { transforms: ["typescript", "imports"], filePath: name }).code;
    } catch (err) {
      throw new Error(`compile error: ${err instanceof Error ? err.message : String(err)}`);
    }
    const mod: Module = { exports: {} };
    cache.set(name, mod);
    const require = (spec: string) => {
      if (spec === "texdesk") return api;
      if (spec.startsWith("./")) return load(resolve(spec, name)).exports;
      throw new Error(`cannot import "${spec}" from ${name}: snippet files may only import "texdesk" and other snippet files ("./name")`);
    };
    try {
      new Function("require", "module", "exports", `${code}\n//# sourceURL=texdesk-snippets/${name}`)(require, mod, mod.exports);
    } catch (err) {
      cache.delete(name);
      throw err;
    }
    return mod;
  };

  const snippets: SnippetEntry[] = [];
  const keys: KeyEntry[] = [];
  const errors: SnippetProblem[] = [];
  const loaded: string[] = [];
  let order = 0;

  for (const name of [...sources.keys()].sort()) {
    try {
      const { exports } = load(name);
      const def = exports.default;
      const ks = exports.keys;
      const fileSnippets: SnippetEntry[] = [];
      const fileKeys: KeyEntry[] = [];
      if (def !== undefined) {
        if (!Array.isArray(def)) throw new Error("default export must be an array of snippets: export default snippets([...])");
        def.forEach((x: Snippet, i) => {
          if (x?.kind !== "snippet") throw new Error(`default export item ${i} is not a snippet created with s(...)`);
          fileSnippets.push(entryFromSnippet(x, name, order++));
        });
      }
      if (ks !== undefined) {
        if (!Array.isArray(ks)) throw new Error("`keys` export must be an array of key(...) handlers");
        ks.forEach((x: KeyHandler, i) => {
          if (x?.kind !== "key") throw new Error(`keys item ${i} is not a handler created with key(...)`);
          fileKeys.push({ handler: x, file: name, order: order++ });
        });
      }
      snippets.push(...fileSnippets);
      keys.push(...fileKeys);
      loaded.push(name);
    } catch (err) {
      errors.push({ file: name, kind: "load", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { set: { snippets, keys }, errors, loaded };
}
