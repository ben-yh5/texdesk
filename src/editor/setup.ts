import { Compartment, EditorState, Extension, Facet } from "@codemirror/state";
import {
  EditorView, GutterMarker, drawSelection, gutter, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { codeBlocks, latexLanguage } from "./codeblocks";
import { linter, lintGutter } from "@codemirror/lint";
import { Vim, vim } from "@replit/codemirror-vim";
import { links, openLink } from "./links";
import { diagramHover, editDiagramAt } from "../diagram/hover";
import { brackets } from "./brackets";
import { jumpOutMarker } from "./jumpout";
import { sectionFolding } from "./sections";
import { findReplace } from "./search";
import { LinkCandidate, linkCandidates, linkCompletion } from "./linkcomplete";
import type { LinkCommand, LinkRef } from "../workspace/links";
import { tags as t } from "@lezer/highlight";
import { snippetExtension } from "../snippets/cm";
import type { SnippetRuntime } from "../snippets/runtime";
import type { EditorSettings } from "../workspace/config";
import { defaultConfig } from "../workspace/config";
import { macrosCompartment, mathMacros, mathPreview } from "./mathpreview";
import { spellFix } from "./spellfix";
import { numberedJumps } from "./targets";
import { wrapIndent } from "./wrapindent";

export const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.tagName], color: "var(--td-hl-keyword)" },
  { tag: [t.atom, t.bracket], color: "var(--td-hl-bracket)" },
  { tag: [t.variableName, t.typeName], color: "var(--td-hl-variable)" },
  { tag: t.comment, color: "var(--td-hl-comment)", fontStyle: "italic" },
  { tag: [t.number, t.string], color: "var(--td-hl-string)" },
  { tag: t.invalid, color: "var(--td-hl-error)" },
]);

