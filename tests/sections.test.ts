import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldAll, foldedRanges, toggleFold, unfoldAll } from "@codemirror/language";
import { scanField } from "../src/scanner/field";
import { itemRange, sectionFolding, sectionRange } from "../src/editor/sections";

const doc = [
  "\\documentclass{article}",     // 1
  "\\begin{document}",            // 2
  "\\section{Intro}",             // 3
  "Hello.",                       // 4
  "\\subsection*{Detail}",        // 5
  "More.",                        // 6
  "",                             // 7
  "\\section[short]{Methods}",    // 8
  "Text.",                        // 9
  "% \\section{not a heading}",   // 10
  "\\begin{verbatim}",            // 11
  "\\section{inside verbatim}",   // 12
  "\\end{verbatim}",              // 13
  "",                             // 14
  "\\end{document}",              // 15
].join("\n");

const state = () => EditorState.create({ doc, extensions: [scanField, sectionFolding] });
const lines = (s: EditorState, r: { from: number; to: number } | null) => r && [s.doc.lineAt(r.from).number, s.doc.lineAt(r.to).number];

describe("section folding", () => {
  it("a section runs to the next heading of the same or higher level", () => {
    const s = state();
    expect(lines(s, sectionRange(s, 3))).toEqual([3, 6]); // includes its subsection, not the blank line
    expect(lines(s, sectionRange(s, 5))).toEqual([5, 6]);
  });

  it("the last section stops at \\end{document}; comments and verbatim aren't headings", () => {
    const s = state();
    expect(lines(s, sectionRange(s, 8))).toEqual([8, 13]);
    expect(sectionRange(s, 10)).toBe(null);
    expect(sectionRange(s, 12)).toBe(null);
    expect(sectionRange(s, 4)).toBe(null);
  });

  it("fold at the cursor folds the section it's in; fold all / unfold all", () => {
    const view = new EditorView({ state: state(), parent: document.body });
    view.dispatch({ selection: { anchor: doc.indexOf("Text.") } });
    toggleFold(view);
    const folded = () => { const out: number[][] = []; foldedRanges(view.state).between(0, view.state.doc.length, (f, t) => { out.push([view.state.doc.lineAt(f).number, view.state.doc.lineAt(t).number]); }); return out; };
    expect(folded()).toEqual([[8, 13]]);
    toggleFold(view); // again: unfolds
    expect(folded()).toEqual([]);
    foldAll(view);
    expect(folded()).toEqual([[3, 6], [8, 13]]);
    view.destroy();
  });

  const hw = [
    "\\begin{document}",           // 1
    "\\begin{enumerate}",          // 2
    "  \\item Prove it.",          // 3
    "    \\begin{enumerate}",      // 4
    "      \\item part a",         // 5
    "        work a",               // 6
    "      \\item part b",         // 7
    "        \\begin{itemize}",    // 8
    "          \\item bullet",     // 9
    "        \\end{itemize}",      // 10
    "    \\end{enumerate}",        // 11
    "",                             // 12
    "  \\newpage",                 // 13
    "  \\item Second.",            // 14
    "    answer",                   // 15
    "\\end{enumerate}",            // 16
    "\\end{document}",             // 17
  ].join("\n");

  it("a question folds to the next question, keeping the page break visible; parts fold too", () => {
    const s = EditorState.create({ doc: hw, extensions: [scanField, sectionFolding] });
    expect(lines(s, itemRange(s, 3))).toEqual([3, 11]);
    expect(lines(s, itemRange(s, 14))).toEqual([14, 15]);
    expect(lines(s, itemRange(s, 5))).toEqual([5, 6]);
    expect(lines(s, itemRange(s, 7))).toEqual([7, 10]);
    expect(itemRange(s, 9)).toBe(null); // itemize bullets don't fold
  });

  it("fold all collapses every question", () => {
    const view = new EditorView({ state: EditorState.create({ doc: hw, extensions: [scanField, sectionFolding] }), parent: document.body });
    foldAll(view);
    const out: number[][] = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (f, t) => { out.push([view.state.doc.lineAt(f).number, view.state.doc.lineAt(t).number]); });
    expect(out).toEqual([[3, 11], [14, 15]]);
    view.destroy();
  });
});
