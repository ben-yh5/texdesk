// Math preview: while the cursor is inside math, a tooltip shows it rendered with KaTeX
// (using the \newcommand / \DeclareMathOperator macros from the workspace's .sty files and the preamble).

import { Compartment, EditorState, Facet, StateField } from "@codemirror/state";
import { EditorView, Tooltip, showTooltip } from "@codemirror/view";
import katex from "katex";
import "katex/dist/katex.min.css";
import { scanField, scannerConfig } from "../scanner/field";
import { Frame, scanLine } from "../scanner/scanner";

export interface MathRegion {
  /** Content range, excluding delimiters. */
  from: number;
  to: number;
  display: boolean;
  /** Environment name for env-delimited math (`align*`), else null. */
  env: string | null;
}

const MAX_LINES = 60;

const mathFrame = (st: readonly Frame[]): Frame | undefined =>
  [...st].reverse().find((f) => f.k === "delim" || (f.k === "env" && (f.role === "display" || f.role === "inline")));

/** Steps of one line: [column, inMath, outermost math frame]. */
function steps(state: EditorState, n: number): { i: number; math: Frame | undefined }[] {
  const line = state.doc.line(n);
  const start = state.field(scanField).states[n - 1];
  const out: { i: number; math: Frame | undefined }[] = [];
  scanLine(start, line.text, -1, state.facet(scannerConfig), (i, st) => out.push({ i, math: mathFrame(st) }));
  return out;
}

/** The math region around `pos`, or null if `pos` isn't in math. */
export function mathRegionAt(state: EditorState, pos: number): MathRegion | null {
  const here = state.doc.lineAt(pos);
  const col = pos - here.from;
  let s = steps(state, here.number);
  // Position of the step at or before the cursor.
  let k = -1;
  for (let j = 0; j < s.length && s[j].i <= col; j++) k = j;
  if (k < 0 || !s[k].math) return null;
  const frame = s[k].math!;

  // Walk back to where the math starts.
  let from: number | null = null;
  let ln = here.number;
  let j = k;
  for (let guard = 0; guard < MAX_LINES; guard++) {
    for (; j >= 0; j--) {
      if (!s[j].math) {
        from = j + 1 < s.length ? state.doc.line(ln).from + s[j + 1].i : state.doc.line(ln + 1).from;
        break;
      }
    }
    if (from !== null) break;
    if (ln === 1) { from = 0; break; }
    ln--;
    s = steps(state, ln);
    j = s.length - 1;
  }
  if (from === null) return null;

  // Walk forward to where it ends: the start of the last in-math step before math ends.
  let to: number | null = null;
  ln = here.number;
  s = steps(state, ln);
  j = Math.max(0, k);
  let lastIn = state.doc.line(ln).from + s[j].i;
  for (let guard = 0; guard < MAX_LINES; guard++) {
    for (; j < s.length; j++) {
      if (!s[j].math) { to = lastIn; break; }
      lastIn = state.doc.line(ln).from + s[j].i;
    }
    if (to !== null) break;
    if (ln === state.doc.lines) { to = state.doc.length; break; }
    ln++;
    s = steps(state, ln);
    j = 0;
  }
  if (to === null || to < from) return null;

  const display = frame.k === "delim" ? frame.open === "$$" || frame.open === "\\[" : frame.k === "env" && frame.role === "display";
  return { from, to, display, env: frame.k === "env" ? frame.name : null };
}

// ---- macros ----------------------------------------------------------------------------

/** Reads a balanced `{…}` group starting at `i`; returns [content, indexAfter]. */
function group(text: string, i: number): [string, number] | null {
  while (/\s/.test(text[i] ?? "")) i++;
  if (text[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "\\") { j++; continue; }
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return [text.slice(i + 1, j), j + 1];
  }
  return null;
}

