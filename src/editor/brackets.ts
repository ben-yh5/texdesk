// Bracket help for LaTeX:
//  - typing a closer that's already next to the cursor steps over it (when the line's
//    brackets balance); Backspace in an empty pair deletes both halves
//  - `{` pairs in text (command arguments), `\{` pairs everywhere
//  - auto-enlarge: closing a bracket in math around \frac, \sum, \int… makes it \left…\right
//  - cycle a pair's size: ( ) → \left( \right) → \big → \Big → \bigg → \Bigg → ( )
//  - \begin{…}/\end{…} names stay in sync as you edit either, and the matching \begin/\end
//    and \left/\right are highlighted

import { EditorSelection, EditorState, Facet, Prec, RangeSetBuilder, Transaction, TransactionSpec } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";
import { contextAt } from "../scanner/field";

export interface BracketOptions {
  /** `{` → `{}` in text, `\{` → `\{\}`. */
  autoPair: boolean;
  /** \left…\right around \frac, \sum… when a bracket closes in math. */
  autoEnlarge: boolean;
}

export const bracketOptions = Facet.define<BracketOptions, BracketOptions>({
  combine: (v) => v[v.length - 1] ?? { autoPair: true, autoEnlarge: true },
});

// ---- delimiters ------------------------------------------------------------------------

export type Size = "" | "\\left" | "\\big" | "\\Big" | "\\bigg" | "\\Bigg";
const SIZES: Size[] = ["", "\\left", "\\big", "\\Big", "\\bigg", "\\Bigg"];

export interface Delim {
  /** Range of the whole token, size command included (`\left(`). */
  from: number;
  to: number;
  side: "open" | "close";
  /** Bracket family: "(", "[", "{" (for \{ \}), "<" (\langle \rangle), "|" (sized bars). */
  kind: string;
  /** The delimiter itself, e.g. "(" or "\\{" or "." */
  char: string;
  size: Size;
}

const SIZED = /\\(left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr|big|Big|bigg|Bigg)\s*(\\\{|\\\}|\\langle|\\rangle|\\lvert|\\rvert|\\lVert|\\rVert|\\\||[()[\]|.])/y;
const PLAIN = /(\\\{|\\\}|\\langle|\\rangle|\(|\)|\[|\])/y;

const KIND: Record<string, [string, "open" | "close"]> = {
  "(": ["(", "open"], ")": ["(", "close"], "[": ["[", "open"], "]": ["[", "close"],
  "\\{": ["{", "open"], "\\}": ["{", "close"], "\\langle": ["<", "open"], "\\rangle": ["<", "close"],
  "\\lvert": ["|", "open"], "\\rvert": ["|", "close"], "\\lVert": ["‖", "open"], "\\rVert": ["‖", "close"],
};

function sizeOf(cmd: string): Size {
  if (cmd === "left" || cmd === "right") return "\\left";
  return ("\\" + cmd.replace(/[lr]$/, "")) as Size;
}

/** Bracket delimiters in `text` (offsets relative to `base`). `\(`, `\)`, `\[`, `\]` are math delimiters, not brackets. */
export function delimiters(text: string, base = 0): Delim[] {
  const out: Delim[] = [];
  const bars: Record<string, boolean> = {};
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "%" && text[i - 1] !== "\\") { const nl = text.indexOf("\n", i); if (nl < 0) break; i = nl; continue; }
    if (ch === "\\") {
      SIZED.lastIndex = i;
      const m = SIZED.exec(text);
      if (m) {
        const cmd = m[1];
        const d = m[2];
        const kind = KIND[d]?.[0] ?? d; // "." (\left.), "|" and "\|" are their own kinds
        // \left/\bigl… open and \right/\bigr… close; a bare \big( takes its bracket's side,
        // and bare sized bars (\big| … \big|) alternate.
        let side: "open" | "close";
        if (cmd === "left" || /^[bB]igg?l$/.test(cmd)) side = "open";
        else if (cmd === "right" || /^[bB]igg?r$/.test(cmd)) side = "close";
        else if (KIND[d]) side = KIND[d][1];
        else { side = bars[kind] ? "close" : "open"; bars[kind] = !bars[kind]; }
        out.push({ from: base + i, to: base + i + m[0].length, side, kind, char: d, size: sizeOf(cmd) });
        i += m[0].length - 1;
        continue;
      }
      PLAIN.lastIndex = i;
      const p = PLAIN.exec(text);
      if (p) {
        const [kind, side] = KIND[p[1]];
        out.push({ from: base + i, to: base + i + p[0].length, side, kind, char: p[1], size: "" });
        i += p[0].length - 1;
        continue;
      }
      i++; // skip the escaped character (\(, \), \%, \\ …)
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "[" || ch === "]") {
      const [kind, side] = KIND[ch];
      out.push({ from: base + i, to: base + i + 1, side, kind, char: ch, size: "" });
    }
  }
  return out;
}

