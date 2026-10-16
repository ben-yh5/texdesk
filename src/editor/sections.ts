// Section folding: a heading (\section, \subsection, …) folds everything up to the next
// heading of the same or a higher level, or `\end{document}`. A list item (an `\item` in an
// enumerate, and so its sub-items too) folds up to the next item at its level or the list's end.
// A fold arrow sits in the gutter next to each. Mod-Alt-[ folds (or unfolds) the section the cursor is in;
// Ctrl-Alt-[ / Ctrl-Alt-] fold and unfold every section.

import { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { codeFolding, foldAll, foldGutter, foldService, toggleFold, unfoldAll } from "@codemirror/language";
import { contextAt } from "../scanner/field";

/** A line starting with `\item` (its indent, optional label and the rest). */
export const ITEM_LINE = /^(\s*)\\item\b(\[[^\]]*\])?(.*)$/;
export const BEGIN_LIST = /^\s*\\begin\{(itemize|enumerate|description)\}/;
export const END_LIST = /^\s*\\end\{(itemize|enumerate|description)\}/;

const LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const HEADING = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/;
const END_DOCUMENT = /^\s*\\end\s*\{document\}/;
/** Lines scanned for the end of a section. */
const MAX_LINES = 20000;

/** The heading level of line `n` (lower = bigger), or null if it isn't a heading in text. */
export function headingLevel(state: EditorState, n: number): number | null {
  const line = state.doc.line(n);
  const m = HEADING.exec(line.text);
  if (!m) return null;
  const at = line.from + line.text.indexOf("\\");
  return contextAt(state, at).mode === "text" ? LEVELS[m[1]] : null;
}

/** The range a heading on line `n` folds: from the end of its line to the end of its section. */
export function sectionRange(state: EditorState, n: number): { from: number; to: number } | null {
  const level = headingLevel(state, n);
  if (level === null) return null;
  const doc = state.doc;
  let last = n;
  for (let i = n + 1; i <= Math.min(doc.lines, n + MAX_LINES); i++) {
    const text = doc.line(i).text;
    if (END_DOCUMENT.test(text)) break;
    const l = HEADING.test(text) ? headingLevel(state, i) : null;
    if (l !== null && l <= level) break;
    last = i;
  }
  // Keep the blank lines before the next heading visible.
  while (last > n && TRAILING.test(doc.line(last).text)) last--;
  if (last === n) return null;
  return { from: doc.line(n).to, to: doc.line(last).to };
}

/** Lines left visible at the end of a fold: blank lines and page breaks before what's next. */
const TRAILING = /^\s*(\\(newpage|clearpage|pagebreak)\b.*)?$/;

/** The range an `\item` on line `n` of an enumerate folds: to the next item at its level or the list's end. */
export function itemRange(state: EditorState, n: number): { from: number; to: number } | null {
  const doc = state.doc;
  const line = doc.line(n);
  if (!ITEM_LINE.test(line.text)) return null;
  const ctx = contextAt(state, line.from + line.text.indexOf("\\"));
  if (ctx.mode !== "text" || ctx.envStack[ctx.envStack.length - 1] !== "enumerate") return null;
  let depth = 0, last = n;
  for (let i = n + 1; i <= Math.min(doc.lines, n + MAX_LINES); i++) {
    const text = doc.line(i).text;
    if (BEGIN_LIST.test(text)) depth++;
    else if (END_LIST.test(text)) { if (depth-- === 0) break; }
    else if (depth === 0 && ITEM_LINE.test(text)) break;
    last = i;
  }
  while (last > n && TRAILING.test(doc.line(last).text)) last--;
  if (last === n) return null;
  return { from: line.to, to: doc.line(last).to };
}

const sectionFolds = foldService.of((state, lineStart) => {
  const n = state.doc.lineAt(lineStart).number;
  return sectionRange(state, n) ?? itemRange(state, n);
});

function placeholder(view: EditorView, onclick: (e: Event) => void, prepared: unknown): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-foldPlaceholder";
  el.textContent = `⋯ ${prepared} lines`;
  el.title = "Unfold";
  el.onclick = onclick;
  return el;
}

const theme = EditorView.baseTheme({
  ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", color: "var(--td-muted)", padding: "0 3px", transition: "opacity 0.1s" },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--td-fg)" },
  ".cm-foldPlaceholder": {
    margin: "0 0.4em", padding: "0 0.5em", border: "none", borderRadius: "4px", cursor: "pointer",
    backgroundColor: "var(--td-field-bg, rgba(74, 108, 247, 0.12))", color: "var(--td-muted)", fontFamily: "var(--td-ui, system-ui)", fontSize: "0.8em",
  },
});

/** Section folding for `.tex` files. */
export const sectionFolding: Extension = [
  sectionFolds,
  codeFolding({
    preparePlaceholder: (state, range) => state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number,
    placeholderDOM: placeholder,
  }),
  foldGutter({ openText: "⌄", closedText: "›" }),
  keymap.of([
    { key: "Mod-Alt-[", run: toggleFold },
    { key: "Mod-Alt-]", run: toggleFold },
    { key: "Ctrl-Alt-[", run: foldAll },
    { key: "Ctrl-Alt-]", run: unfoldAll },
  ]),
  theme,
];
