// Snippet matching and edit instantiation. Pure functions over EditorState; the
// CodeMirror wiring (input handler, keymap, history) lives in cm.ts.

import { EditorState } from "@codemirror/state";
import { getIndentUnit, indentString } from "@codemirror/language";
import { contextAt } from "../scanner/field";
import { insideGroup } from "../editor/tabout";
import { previousExpression } from "./expression";
import { parseSnippet } from "./snippet-string";
import type {
  Context, Doc, Edit, FileInfo, KeyHandler, Line, Mode, ModeOption, Range, Snippet, SnippetCommand, SnippetResult,
} from "./types";

export interface SnippetEntry {
  snippet: Snippet;
  file: string;
  order: number;
  /** Regex trigger with an end anchor, if the trigger is a RegExp. */
  re?: RegExp;
}

export interface KeyEntry {
  handler: KeyHandler;
  file: string;
  order: number;
}

export interface SnippetSet {
  snippets: SnippetEntry[];
  keys: KeyEntry[];
}

export const emptySet: SnippetSet = { snippets: [], keys: [] };

export type Outcome = "fired" | "declined" | "threw" | "not-reached";

export interface Attempt {
  label: string;
  file: string;
  outcome: Outcome;
  detail?: string;
  ms?: number;
}

/** What happened on one keystroke, for the debug view. */
export interface MatchLog {
  event: string;
  mode: Mode;
  envStack: string[];
  /** Entries that were filtered out before running, with the reason. */
  filtered: { label: string; file: string; reason: string }[];
  attempts: Attempt[];
  totalMs: number;
}

export interface Reporter {
  error(label: string, file: string, err: unknown): void;
  slow(label: string, file: string, ms: number): void;
}

export const SLOW_SNIPPET_MS = 2;

export function entryFromSnippet(snippet: Snippet, file: string, order: number): SnippetEntry {
  const t = snippet.trigger;
  if (typeof t === "string") return { snippet, file, order };
  const src = t.source;
  const anchored = /(^|[^\\])(\\\\)*\$$/.test(src) ? src : `(?:${src})$`;
  return { snippet, file, order, re: new RegExp(anchored, t.flags.replace(/[gy]/g, "")) };
}

export function labelOf(e: SnippetEntry | KeyEntry): string {
  if ("handler" in e) return e.handler.options.description ?? `key ${e.handler.key}`;
  const t = e.snippet.trigger;
  return e.snippet.options.description ?? (typeof t === "string" ? JSON.stringify(t) : String(t));
}

export function modeMatches(opt: ModeOption | undefined, mode: Mode): boolean {
  if (opt === undefined) return mode !== "code";
  const list = typeof opt === "string" ? [opt] : opt;
  return list.some((m) => m === mode || (m === "math" && (mode === "inline" || mode === "display")));
}

function makeDoc(state: EditorState): Doc {
  const d = state.doc;
  const toLine = (l: { from: number; to: number; number: number; text: string }): Line =>
    ({ from: l.from, to: l.to, number: l.number, text: l.text });
  return {
    length: d.length,
    lines: d.lines,
    slice: (from, to) => d.sliceString(from, to),
    lineAt: (pos) => toLine(d.lineAt(pos)),
    line: (n) => toLine(d.line(n)),
    toString: () => d.toString(),
  };
}

const EXPRESSION_LOOKBACK = 4000;

interface ContextArgs {
  cursor: number;
  modePos: number;
  match: RegExpMatchArray | null;
  triggerRange: Range;
  selection: string;
  file: FileInfo | null;
}

export function makeContext(state: EditorState, a: ContextArgs): Context {
  const line = state.doc.lineAt(a.cursor);
  const mc = contextAt(state, a.modePos);
  return {
    mode: mc.mode,
    envStack: mc.envStack,
    env: mc.envStack[mc.envStack.length - 1],
    before: line.text.slice(0, a.cursor - line.from),
    after: line.text.slice(a.cursor - line.from),
    doc: makeDoc(state),
    cursor: a.cursor,
    match: a.match,
    triggerRange: a.triggerRange,
    selection: a.selection,
    previousExpression() {
      const end = a.triggerRange.from;
      const start = Math.max(0, end - EXPRESSION_LOOKBACK);
      return previousExpression(state.doc.sliceString(start, end), start);
    },
    insert: (snippet) => ({ kind: "edit", from: a.cursor, to: a.cursor, snippet }),
    replace: (range, snippet) => ({ kind: "edit", from: range.from, to: range.to, snippet }),
    file: a.file,
  };
}

const isEdit = (x: unknown): x is Edit =>
  typeof x === "object" && x !== null && (x as Edit).kind === "edit";

/** Normalizes a snippet/handler result into edits, or null for "didn't fire". */
function normalize(result: SnippetResult, defaultRange: Range): Edit[] | null {
  if (result === false || result === null || result === undefined) return null;
  if (typeof result === "string") return [{ kind: "edit", ...defaultRange, snippet: result }];
  if (typeof (result as { then?: unknown }).then === "function") {
    throw new Error("snippets must be synchronous (returned a Promise)");
  }
  if (isEdit(result)) return [result];
  if (Array.isArray(result) && result.every(isEdit)) return result.length ? [...result] : null;
  throw new Error(`invalid return value: ${String(result)}`);
}