export interface Pair { open: Delim; close: Delim }

/** Matched pairs: a \left matches the next \right at its depth (whatever the characters); others match by family. */
export function pairs(delims: Delim[]): Pair[] {
  const out: Pair[] = [];
  const stack: Delim[] = [];
  for (const d of delims) {
    if (d.side === "open") { stack.push(d); continue; }
    for (let k = stack.length - 1; k >= 0; k--) {
      const o = stack[k];
      const ok = d.size === "\\left" || o.size === "\\left" ? o.size === d.size : o.kind === d.kind;
      if (!ok) continue;
      out.push({ open: o, close: d });
      stack.length = k;
      break;
    }
  }
  return out;
}

/** How far around the cursor to look for brackets (math rarely spans more). */
const WINDOW = 3000;

function pairsAround(state: EditorState, pos: number): Pair[] {
  const from = Math.max(0, pos - WINDOW);
  const to = Math.min(state.doc.length, pos + WINDOW);
  return pairs(delimiters(state.sliceDoc(from, to), from));
}

/** The innermost pair whose inside contains `pos`. */
export function enclosingPair(state: EditorState, pos: number): Pair | null {
  let best: Pair | null = null;
  for (const p of pairsAround(state, pos)) {
    if (p.open.to <= pos && pos <= p.close.from && (!best || p.open.from > best.open.from)) best = p;
  }
  return best;
}

// ---- size cycling ------------------------------------------------------------------------

function sized(size: Size, d: Delim, side: "open" | "close"): string {
  const ch = d.char;
  if (!size) return ch === "." ? "" : ch;
  if (size === "\\left") return (side === "open" ? "\\left" : "\\right") + ch;
  // \big( needs no space; \big\{ neither.
  return size + ch;
}

/** Changes giving `p` the next size (or `size` if given). */
export function resize(p: Pair, size?: Size): { from: number; to: number; insert: string }[] {
  const next = size ?? SIZES[(SIZES.indexOf(p.open.size) + 1) % SIZES.length];
  return [
    { from: p.open.from, to: p.open.to, insert: sized(next, p.open, "open") },
    { from: p.close.from, to: p.close.to, insert: sized(next, p.close, "close") },
  ];
}

/** ⌘⇧E: cycle the size of the brackets around the cursor. */
export function cycleBracketSize(view: EditorView): boolean {
  const pos = view.state.selection.main.head;
  const p = enclosingPair(view.state, pos);
  if (!p || p.open.char === "." || p.close.char === ".") return false;
  view.dispatch({ changes: resize(p), userEvent: "input.brackets", scrollIntoView: true });
  return true;
}

// ---- auto-enlarge ---------------------------------------------------------------------

const ENLARGE = /\\(frac|dfrac|tfrac|sum|prod|coprod|int|iint|iiint|oint|bigcup|bigcap|bigoplus|bigotimes|lim|binom|dbinom)(?![A-Za-z])/;

/**
 * If a plain bracket closes right before `pos` (in math) and its contents have \frac, \sum,
 * \int… return the changes that make it \left…\right.
 */
export function enlargeBefore(state: EditorState, pos: number): { from: number; to: number; insert: string }[] | null {
  const ctx = contextAt(state, pos);
  if (ctx.mode !== "inline" && ctx.mode !== "display") return null;
  const p = pairsAround(state, pos).find((x) => x.close.to === pos);
  if (!p || p.open.size || p.close.size) return null;
  if (!ENLARGE.test(state.sliceDoc(p.open.to, p.close.from))) return null;
  return resize(p, "\\left");
}

/** Auto-enlarge the bracket just closed before the cursor, if enabled. */
export function maybeEnlarge(view: EditorView): void {
  if (!view.state.facet(bracketOptions).autoEnlarge) return;
  const pos = view.state.selection.main.head;
  const changes = enlargeBefore(view.state, pos);
  if (!changes) return;
  const cs = view.state.changes(changes);
  view.dispatch({ changes: cs, selection: EditorSelection.cursor(cs.mapPos(pos, 1)), userEvent: "input.brackets" });
}

// ---- typing: step over closers, pair { and \{ -------------------------------------------

