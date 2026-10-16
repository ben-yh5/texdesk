// Tab and Shift+Tab move between slots: the places you'd type next.
//
// Tab moves the cursor past the closer of the innermost enclosing group, or into the next
// argument when another `{…}` follows (`\frac{a|}{b}` → `\frac{a}{|b}`).
// In math: `}`, `)`, `]`, `\)`, `\]`, `$`, `$$`, or `\end{env}` of the math region.
// In text: only `}` (e.g. leaving `\section{…}`), so Tab doesn't jump out of
// `\end{itemize}` or `\end{document}`. No tabout in code.
//
// Shift+Tab (math only) goes back through the same stops, then to before the math.

import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { contextAt } from "../scanner/field";

const LOOKAHEAD = 8000;
const OPENERS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };

/** Where Tab moves the cursor: past the innermost closer, or into the next argument. */
export function taboutTarget(state: EditorState, pos: number): number | null {
  const t = exitTarget(state, pos);
  if (t === null) return null;
  const closedArg = state.sliceDoc(t - 1, t) === "}" && state.sliceDoc(t - 2, t - 1) !== "\\";
  return closedArg && state.sliceDoc(t, t + 1) === "{" ? t + 1 : t;
}

/** Position just after the closer the cursor should jump past, or null. */
function exitTarget(state: EditorState, pos: number): number | null {
  const { mode } = contextAt(state, pos);
  if (mode === "code") return null;
  const math = mode === "inline" || mode === "display";
  const text = state.doc.sliceString(pos, Math.min(state.doc.length, pos + LOOKAHEAD));
  const stack: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "%") { // comment: skip to end of line
      const nl = text.indexOf("\n", i);
      if (nl < 0) return null;
      i = nl;
      continue;
    }
    if (c === "\n" && !math) {
      if (text[i + 1] === "\n" || /^\n[ \t]*\n/.test(text.slice(i, i + 40))) return null; // paragraph break
      continue;
    }
    if (c === "\\") {
      const n = text[i + 1];
      if (math && (n === ")" || n === "]") && !stack.length) return pos + i + 2;
      if (n === "(" || n === "[") { stack.push(n === "(" ? "\\)" : "\\]"); i++; continue; }
      if ((n === ")" || n === "]") && stack[stack.length - 1] === "\\" + n) { stack.pop(); i++; continue; }
      const m = /^\\(begin|end)\{([^}]*)\}/.exec(text.slice(i, i + 80));
      if (m) {
        if (m[1] === "begin") stack.push("end:" + m[2]);
        else if (stack[stack.length - 1] === "end:" + m[2]) stack.pop();
        else if (math && !stack.length) return pos + i + m[0].length;
        else if (!stack.length) return null; // leaving a text environment: not a tabout target
        i += m[0].length - 1;
        continue;
      }
      i++; // skip the escaped char (\{, \}, \\, \$, …) or the first letter of a command
      continue;
    }
    if (c === "$" && math) {
      if (stack.length) continue;
      return pos + i + (text[i + 1] === "$" ? 2 : 1);
    }
    if (c in OPENERS && (math || c === "{")) { stack.push(OPENERS[c]); continue; }
    if (c === "}" || (math && (c === ")" || c === "]"))) {
      if (stack.length && stack[stack.length - 1] === c) { stack.pop(); continue; }
      if (!stack.length) return pos + i + 1;
      stack.pop(); // mismatched (e.g. a half-open interval); keep going
    }
  }
  return null;
}

const BACK_TOKEN = /\\(?:begin|end)\s*\{[^}]*\}|\\left\s*(?:\\\{|\\langle|\\l?[vV]ert|[(\[.|])|\\right\s*(?:\\\}|\\rangle|\\r?[vV]ert|[)\].|])|\\[()[\]]|\\[^a-zA-Z]|\$\$?|[{}()[\]]|%[^\n]*/g;