/**
 * A firing snippet consumes its trigger: unless one of its edits covers the trigger range,
 * the trigger text is deleted alongside them.
 */
function consumeTrigger(edits: Edit[], trigger: Range): Edit[] {
  if (trigger.from === trigger.to) return edits;
  for (const e of edits) {
    if (e.from <= trigger.from && e.to >= trigger.to) return edits;
    if (e.from < trigger.to && e.to > trigger.from) {
      throw new Error(`edit ${e.from}-${e.to} partially overlaps the trigger ${trigger.from}-${trigger.to}`);
    }
  }
  return [...edits, { kind: "edit", from: trigger.from, to: trigger.to, snippet: "" }];
}

export interface Expansion {
  edits: Edit[];
  log: MatchLog;
  /** The fired snippet's `command`, to run once its edits are applied. */
  command?: SnippetCommand;
}

export type TriggerKind =
  | { kind: "auto"; typedFrom: number }
  | { kind: "tab" }
  | { kind: "visual"; typed: string };

const WORD_CHAR = /[A-Za-z0-9\\]/;

/**
 * Finds and runs the snippets matching at the cursor. For "auto", `state` is the state
 * after the typed character was inserted; for "visual", the state before typing (with
 * the selection still present).
 */
export function expandSnippet(
  state: EditorState, set: SnippetSet, trigger: TriggerKind, file: FileInfo | null, rep: Reporter,
): Expansion | null {
  const t0 = performance.now();
  const sel = state.selection.main;
  const cursor = sel.head;
  const modePos = trigger.kind === "auto" ? trigger.typedFrom : trigger.kind === "visual" ? sel.from : cursor;
  const mc = contextAt(state, modePos);
  const line = state.doc.lineAt(cursor);
  const before = line.text.slice(0, cursor - line.from);
  const log: MatchLog = {
    event: trigger.kind === "auto" ? "typed" : trigger.kind === "tab" ? "Tab" : `visual "${trigger.typed}"`,
    mode: mc.mode, envStack: mc.envStack, filtered: [], attempts: [], totalMs: 0,
  };

  interface Cand { entry: SnippetEntry; match: RegExpMatchArray | null; from: number; len: number }
  const cands: Cand[] = [];

  for (const entry of set.snippets) {
    const o = entry.snippet.options;
    const kindOk =
      trigger.kind === "visual" ? !!o.visual
      : trigger.kind === "auto" ? !!o.auto && !o.visual
      : !o.auto && !o.visual;
    if (!kindOk) continue;
    const label = labelOf(entry);
    const t = entry.snippet.trigger;

    let match: RegExpMatchArray | null = null;
    let len: number;
    if (trigger.kind === "visual") {
      if (t !== trigger.typed) continue;
      len = 0;
    } else if (typeof t === "string") {
      if (!before.endsWith(t)) continue;
      len = t.length;
    } else {
      match = entry.re!.exec(before);
      if (!match || match[0].length === 0) continue;
      len = match[0].length;
    }

    if (!modeMatches(o.mode, mc.mode)) {
      log.filtered.push({ label, file: entry.file, reason: `mode is ${mc.mode}` });
      continue;
    }
    if (o.wordBoundary && trigger.kind !== "visual") {
      const prev = before[before.length - len - 1];
      if (prev !== undefined && WORD_CHAR.test(prev)) {
        log.filtered.push({ label, file: entry.file, reason: "not at a word boundary" });
        continue;
      }
    }
    cands.push({ entry, match, from: cursor - len, len });
  }

  cands.sort((a, b) =>
    (b.entry.snippet.options.priority ?? 0) - (a.entry.snippet.options.priority ?? 0) ||
    b.len - a.len ||
    a.entry.order - b.entry.order);

  let result: Edit[] | null = null;
  let command: SnippetCommand | undefined;
  for (const c of cands) {
    const label = labelOf(c.entry);
    if (result) { log.attempts.push({ label, file: c.entry.file, outcome: "not-reached" }); continue; }
    const triggerRange = trigger.kind === "visual" ? { from: sel.from, to: sel.to } : { from: c.from, to: cursor };
    const repl = c.entry.snippet.replacement;
    const s0 = performance.now();
    try {
      let r: SnippetResult;
      if (typeof repl === "string") r = repl;
      else {
        const ctx = makeContext(state, {
          cursor: trigger.kind === "visual" ? sel.from : cursor, modePos, match: c.match, triggerRange,
          selection: trigger.kind === "visual" ? state.sliceDoc(sel.from, sel.to) : "", file,
        });
        r = repl(ctx);
      }
      const ms = performance.now() - s0;
      if (ms > SLOW_SNIPPET_MS) rep.slow(label, c.entry.file, ms);
      result = normalize(r, triggerRange);
      if (result) { result = consumeTrigger(result, triggerRange); command = c.entry.snippet.options.command; }
      log.attempts.push({ label, file: c.entry.file, outcome: result ? "fired" : "declined", ms });
    } catch (err) {
      rep.error(label, c.entry.file, err);
      log.attempts.push({ label, file: c.entry.file, outcome: "threw", detail: String(err) });
    }
  }

  log.totalMs = performance.now() - t0;
  return { edits: result ?? [], log, ...(command ? { command } : {}) };
}