const CLOSERS = new Set([")", "]", "}"]);
const OPEN_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Whether the current line's `open`/`close` characters balance (escaped ones and \( \) don't count). */
function lineBalanced(text: string, close: string): boolean {
  const open = OPEN_OF[close];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "%") break;
    if (c === open) depth++;
    else if (c === close) depth--;
  }
  return depth === 0;
}

const inputHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.composing || from !== to || view.state.selection.ranges.length > 1) return false;
  const state = view.state;
  const mode = contextAt(state, from).mode;
  if (mode === "code") return false;
  const next = state.sliceDoc(from, from + 1);
  const opts = state.facet(bracketOptions);

  // Step over a closer that's already there.
  if (CLOSERS.has(text) && next === text) {
    const line = state.doc.lineAt(from);
    if (lineBalanced(line.text, text)) {
      view.dispatch({ selection: EditorSelection.cursor(from + 1), userEvent: "input.type", scrollIntoView: true });
      if (text !== "}") maybeEnlarge(view);
      return true;
    }
  }
  if (text !== "{" || !opts.autoPair) return false;

  // `{`: after a backslash it's \{ → \{\}; in text, pair it when nothing word-like follows.
  const before = state.sliceDoc(Math.max(0, from - 1), from);
  const escaped = before === "\\" && !/(^|[^\\])(\\\\)+$/.test(state.sliceDoc(Math.max(0, from - 40), from));
  if (escaped) {
    view.dispatch({ changes: { from, insert: "{\\}" }, selection: EditorSelection.cursor(from + 1), userEvent: "input.type", scrollIntoView: true });
    return true;
  }
  if (mode === "text" && (next === "" || /[\s)\]}.,;:]/.test(next))) {
    view.dispatch({ changes: { from, insert: "{}" }, selection: EditorSelection.cursor(from + 1), userEvent: "input.type", scrollIntoView: true });
    return true;
  }
  return false;
});

/** Backspace inside an empty pair deletes both halves: (|) [|] {|} \{|\} \left(|\right) \big(|\big) */
export function deletePair(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const pos = sel.head;
  const p = pairsAround(state, pos).find((x) => x.open.to === pos && x.close.from === pos);
  if (p) {
    view.dispatch({ changes: { from: p.open.from, to: p.close.to }, userEvent: "delete.backward", scrollIntoView: true });
    return true;
  }
  const around = state.sliceDoc(pos - 1, pos + 1);
  if (around === "{}" && state.sliceDoc(pos - 2, pos - 1) !== "\\") {
    view.dispatch({ changes: { from: pos - 1, to: pos + 1 }, userEvent: "delete.backward", scrollIntoView: true });
    return true;
  }
  return false;
}

// ---- \begin / \end ------------------------------------------------------------------------

interface EnvToken { kind: "begin" | "end"; from: number; to: number; nameFrom: number; nameTo: number; name: string }

const ENV_TOKEN = /\\(begin|end)\s*\{([^{}\n]*)\}/g;

function envTokens(text: string): EnvToken[] {
  const out: EnvToken[] = [];
  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    let code = line;
    for (let i = 0; i < line.length; i++) { if (line[i] === "\\") { i++; continue; } if (line[i] === "%") { code = line.slice(0, i); break; } }
    for (const m of code.matchAll(ENV_TOKEN)) {
      const nameFrom = offset + m.index! + m[0].indexOf("{") + 1;
      out.push({ kind: m[1] as "begin" | "end", from: offset + m.index!, to: offset + m.index! + m[0].length, nameFrom, nameTo: nameFrom + m[2].length, name: m[2] });
    }
    offset += line.length + 1;
  }
  return out;
}

/** The \begin/\end partner of token `i` (by nesting, ignoring names — they may be mid-edit). */
function partner(tokens: EnvToken[], i: number): number | null {
  const t = tokens[i];
  let depth = 0;
  if (t.kind === "begin") {
    for (let k = i + 1; k < tokens.length; k++) {
      if (tokens[k].kind === "begin") depth++;
      else if (depth-- === 0) return k;
    }
  } else {
    for (let k = i - 1; k >= 0; k--) {
      if (tokens[k].kind === "end") depth++;
      else if (depth-- === 0) return k;
    }
  }
  return null;
}

/**
 * For a cursor in a `\begin{…}` name: its own `\end{…}` (next at its nesting level, with the
 * same name so far), if there is one. A different name means that \end closes an outer
 * environment (\end{document}) and this \begin has none yet.
 */