const isSkip = (tok: string) => tok.startsWith("%") || (tok.length === 2 && tok[0] === "\\" && !"()[]".includes(tok[1])); // comments, \{ \\ \$…
const isCloser = (tok: string) => tok === "}" || tok === ")" || tok === "]" || tok === "\\)" || tok === "\\]" || /^\\(end|right)/.test(tok);
const isOpener = (tok: string) => tok === "{" || tok === "(" || tok === "[" || tok === "\\(" || tok === "\\[" || /^\\(begin|left)/.test(tok) || tok[0] === "$";

/**
 * Whether `pos` is inside a bracket group (`{…}`, `(…)`, `[…]`, `\left…\right`, inline math)
 * within its innermost environment, e.g. in `\frac{a|}{b}` in an align* row.
 */
export function insideGroup(state: EditorState, pos: number): boolean {
  const start = Math.max(0, pos - LOOKAHEAD);
  const text = state.sliceDoc(start, pos);
  const tokens = [...text.matchAll(BACK_TOKEN)];
  // Outside math, every $ before the cursor belongs to a $…$ that's already closed.
  const { mode } = contextAt(state, pos);
  const inMath = mode === "inline" || mode === "display";
  let depth = 0;
  for (let k = tokens.length - 1; k >= 0; k--) {
    const tok = tokens[k][0];
    if (isSkip(tok) || (tok[0] === "$" && !inMath)) continue;
    if (isCloser(tok)) { depth++; continue; }
    if (!isOpener(tok) || (tok[0] === "$" && depth > 0)) continue;
    if (depth > 0) { depth--; continue; }
    return !tok.startsWith("\\begin") && tok !== "\\[" && tok !== "$$";
  }
  return false;
}

/** Start of the math region around `pos` (its `\(`, `\[`, `$` or outermost math `\begin`). */
function mathStart(state: EditorState, pos: number): number | null {
  const start = Math.max(0, pos - LOOKAHEAD);
  const text = state.sliceDoc(start, pos);
  const tokens = [...text.matchAll(BACK_TOKEN)];
  let depth = 0;
  for (let k = tokens.length - 1; k >= 0; k--) {
    const tok = tokens[k][0], at = start + tokens[k].index!;
    if (isSkip(tok)) continue;
    if (isCloser(tok)) { depth++; continue; }
    if (!isOpener(tok)) continue;
    if (tok[0] === "$" && depth > 0) continue;
    if (depth > 0) { depth--; continue; }
    if (tok === "\\(" || tok === "\\[" || tok[0] === "$") return at;
    if (tok.startsWith("\\begin") && contextAt(state, at).mode === "text") return at;
    // An enclosing { ( \left…: keep looking outward.
  }
  return null;
}

/**
 * Where Shift+Tab moves the cursor in math: back to the previous place Tab would stop
 * (into an argument, after a group, the end of the previous argument), else to before the
 * math region. Null outside math.
 */
export function tabBackTarget(state: EditorState, pos: number): number | null {
  const { mode } = contextAt(state, pos);
  if (mode !== "inline" && mode !== "display") return null;
  const from = mathStart(state, pos);
  if (from === null) return null;
  const text = state.sliceDoc(from, pos + 1);
  let best = from;
  for (const m of text.matchAll(BACK_TOKEN)) {
    const tok = m[0], at: number = from + m.index!, end = at + tok.length;
    if (isSkip(tok) || at === from) continue;
    const next = state.sliceDoc(end, end + 1), prev = state.sliceDoc(at - 1, at);
    const stops: number[] = [];
    if (tok === "{" && prev === "}") stops.push(end); // into the next argument
    if (tok === "}" && next === "{") stops.push(at); // end of the previous argument
    else if (isCloser(tok)) stops.push(end); // after a group
    for (const p of stops) if (p < pos && p > best) best = p;
  }
  return best < pos ? best : null;
}

export function tabBack(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty || view.state.selection.ranges.length > 1) return false;
  const target = tabBackTarget(view.state, sel.head);
  if (target === null) return false;
  view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true, userEvent: "select.tabout" });
  return true;
}

export function tabout(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty || view.state.selection.ranges.length > 1) return false;
  const target = taboutTarget(view.state, sel.head);
  if (target === null) return false;
  view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true, userEvent: "select.tabout" });
  return true;
}
