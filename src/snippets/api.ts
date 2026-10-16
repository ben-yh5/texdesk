// Runtime implementation of the `texdesk` module that snippet files import.

import type { KeyHandler, KeyOptions, Replacement, Snippet, SnippetOptions, SnippetResult, Context } from "./types";

export function s(trigger: string | RegExp, replacement: Replacement, options: SnippetOptions = {}): Snippet {
  if (typeof trigger === "string" ? trigger.length === 0 : !(trigger instanceof RegExp)) {
    throw new Error("s(): trigger must be a non-empty string or a RegExp");
  }
  if (typeof replacement !== "string" && typeof replacement !== "function") {
    throw new Error(`s(${String(trigger)}): replacement must be a string or a function`);
  }
  if (options.visual && typeof trigger !== "string") {
    throw new Error(`s(${String(trigger)}): visual snippets need a string trigger`);
  }
  return { kind: "snippet", trigger, replacement, options: { ...options } };
}

type Run = (ctx: Context) => SnippetResult;

export function key(keyName: string, run: Run): KeyHandler;
export function key(keyName: string, options: KeyOptions, run: Run): KeyHandler;
export function key(keyName: string, a: KeyOptions | Run, b?: Run): KeyHandler {
  const [options, run] = typeof a === "function" ? [{}, a] : [a, b];
  if (typeof keyName !== "string" || !keyName) throw new Error("key(): key name must be a non-empty string");
  if (typeof run !== "function") throw new Error(`key(${keyName}): handler must be a function`);
  return { kind: "key", key: keyName, options: { ...options }, run };
}

/** Identity helper so a snippet file's default export is typed. */
export function snippets(list: readonly Snippet[]): Snippet[] {
  return [...list];
}

/** Identity helper for a file's `keys` export. */
export function keys(list: readonly KeyHandler[]): KeyHandler[] {
  return [...list];
}

export const api = { s, key, snippets, keys };