function envMatches(opt: KeyHandler["options"]["env"], stack: readonly string[]): boolean {
  if (opt === undefined) return true;
  if (typeof opt === "function") return opt(stack);
  const inner = stack[stack.length - 1];
  if (inner === undefined) return false;
  return typeof opt === "string" ? inner === opt : opt.test(inner);
}

/** Runs user key handlers bound to `keyName` at the cursor. */
export function runKeyHandlers(
  state: EditorState, set: SnippetSet, keyName: string, file: FileInfo | null, rep: Reporter,
): Expansion | null {
  const t0 = performance.now();
  const sel = state.selection.main;
  const mc = contextAt(state, sel.head);
  const log: MatchLog = { event: keyName, mode: mc.mode, envStack: mc.envStack, filtered: [], attempts: [], totalMs: 0 };
  const entries = set.keys
    .filter((k) => k.handler.key === keyName)
    .sort((a, b) => (b.handler.options.priority ?? 0) - (a.handler.options.priority ?? 0) || a.order - b.order);
  if (!entries.length) return null;

  let result: Edit[] | null = null;
  for (const e of entries) {
    const label = labelOf(e);
    const o = e.handler.options;
    if (result) { log.attempts.push({ label, file: e.file, outcome: "not-reached" }); continue; }
    if (!modeMatches(o.mode, mc.mode)) { log.filtered.push({ label, file: e.file, reason: `mode is ${mc.mode}` }); continue; }
    if (!envMatches(o.env, mc.envStack)) {
      log.filtered.push({ label, file: e.file, reason: `env is ${mc.envStack[mc.envStack.length - 1] ?? "(none)"}` });
      continue;
    }
    // An environment's keys act on its rows and cells, not inside a bracket in one
    // (` & ` inside \frac{…} in an align row is a LaTeX error); there Tab moves between slots.
    if (o.env !== undefined && insideGroup(state, sel.head)) {
      log.filtered.push({ label, file: e.file, reason: "inside a bracket group" });
      continue;
    }
    const range = { from: sel.from, to: sel.to };
    const s0 = performance.now();
    try {
      const ctx = makeContext(state, {
        cursor: sel.head, modePos: sel.head, match: null, triggerRange: { from: sel.head, to: sel.head },
        selection: state.sliceDoc(sel.from, sel.to), file,
      });
      const r = e.handler.run(ctx);
      const ms = performance.now() - s0;
      if (ms > SLOW_SNIPPET_MS) rep.slow(label, e.file, ms);
      result = normalize(r, range);
      log.attempts.push({ label, file: e.file, outcome: result ? "fired" : "declined", ms });
    } catch (err) {
      rep.error(label, e.file, err);
      log.attempts.push({ label, file: e.file, outcome: "threw", detail: String(err) });
    }
  }
  log.totalMs = performance.now() - t0;
  return { edits: result ?? [], log };
}

export interface AbsStop {
  index: number;
  ranges: Range[];
}

export interface Instantiated {
  changes: { from: number; to: number; insert: string }[];
  /** Tab stops in new-document coordinates, visiting order, exit last. */
  stops: AbsStop[];
}

/** Turns edits into concrete changes and tab stops (positions in the resulting document). */
export function instantiateEdits(state: EditorState, edits: Edit[]): Instantiated {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (e.from < 0 || e.to > state.doc.length || e.from > e.to) throw new Error(`edit range ${e.from}-${e.to} is out of bounds`);
    if (i > 0 && e.from < sorted[i - 1].to) throw new Error("edits overlap");
  }
  const unit = indentString(state, getIndentUnit(state));
  const changes: Instantiated["changes"] = [];
  const fields = new Map<number, Range[]>();
  let exit: Range | null = null;
  let lastEnd = 0;
  let delta = 0;

  for (const e of sorted) {
    const line = state.doc.lineAt(e.from);
    const indent = /^[ \t]*/.exec(line.text)![0];
    const p = parseSnippet(e.snippet, { indent, indentUnit: unit });
    const base = e.from + delta;
    changes.push({ from: e.from, to: e.to, insert: p.text });
    for (const stop of p.stops) {
      const abs = stop.ranges.map((r) => ({ from: base + r.from, to: base + r.to }));
      if (stop.index === 0) { if (p.hasExit && !exit) exit = abs[0]; continue; }
      const list = fields.get(stop.index) ?? [];
      list.push(...abs);
      fields.set(stop.index, list);
    }
    if (p.text || !changes.some((c) => c.insert)) lastEnd = base + p.text.length;
    delta += p.text.length - (e.to - e.from);
  }

  const stops: AbsStop[] = [...fields.keys()].sort((a, b) => a - b).map((index) => ({ index, ranges: fields.get(index)! }));
  stops.push({ index: 0, ranges: [exit ?? { from: lastEnd, to: lastEnd }] });
  return { changes, stops };
}