export function matchingEnd(state: EditorState, pos: number): { nameFrom: number; nameTo: number } | null {
  const tokens = envTokens(state.doc.toString());
  const i = tokens.findIndex((t) => t.kind === "begin" && t.nameFrom <= pos && pos <= t.nameTo);
  const j = i >= 0 ? partner(tokens, i) : null;
  if (j === null || tokens[j].name !== tokens[i].name) return null;
  return { nameFrom: tokens[j].nameFrom, nameTo: tokens[j].nameTo };
}

/** Editing the name in \begin{…} or \end{…} renames its partner too, in the same transaction. */
const envSync = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete")) || tr.annotation(Transaction.remote)) return tr;
  if (tr.isUserEvent("input.complete")) return tr; // completions write both ends themselves
  let edited: { from: number; to: number } | null = null;
  let count = 0;
  tr.changes.iterChangedRanges((fromA, toA) => { edited = { from: fromA, to: toA }; count++; });
  if (count !== 1 || !edited) return tr;
  const e = edited as { from: number; to: number };
  const startLine = tr.startState.doc.lineAt(e.from);
  if (e.to > startLine.to) return tr; // single-line edits only
  const before = envTokens(tr.startState.doc.toString());
  const i = before.findIndex((t) => t.nameFrom <= e.from && e.to <= t.nameTo);
  if (i < 0) return tr;
  const j = partner(before, i);
  if (j === null || before[j].name !== before[i].name) return tr; // only keep matching pairs matching
  // The edited token's new name, read from the new document.
  const newFrom = tr.changes.mapPos(before[i].nameFrom, -1);
  const newLine = tr.newDoc.lineAt(newFrom);
  const rest = tr.newDoc.sliceString(newFrom, newLine.to);
  const close = rest.indexOf("}");
  if (close < 0) return tr;
  const name = rest.slice(0, close);
  if (/[{}\s]/.test(name) || name === before[i].name) return tr;
  const p = before[j];
  return [tr, {
    changes: { from: tr.changes.mapPos(p.nameFrom, -1), to: tr.changes.mapPos(p.nameTo, 1), insert: name },
    sequential: true,
  } as TransactionSpec];
});

// ---- highlighting the matching \begin/\end and \left/\right --------------------------------

/** A `)` or `]` typed in math (after snippets had their go at it) may close a bracket worth enlarging. */
const enlargeAfterTyping = EditorView.updateListener.of((u) => {
  if (!u.docChanged || !u.transactions.some((t) => t.isUserEvent("input.type"))) return;
  if (!u.state.facet(bracketOptions).autoEnlarge) return;
  const pos = u.state.selection.main.head;
  const ch = u.state.sliceDoc(pos - 1, pos);
  if (ch !== ")" && ch !== "]") return;
  queueMicrotask(() => { if (u.view.state.selection.main.head === pos) maybeEnlarge(u.view); });
});

const matchMark = Decoration.mark({ class: "cm-matchingEnv" });

function matchDecorations(state: EditorState): DecorationSet {
  const pos = state.selection.main.head;
  const marks: { from: number; to: number }[] = [];
  // \begin/\end: only scan near the cursor's line.
  const line = state.doc.lineAt(pos);
  if (/\\(begin|end)\b/.test(line.text)) {
    const tokens = envTokens(state.doc.toString());
    const i = tokens.findIndex((t) => t.from <= pos && pos <= t.to);
    const j = i >= 0 ? partner(tokens, i) : null;
    if (j !== null) marks.push(tokens[i], tokens[j]);
  }
  if (!marks.length && /\\(left|right|[bB]igg?[lr]?)/.test(line.text)) {
    const p = pairsAround(state, pos).find((x) => (x.open.size || x.close.size) && ((x.open.from <= pos && pos <= x.open.to) || (x.close.from <= pos && pos <= x.close.to)));
    if (p) marks.push(p.open, p.close);
  }
  const b = new RangeSetBuilder<Decoration>();
  for (const m of marks.sort((a, c) => a.from - c.from)) b.add(m.from, m.to, matchMark);
  return b.finish();
}

const matching = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = matchDecorations(view.state); }
    update(u: ViewUpdate) { if (u.docChanged || u.selectionSet) this.decorations = matchDecorations(u.state); }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.baseTheme({
  ".cm-matchingEnv": { backgroundColor: "var(--td-match)", borderRadius: "2px" },
});

/** Everything above; goes before the snippet extension so step-over/pairing see keys first. */
export function brackets(opts: BracketOptions) {
  return [
    bracketOptions.of(opts),
    Prec.high(inputHandler),
    Prec.high(keymap.of([{ key: "Backspace", run: deletePair }])),
    envSync,
    enlargeAfterTyping,
    matching,
    theme,
  ];
}
