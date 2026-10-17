// Jump out (Mod-Enter by default): leave the block the cursor is in (a list, align*, \[…\],
// a code block…) onto a new line right after its `\end`. Pressing it again leaves the next
// block out. Small moves between brackets and arguments are Tab / Shift+Tab (tabout.ts).
// While the editor has focus, a ghost caret marks where Tab would land and ↵ where jump
// out would.
//
// Holding ⌥ for numbered jumps (which include leaving these blocks) is in targets.ts.

import { EditorSelection, EditorState, Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { contextAt } from "../scanner/field";
import { taboutTarget } from "./tabout";
import { nextFieldPos } from "../snippets/fields";

/** How far around the cursor to look for the enclosing scope. */
const WINDOW = 100_000;
const OPENERS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };

export interface Scope {
  /** Start of the opener (`{`, `\begin{…}`, …), or the cursor if it couldn't be found. */
  from: number;
  /** Start and end of the closer. The jump lands at `to` (or on the line after, for blocks). */
  closerFrom: number;
  to: number;
  /** An environment or display math: leaving it goes to a new line. */
  block: boolean;
}

const escaped = (t: string, i: number) => {
  let n = 0;
  while (i - 1 - n >= 0 && t[i - 1 - n] === "\\") n++;
  return n % 2 === 1;
};

/** `text` with comments blanked out (same length, so offsets still line up). */
function stripComments(text: string): string {
  return text.replace(/(^|[^\\](?:\\\\)*)%[^\n]*/g, (m, pre: string) => pre + " ".repeat(m.length - pre.length));
}

type Closer = { kind: string; at: number; len: number };

/** The first closer after `pos` that isn't matched by an opener after `pos`. */
function findCloser(t: string, math: boolean): Closer | null {
  const stack: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\") {
      const n = t[i + 1];
      if (math && (n === ")" || n === "]") && !stack.length) return { kind: "\\" + n, at: i, len: 2 };
      if (n === "(" || n === "[") { stack.push(n === "(" ? "\\)" : "\\]"); i++; continue; }
      if ((n === ")" || n === "]") && stack[stack.length - 1] === "\\" + n) { stack.pop(); i++; continue; }
      const m = /^\\(begin|end)\s*\{([^}]*)\}/.exec(t.slice(i, i + 80));
      if (m) {
        const key = "end:" + m[2];
        if (m[1] === "begin") stack.push(key);
        else if (stack[stack.length - 1] === key) stack.pop();
        else if (!stack.length) return m[2] === "document" ? null : { kind: key, at: i, len: m[0].length };
        else return null; // unbalanced in between: don't guess
        i += m[0].length - 1;
        continue;
      }
      i++; // an escaped char (\{, \$, \\) or the first letter of a command
      continue;
    }
    if (c === "$" && math) {
      if (stack.length) continue;
      return t[i + 1] === "$" ? { kind: "$$", at: i, len: 2 } : { kind: "$", at: i, len: 1 };
    }
    if (c in OPENERS && (math || c === "{")) { stack.push(OPENERS[c]); continue; }
    if (c === "}" || (math && (c === ")" || c === "]"))) {
      if (stack.length && stack[stack.length - 1] === c) { stack.pop(); continue; }
      if (!stack.length) return { kind: c, at: i, len: 1 };
      stack.pop(); // mismatched (e.g. a half-open interval); keep going
    }
  }
  return null;
}