export const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--td-bg)", color: "var(--td-fg)" },
  ".cm-scroller": { fontFamily: "var(--td-editor-font, var(--td-mono))", fontSize: "var(--td-editor-size, 14.5px)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--td-accent)", padding: "16px 0", maxWidth: "860px" },
  ".cm-cursor": { borderLeftColor: "var(--td-accent)", borderLeftWidth: "2px" },
  ".cm-gutters": { backgroundColor: "var(--td-bg)", color: "var(--td-muted)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--td-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--td-fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--td-selection) !important" },
  ".cm-matchingBracket": { backgroundColor: "var(--td-match)", outline: "none" },
  // CM's base theme gives tooltips a light background unless the editor is marked dark.
  ".cm-tooltip": { backgroundColor: "var(--td-bar)", color: "var(--td-fg)", border: "1px solid var(--td-border)", borderRadius: "6px" },
  ".cm-tooltip-section:not(:first-child)": { borderTop: "1px solid var(--td-border)" },
  ".cm-diagnostic": { fontFamily: "var(--td-mono)", fontSize: "12px" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--td-error)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--td-warn)" },
  ".cm-lintRange-active": { backgroundColor: "var(--td-match)" },
  // Actions (fixes) as plain options like ⌘L's picker, not CM's dark buttons.
  ".cm-diagnostic-info": { borderLeftColor: "var(--td-muted)" },
  ".cm-diagnosticAction": { backgroundColor: "transparent", color: "var(--td-fg)", padding: 0, marginLeft: "10px" },
  ".cm-diagnosticAction:hover": { color: "var(--td-accent)" },
  // Misspellings: the usual red squiggle rather than the blue "info" one.
  // Vim mode: block cursor and the status / ex-command line.
  ".cm-fat-cursor": { background: "var(--td-accent)", color: "var(--td-bg) !important" },
  "&:not(.cm-focused) .cm-fat-cursor": { background: "none", outline: "solid 1px var(--td-accent)" },
  ".cm-panels": { backgroundColor: "var(--td-bar)", color: "var(--td-fg)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--td-border)" },
  ".cm-vim-panel": { fontFamily: "var(--td-mono)", fontSize: "12px", padding: "2px 10px" },
  // Find and replace.
  ".cm-panels-top": { borderBottom: "1px solid var(--td-border)" },
  ".cm-search": { fontSize: "12px", padding: "6px 10px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 6px" },
  ".cm-search br": { flexBasis: "100%", height: 0 },
  ".cm-search label": { display: "inline-flex", alignItems: "center", gap: "3px", color: "var(--td-muted)" },
  ".cm-search .cm-textfield": { backgroundColor: "var(--td-bg)", color: "var(--td-fg)", border: "1px solid var(--td-border)", borderRadius: "4px", padding: "3px 6px", width: "220px", margin: 0, fontSize: "12px" },
  ".cm-search .cm-textfield:focus": { outline: "none", borderColor: "var(--td-accent)" },
  ".cm-search .cm-button": { backgroundImage: "none", backgroundColor: "transparent", color: "var(--td-fg)", border: "1px solid var(--td-border)", borderRadius: "4px", padding: "2px 8px", margin: 0, fontSize: "12px" },
  ".cm-search .cm-button:hover": { borderColor: "var(--td-accent)" },
  ".cm-search button[name=close]": { position: "absolute", top: "4px", right: "8px", color: "var(--td-muted)", fontSize: "16px" },
  ".cm-searchMatch": { backgroundColor: "var(--td-match)", outline: "none" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--td-selection)", outline: "1px solid var(--td-accent)" },
  ".cm-lintRange.cm-spell": { backgroundImage: "none", textDecoration: "underline wavy var(--td-error)", textDecorationSkipInk: "none", textUnderlineOffset: "3px" },
  // ⌘L's fix, and the other suggestions to swap in with 1–4.
  ".cm-spellfix-word": { backgroundColor: "var(--td-match)", borderRadius: "2px" },
  ".cm-tooltip.cm-spellfix": { display: "flex", gap: "10px", padding: "3px 8px", fontFamily: "var(--td-mono)", fontSize: "12px" },
  ".cm-spellfix-option": { cursor: "pointer", whiteSpace: "nowrap" },
  ".cm-spellfix-option:hover": { color: "var(--td-accent)" },
  ".cm-spellfix-selected": { color: "var(--td-accent)", backgroundColor: "var(--td-match)", borderRadius: "3px", padding: "0 3px", margin: "0 -3px" },
  ".cm-spellfix-extra": { color: "var(--td-muted)" },
  // Misspellings have their own hover tooltip (spellfix.ts); lint's is left empty for them.
  ".cm-tooltip:has(> .cm-tooltip-lint:empty)": { display: "none" },
  ".cm-spellfix kbd": { color: "var(--td-muted)", marginRight: "4px", fontFamily: "inherit" },
});

export interface EditorOptions {
  doc: string;
  /** Enables LaTeX highlighting, the scanner, and snippets. */
  tex: boolean;
  /** Extra extensions, e.g. a language for non-LaTeX files. */
  extra?: Extension[];
  runtime: SnippetRuntime;
  onUpdate(view: EditorView, docChanged: boolean): void;
  onSave(): void;
  /** ⌘-click on a link in a .tex file. */
  onOpenLink?(ref: LinkRef): void;
  /** The "Edit diagram" button on a hovered tikzpicture (`pos` is in the picture). */
  onEditDiagram?(pos: number): void;
  /** Files to suggest inside \\link{…}, \\input{…} etc. */
  linkCandidates?(command: LinkCommand): LinkCandidate[];
  settings?: EditorSettings;
}

/** Holds the extensions that depend on settings, so they can change without a new state. */
export const settingsCompartment = new Compartment();

/** What `:w` in vim mode does in an editor. */
const saveHandler = Facet.define<() => void, (() => void) | undefined>({ combine: (v) => v[v.length - 1] });

Vim.defineEx("write", "w", (cm: { cm6: EditorView }) => cm.cm6.state.facet(saveHandler)?.());

