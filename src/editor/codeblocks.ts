// Code blocks inside LaTeX: the LaTeX highlighter skips their bodies, and the body is
// highlighted with the block's own language (`\begin{lstlisting}[language=Python]`,
// `\begin{minted}{python}`). Also: code-mode editing helpers and Paste as code.

import { EditorSelection, EditorState, Extension, Range, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Language, LanguageDescription, StreamLanguage, StreamParser, StringStream } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { isolateHistory } from "@codemirror/commands";
import { contextAt } from "../scanner/field";

export const CODE_ENVS = ["lstlisting", "verbatim", "Verbatim", "minted"];

// ---- LaTeX highlighting that leaves code blocks alone --------------------------------

interface WrapState {
  inner: unknown;
  /** Name of the code environment we're inside, if any. */
  code: string | null;
  /** In the optional `[…]` / `{lang}` arguments right after `\begin{…}`. */
  args: boolean;
}

const BEGIN_CODE = new RegExp(`^\\\\begin\\{(${CODE_ENVS.join("|")})\\}`);

function texWithCodeBlocks(base: StreamParser<unknown>): StreamParser<WrapState> {
  return {
    name: "stex",
    startState: (u) => ({ inner: base.startState!(u), code: null, args: false }),
    copyState: (s) => ({ inner: base.copyState ? base.copyState(s.inner) : s.inner, code: s.code, args: s.args }),
    token(stream: StringStream, s: WrapState) {
      if (s.code) {
        if (s.args && stream.sol()) s.args = false;
        if (s.args) {
          if (stream.match(/^\s*(\[[^\]]*\]|\{[^}]*\})/)) return "attributeValue";
          s.args = false;
        }
        const end = `\\end{${s.code}}`;
        if (stream.match(end)) { s.code = null; return "keyword"; }
        const at = stream.string.indexOf(end, stream.pos);
        if (at < 0) stream.skipToEnd(); else stream.pos = Math.max(at, stream.pos + 1);
        return null;
      }
      const m = stream.match(BEGIN_CODE) as RegExpMatchArray | null;
      if (m) { s.code = m[1]; s.args = true; return "keyword"; }
      return base.token(stream, s.inner);
    },
    blankLine: (s, indent) => { if (!s.code) base.blankLine?.(s.inner, indent); },
    languageData: base.languageData,
  };
}

export const latexLanguage = StreamLanguage.define(texWithCodeBlocks(stex as StreamParser<unknown>));

// ---- finding blocks ------------------------------------------------------------------

export interface CodeBlock {
  /** Start/end of the body (between the `\begin{…}[…]` line and `\end{…}`). */
  from: number;
  to: number;
  /** Language name as written (listings or minted), or null. */
  lang: string | null;
}

const BLOCK_RE = new RegExp(`\\\\begin\\{(${CODE_ENVS.join("|")})\\}((?:\\[[^\\]\\n]*\\])?(?:\\{[^}\\n]*\\})?)`, "g");

export function findCodeBlocks(text: string): CodeBlock[] {
  const out: CodeBlock[] = [];
  BLOCK_RE.lastIndex = 0;
  for (let m; (m = BLOCK_RE.exec(text)); ) {
    const env = m[1];
    const args = m[2];
    let lang: string | null = null;
    if (env === "minted") lang = /\{([^}]*)\}/.exec(args)?.[1] ?? null;
    else lang = /language\s*=\s*(\{[^}]*\}|[^,\]\s]+)/.exec(args)?.[1].replace(/[{}]/g, "") ?? null;
    let from = m.index + m[0].length;
    if (text[from] === "\n") from++;
    const endTok = `\\end{${env}}`;
    const end = text.indexOf(endTok, from);
    const to = end < 0 ? text.length : end;
    out.push({ from, to, lang });
    BLOCK_RE.lastIndex = end < 0 ? text.length : end + endTok.length;
  }
  return out;
}

/** Listings/minted language name → CodeMirror language description. */
export function describeLanguage(name: string): LanguageDescription | null {
  const clean = name.replace(/^\[[^\]]*\]/, "").trim();
  const alias: Record<string, string> = { "c++": "C++", bash: "Shell", sh: "Shell", matlab: "Octave", tex: "LaTeX" };
  const n = alias[clean.toLowerCase()] ?? clean;
  return LanguageDescription.matchLanguageName(languages, n, true);
}

// ---- highlighting block bodies -------------------------------------------------------

const codeHighlighter = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], class: "cm-ck" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "cm-cs" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "cm-cn" },
  { tag: [t.comment, t.lineComment, t.blockComment], class: "cm-cc" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], class: "cm-cf" },
  { tag: [t.typeName, t.className, t.namespace], class: "cm-ct" },
  { tag: [t.propertyName, t.attributeName], class: "cm-cp" },
]);

const loaded = new Map<string, Language | null>();
const languageLoaded = StateEffect.define<null>();
const blockLine = Decoration.line({ class: "cm-codeblock" });

function buildDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const blocks = findCodeBlocks(state.doc.toString());
  const lines = new RangeSetBuilder<Decoration>();
  const marks: Range<Decoration>[] = [];
  for (const b of blocks) {
    if (b.to <= b.from) continue;
    for (let pos = b.from; pos < b.to; ) {
      const line = state.doc.lineAt(pos);
      lines.add(line.from, line.from, blockLine);
      pos = line.to + 1;
    }
    if (!b.lang) continue;
    const desc = describeLanguage(b.lang);
    if (!desc) continue;
    const lang = loaded.get(desc.name);
    if (lang === undefined) {
      loaded.set(desc.name, null);
      desc.load().then(
        (support) => { loaded.set(desc.name, support.language); view.dispatch({ effects: languageLoaded.of(null) }); },
        () => {},
      );
      continue;
    }
    if (!lang) continue;
    const body = state.doc.sliceString(b.from, b.to);
    const tree = lang.parser.parse(body);
    highlightTree(tree, codeHighlighter, (from, to, cls) => {
      marks.push(Decoration.mark({ class: cls }).range(b.from + from, b.from + to));
    });
  }
  return Decoration.set([...marks, ...rangesOf(lines.finish())], true);
}

function rangesOf(set: DecorationSet): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  for (const it = set.iter(); it.value; it.next()) out.push(it.value.range(it.from, it.to));
  return out;
}

const codeHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildDecorations(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(languageLoaded)))) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const codeTheme = EditorView.baseTheme({
  ".cm-codeblock": { backgroundColor: "var(--td-code-bg, rgba(127,127,127,0.06))" },
  ".cm-ck": { color: "var(--td-hl-keyword)" },
  ".cm-cs": { color: "var(--td-hl-string)" },
  ".cm-cn": { color: "var(--td-hl-bracket)" },
  ".cm-cc": { color: "var(--td-hl-comment)", fontStyle: "italic" },
  ".cm-cf": { color: "var(--td-hl-variable)" },
  ".cm-ct": { color: "var(--td-hl-variable)", fontStyle: "italic" },
  ".cm-cp": { color: "var(--td-fg)" },
});

export const codeBlocks: Extension = [codeHighlight, codeTheme];

// ---- code-mode editing ---------------------------------------------------------------

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
const CLOSERS = new Set([")", "]", "}", '"', "'", "`"]);

export function inCode(state: EditorState, pos = state.selection.main.head): boolean {
  return contextAt(state, pos).mode === "code";
}

/** Auto-closes brackets and quotes while typing in code mode. Returns true if handled. */
export function codeInput(view: EditorView, from: number, to: number, text: string): boolean {
  if (text.length !== 1 || !inCode(view.state, from)) return false;
  const state = view.state;
  const next = state.sliceDoc(to, to + 1);
  if (from === to && CLOSERS.has(text) && next === text) {
    view.dispatch({ selection: EditorSelection.cursor(to + 1), userEvent: "input.type" });
    return true;
  }
  const close = PAIRS[text];
  if (!close) return false;
  const prev = state.sliceDoc(from - 1, from);
  if (close === text && /\w/.test(prev)) return false; // apostrophes in words, closing quotes
  if (from === to && /\w/.test(next)) return false;
  const selected = state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: text + selected + close },
    selection: from === to ? EditorSelection.cursor(from + 1) : EditorSelection.range(from + 1, from + 1 + selected.length),
    userEvent: "input.type",
  });
  return true;
}

// ---- Paste as code ---------------------------------------------------------------------

/** Languages built into listings (others need \lstdefinelanguage in your preamble). */
export const LISTINGS_LANGUAGES = [
  "Python", "Java", "C", "C++", "SQL", "bash", "Haskell", "Matlab", "R", "Ruby", "HTML", "XML", "Lisp", "Prolog", "Scala", "Fortran",
];

/** The last `language=` used in the document, if any. */
export function lastLanguage(state: EditorState): string | null {
  const blocks = findCodeBlocks(state.doc.toString());
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].lang) return blocks[i].lang;
  return null;
}

/** Inserts `code` verbatim as an lstlisting block at the cursor, as one undo step. */
export function insertCodeBlock(view: EditorView, code: string, language: string | null) {
  const state = view.state;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const indent = /^\s*/.exec(line.text)![0];
  const before = state.sliceDoc(line.from, sel.from);
  const after = state.sliceDoc(sel.to, line.to);
  const opt = language ? `[language=${language}]` : "";
  const body = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const head = (before.trim() ? "\n" + indent : "") + `\\begin{lstlisting}${opt}\n`;
  const tail = `\n${indent}\\end{lstlisting}` + (after.trim() ? "\n" + indent : "");
  const insert = head + body + tail;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.cursor(sel.from + head.length + body.length + `\n${indent}\\end{lstlisting}`.length),
    annotations: isolateHistory.of("full"),
    userEvent: "input.paste",
    scrollIntoView: true,
  });
}