/** Index in `t` (text before the cursor) of the opener matching `kind`, or -1. */
function findOpener(t: string, kind: string): number {
  if (kind.startsWith("end:")) {
    const name = kind.slice(4).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\\\(begin|end)\\s*\\{${name}\\}`, "g");
    const hits = [...t.matchAll(re)];
    let depth = 0;
    for (let k = hits.length - 1; k >= 0; k--) {
      if (hits[k][1] === "end") depth++;
      else if (depth-- === 0) return hits[k].index!;
    }
    return -1;
  }
  if (kind === "\\)" || kind === "\\]" || kind === "$" || kind === "$$") {
    const open = kind === "\\)" ? "\\(" : kind === "\\]" ? "\\[" : kind;
    for (let i = t.lastIndexOf(open); i >= 0; i = i ? t.lastIndexOf(open, i - 1) : -1) {
      if (!escaped(t, i)) return i;
    }
    return -1;
  }
  const open = kind === "}" ? "{" : kind === ")" ? "(" : "[";
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if ((t[i] !== open && t[i] !== kind) || escaped(t, i)) continue;
    if (t[i] === kind) depth++;
    else if (depth-- === 0) return i;
  }
  return -1;
}

/** The innermost scope the cursor at `pos` would jump out of, or null. */
export function scopeAt(state: EditorState, pos: number): Scope | null {
  const ctx = contextAt(state, pos);
  const start = Math.max(0, pos - WINDOW);
  const before = stripComments(state.doc.sliceString(start, pos));
  const after = state.doc.sliceString(pos, Math.min(state.doc.length, pos + WINDOW));

  let closer: Closer | null;
  if (ctx.mode === "code") {
    // Inside a code block only its `\end{…}` counts; nothing inside \verb|…|.
    const top = ctx.state[ctx.state.length - 1];
    if (top?.k !== "env") return null;
    const m = new RegExp(`\\\\end\\s*\\{${top.name.replace(/\*/g, "\\*")}\\}`).exec(after);
    closer = m ? { kind: "end:" + top.name, at: m.index, len: m[0].length } : null;
  } else {
    closer = findCloser(stripComments(after), ctx.mode !== "text");
  }
  if (!closer) return null;
  const open = findOpener(before, closer.kind);
  return {
    from: open < 0 ? pos : start + open,
    closerFrom: pos + closer.at,
    to: pos + closer.at + closer.len,
    block: closer.kind.startsWith("end:") || closer.kind === "\\]" || closer.kind === "$$",
  };
}

/** The innermost block (environment or display math) around `pos`, skipping brace and bracket groups. */
export function blockScopeAt(state: EditorState, pos: number): Scope | null {
  let s = scopeAt(state, pos);
  for (let i = 0; s && !s.block && i < 200; i++) s = scopeAt(state, s.to);
  return s?.block ? s : null;
}

/** Text after a block's closer on its line, unless it's only whitespace or a comment. */
function textAfter(state: EditorState, s: Scope): string {
  const line = state.doc.lineAt(s.to);
  const rest = line.text.slice(s.to - line.from);
  return /^\s*(%.*)?$/.test(rest) ? "" : rest;
}

/** The blocks around `pos`, innermost first (at most `max`). */
export function blockLevels(state: EditorState, pos: number, max = 9): Scope[] {
  const out: Scope[] = [];
  for (let s = blockScopeAt(state, pos); s && out.length < max; s = blockScopeAt(state, s.to)) out.push(s);
  return out;
}

export function jumpOut(view: EditorView): boolean {
  return jumpOutLevel(view, 1);
}

/** Jumps onto a new line after the `level`th block out (1 = innermost). */
export function jumpOutLevel(view: EditorView, level: number): boolean {
  const state = view.state;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const s = blockLevels(state, sel.head, level)[level - 1];
  return s ? leaveBlock(view, s) : false;
}

/** Jumps onto a new line after block `s` (one of the blocks around the cursor). */
export function leaveBlock(view: EditorView, s: Scope): boolean {
  const state = view.state;
  const sel = state.selection.main;
  // Always a new line right after the `\end`, indented like it.
  const end = state.doc.lineAt(s.to);
  const indent = /^\s*/.exec(end.text)![0];
  const after = textAfter(state, s);
  const changes: { from: number; to?: number; insert?: string }[] = [];
  // Climbing out twice: drop the blank line the first jump left right before this `\end`.
  const here = state.doc.lineAt(sel.head);
  if (!here.text.trim() && here.number === end.number - 1) changes.push({ from: here.from, to: here.to + 1 });
  let target: number;
  if (after) {
    // Text follows the `\end` on its line: break the line there, cursor before that text.
    const ws = /^\s*/.exec(after)![0].length;
    changes.push({ from: s.to, to: s.to + ws, insert: "\n" + indent });
    target = s.to + ws;
  } else {
    changes.push({ from: end.to, insert: "\n" + indent });
    target = end.to;
  }
  const set = state.changes(changes);
  view.dispatch({ changes: set, selection: EditorSelection.cursor(set.mapPos(target, 1)), scrollIntoView: true, userEvent: "input.jumpout" });
  return true;
}

// ---- the markers ------------------------------------------------------------------------

class GlyphWidget extends WidgetType {
  constructor(readonly cls: string, readonly text: string) { super(); }
  eq(o: GlyphWidget) { return o.cls === this.cls; }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() { return true; }
}

const tabGhost = Decoration.widget({ widget: new GlyphWidget("cm-tab-ghost", ""), side: 1 });
const landing = Decoration.widget({ widget: new GlyphWidget("cm-jumpout-landing", "↵"), side: 1 });
const EMPTY_ITEM = /^\s*\\item(\[[^\]]*\])?\s*$/;

/** Where Tab would put the cursor: the next snippet field, else the next slot. */
export function tabLanding(state: EditorState, pos: number): number | null {
  const field = nextFieldPos(state);
  if (field !== null) return field;
  if (EMPTY_ITEM.test(state.doc.lineAt(pos).text)) return null; // Tab nests the list there
  return taboutTarget(state, pos);
}

function decorate(view: EditorView): DecorationSet {
  const state = view.state;
  const sel = state.selection.main;
  if (!view.hasFocus || !sel.empty || state.selection.ranges.length > 1) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  const tab = tabLanding(state, sel.head);
  if (tab !== null && tab !== sel.head) decos.push(tabGhost.range(tab));
  const block = blockScopeAt(state, sel.head);
  if (block) decos.push(landing.range(state.doc.lineAt(block.to).to));
  return Decoration.set(decos, true);
}

const markerPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(readonly view: EditorView) { this.decorations = decorate(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.focusChanged || u.viewportChanged) this.decorations = decorate(u.view);
  }
}, { decorations: (p) => p.decorations });

const markerTheme = EditorView.baseTheme({
  // A zero-width ghost caret, so marking the spot never shifts the text.
  ".cm-tab-ghost": { position: "relative", display: "inline-block", width: "0", height: "1.15em", verticalAlign: "text-bottom", pointerEvents: "none" },
  ".cm-tab-ghost::after": {
    content: '""', position: "absolute", left: "-1px", top: "0", bottom: "0", width: "2px", borderRadius: "1px",
    backgroundColor: "var(--td-accent, #4a6cf7)", opacity: "0.55",
  },
  ".cm-jumpout-landing": { color: "var(--td-accent, #4a6cf7)", opacity: "0.6", marginLeft: "0.4em", pointerEvents: "none", userSelect: "none" },
});

/** Shows where Tab and jump out would land. */
export const jumpOutMarker = [markerPlugin, markerTheme];