// In visual mode, * and ` are typed over the selection, as without vim, so visual snippets (e.g.
// the Markdown shortcuts' * → \emph, ** → \textbf, ` → \lstinline) work there too. Without one,
// nothing happens.
Vim.defineAction("typeOver", (cm: { cm6: EditorView }, args: { selectedCharacter?: string }) => {
  const view = cm.cm6, text = args.selectedCharacter!;
  const { from, to } = view.state.selection.main;
  const plain = () => view.state.update({ changes: { from, to, insert: text } });
  view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, text, plain));
});
for (const text of ["*", "`"]) Vim.mapCommand(text, "action", "typeOver", { selectedCharacter: text }, { context: "visual" });

class LineNumber extends GutterMarker {
  constructor(readonly text: string) { super(); }
  eq(other: LineNumber) { return other.text === this.text; }
  toDOM() { return document.createTextNode(this.text); }
}

/** Line numbers counted from the cursor's line, which shows its own number (Vim's `number relativenumber`). */
const relativeLineNumbers = gutter({
  class: "cm-lineNumbers",
  lineMarker(view, block) {
    const { doc, selection } = view.state;
    const cursor = doc.lineAt(selection.main.head).number, n = doc.lineAt(block.from).number;
    return new LineNumber(String(n === cursor ? n : Math.abs(n - cursor)));
  },
  lineMarkerChange: (u) => u.selectionSet,
  initialSpacer: (view) => new LineNumber(String(view.state.doc.lines)),
  updateSpacer: (_spacer, u) => new LineNumber(String(u.state.doc.lines)),
});

export function settingsExtension(s: EditorSettings, tex: boolean): Extension {
  return [
    // First, so its keys take precedence over every other keymap.
    s.vim ? vim({ status: true }) : [],
    s.lineNumbers ? (s.relativeLineNumbers ? relativeLineNumbers : lineNumbers()) : [],
    s.lineWrapping ? [EditorView.lineWrapping, wrapIndent] : [],
    EditorView.theme({
      ".cm-scroller": { fontSize: `${s.fontSize}px`, ...(s.fontFamily ? { fontFamily: `${JSON.stringify(s.fontFamily)}, var(--td-mono)` } : {}) },
    }),
    tex && s.mathPreview ? mathPreview : [],
    tex ? brackets({ autoPair: s.autoPairBrackets, autoEnlarge: s.autoEnlargeBrackets }) : [],
  ];
}

/** Applies changed settings to an open editor. */
export function applySettings(view: EditorView, s: EditorSettings, tex: boolean) {
  view.dispatch({ effects: settingsCompartment.reconfigure(settingsExtension(s, tex)) });
}

export function editorState(o: EditorOptions): EditorState {
  const ext: Extension[] = [
    settingsCompartment.of(settingsExtension(o.settings ?? defaultConfig.editor, o.tex)),
    macrosCompartment.of(mathMacros.of({})),
    saveHandler.of(o.onSave),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    rectangularSelection(),
    highlightActiveLine(),
    bracketMatching(),
    indentUnit.of("  "),
    syntaxHighlighting(highlight),
    theme,
    findReplace,
    keymap.of([{ key: "Mod-s", run: () => (o.onSave(), true), preventDefault: true }, ...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged || u.selectionSet) o.onUpdate(u.view, u.docChanged);
    }),
  ];
  if (o.tex) {
    ext.push(
      latexLanguage, codeBlocks, lintGutter(),
      linter(null, { tooltipFilter: (ds) => ds.filter((d) => d.source !== "spelling") }),
      linkCompletion, o.linkCandidates ? linkCandidates.of(o.linkCandidates) : [],
      snippetExtension(o.runtime),
      jumpOutMarker,
      numberedJumps,
      sectionFolding,
      spellFix,
      links, o.onOpenLink ? openLink.of(o.onOpenLink) : [],
      diagramHover, o.onEditDiagram ? editDiagramAt.of(o.onEditDiagram) : [],
    );
  }
  if (o.extra) ext.push(...o.extra);
  return EditorState.create({ doc: o.doc, extensions: ext });
}