/** Macros KaTeX can use, from \newcommand / \renewcommand / \DeclareMathOperator / \def. */
export function extractMacros(text: string): Record<string, string> {
  const src = text.split("\n").map((l) => l.replace(/(^|[^\\])%.*$/, "$1")).join("\n");
  const out: Record<string, string> = {};
  const re = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator)(\*?)\s*(?:\{\s*(\\[A-Za-z]+)\s*\}|(\\[A-Za-z]+))/g;
  for (let m; (m = re.exec(src)); ) {
    const name = m[3] ?? m[4];
    let i = m.index + m[0].length;
    if (m[1] === "DeclareMathOperator") {
      const g = group(src, i);
      if (g) out[name] = `\\operatorname${m[2]}{${g[0]}}`;
      continue;
    }
    const arity = /^\s*\[(\d)\]/.exec(src.slice(i));
    if (arity) i += arity[0].length;
    if (/^\s*\[/.test(src.slice(i))) continue; // optional-argument defaults: skip
    const g = group(src, i);
    if (g) out[name] = g[0];
  }
  for (const m of src.matchAll(/\\def\s*(\\[A-Za-z]+)\s*\{/g)) {
    const g = group(src, m.index! + m[0].length - 1);
    if (g) out[m[1]] = g[0];
  }
  return out;
}

/** Macros for the preview (App provides these from the workspace .sty files the document loads + its preamble). */
export const mathMacros = Facet.define<Record<string, string>, Record<string, string>>({
  combine: (vs) => Object.assign({}, ...vs),
});

export const macrosCompartment = new Compartment();

export function setMacros(view: EditorView, macros: Record<string, string>) {
  view.dispatch({ effects: macrosCompartment.reconfigure(mathMacros.of(macros)) });
}

// ---- rendering -------------------------------------------------------------------------

const WRAP: Record<string, string> = {
  align: "aligned", "align*": "aligned", flalign: "aligned", "flalign*": "aligned", eqnarray: "aligned", "eqnarray*": "aligned",
  gather: "gathered", "gather*": "gathered", multline: "gathered", "multline*": "gathered",
};

export function previewSource(tex: string, env: string | null): string {
  let body = tex
    .split("\n").map((l) => l.replace(/(^|[^\\])%.*$/, "$1")).join("\n")
    .replace(/\\label\s*\{[^}]*\}/g, "")
    .replace(/\\(nonumber|notag)\b/g, "")
    .replace(/\\tag\*?\s*\{[^}]*\}/g, "")
    .trim();
  if (env && WRAP[env]) body = `\\begin{${WRAP[env]}}${body}\\end{${WRAP[env]}}`;
  return body;
}

export function renderMath(tex: string, display: boolean, macros: Record<string, string>): string {
  return katex.renderToString(tex, {
    displayMode: display, throwOnError: false, strict: "ignore", trust: false, macros: { ...macros }, output: "html",
  });
}

function tooltipFor(state: EditorState): Tooltip | null {
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return null;
  const r = mathRegionAt(state, sel.head);
  if (!r) return null;
  const tex = previewSource(state.sliceDoc(r.from, r.to), r.env);
  if (!tex) return null;
  const html = renderMath(tex, r.display, state.facet(mathMacros));
  return {
    pos: r.to,
    above: false,
    strictSide: false,
    arrow: false,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-math-preview";
      dom.innerHTML = html;
      return { dom };
    },
  };
}

const previewField = StateField.define<Tooltip | null>({
  create: (s) => tooltipFor(s),
  update: (value, tr) => (tr.docChanged || tr.selection ? tooltipFor(tr.state) : value),
  provide: (f) => showTooltip.from(f),
});

export const mathPreview = [
  previewField,
  EditorView.baseTheme({
    ".cm-tooltip.cm-math-preview, .cm-math-preview": {
      padding: "6px 10px",
      background: "var(--td-bg)",
      color: "var(--td-fg)",
      border: "1px solid var(--td-border)",
      borderRadius: "8px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.15)",
      maxWidth: "min(720px, 90vw)",
      overflowX: "auto",
      fontSize: "1.05em",
    },
    ".cm-math-preview .katex-display": { margin: "0.2em 0" },
  }),
];
