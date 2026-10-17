import { describe, expect, it } from "vitest";
import { undo } from "@codemirror/commands";
import { blockLevels, jumpOut, jumpOutLevel, scopeAt, tabLanding } from "../src/editor/jumpout";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { scanField } from "../src/scanner/field";
import { SnippetRuntime } from "../src/snippets/runtime";
import { editor, show } from "./helpers";

const none = () => new SnippetRuntime();
const jump = (doc: string, times = 1) => {
  const v = editor(doc, none());
  for (let i = 0; i < times; i++) jumpOut(v);
  return show(v);
};

describe("jump out", () => {
  it("leaves a list onto a new line after its \\end", () => {
    expect(jump("\\begin{itemize}\n  \\item one|\n\\end{itemize}\nafter"))
      .toBe("\\begin{itemize}\n  \\item one\n\\end{itemize}\n|\nafter");
  });

  it("always adds a new line, even when a blank line follows", () => {
    expect(jump("\\begin{itemize}\n  \\item one|\n\\end{itemize}\n\nafter"))
      .toBe("\\begin{itemize}\n  \\item one\n\\end{itemize}\n|\n\nafter");
  });

  it("climbs one level per press, without leaving blank lines behind", () => {
    const doc = "\\begin{enumerate}\n  \\item Q\n    \\begin{itemize}\n      \\item a|\n    \\end{itemize}\n\\end{enumerate}";
    expect(jump(doc)).toBe("\\begin{enumerate}\n  \\item Q\n    \\begin{itemize}\n      \\item a\n    \\end{itemize}\n    |\n\\end{enumerate}");
    expect(jump(doc, 2)).toBe("\\begin{enumerate}\n  \\item Q\n    \\begin{itemize}\n      \\item a\n    \\end{itemize}\n\\end{enumerate}\n|");
  });

  it("skips brackets and inline math: it only leaves blocks", () => {
    expect(jump("\\begin{itemize}\n  \\item \\textbf{a \\(\\frac{x|}{2}\\)} b\n\\end{itemize}"))
      .toBe("\\begin{itemize}\n  \\item \\textbf{a \\(\\frac{x}{2}\\)} b\n\\end{itemize}\n|");
    expect(jump("\\begin{align*}\n  x &= \\left( \\frac{1|}{2} \\right)\n\\end{align*}\nnext"))
      .toBe("\\begin{align*}\n  x &= \\left( \\frac{1}{2} \\right)\n\\end{align*}\n|\nnext");
    const v = editor("Some \\textbf{bo|ld} \\(x\\) text", none());
    expect(jumpOut(v)).toBe(false);
  });

  it("display math on its own lines is left like an environment", () => {
    expect(jump("\\[\n  x|\n\\]\nnext")).toBe("\\[\n  x\n\\]\n|\nnext");
    expect(jump("\\[ x| \\] and more")).toBe("\\[ x \\]\n|and more");
  });

  it("always lands on a new line after an \\end, even with text or a comment after it", () => {
    expect(jump("  \\begin{itemize}\n    \\item a|\n  \\end{itemize} Then more.")).toBe("  \\begin{itemize}\n    \\item a\n  \\end{itemize}\n  |Then more.");
    expect(jump("\\begin{itemize}\n  \\item a|\n\\end{itemize} % list\nnext")).toBe("\\begin{itemize}\n  \\item a\n\\end{itemize} % list\n|\nnext");
  });

  it("leaves a code block", () => {
    expect(jump("\\begin{lstlisting}\nf(x|\n\\end{lstlisting}")).toBe("\\begin{lstlisting}\nf(x\n\\end{lstlisting}\n|");
  });

  it("ignores comments and never leaves the document", () => {
    expect(jump("\\begin{itemize}\n\\item a| % \\end{itemize}\n\\end{itemize}")).toBe("\\begin{itemize}\n\\item a % \\end{itemize}\n\\end{itemize}\n|");
    const v = editor("\\begin{document}\nhi|\n\\end{document}", none());
    expect(jumpOut(v)).toBe(false);
  });

  it("is one undo step", () => {
    const v = editor("\\begin{itemize}\n  \\item one|\n\\end{itemize}", none());
    jumpOut(v);
    undo(v);
    expect(v.state.doc.toString()).toBe("\\begin{itemize}\n  \\item one\n\\end{itemize}");
  });

  it("the Tab marker shows the next slot, or the next snippet field", () => {
    const v = editor("$\\frac{a|}{b}$", none());
    expect(tabLanding(v.state, v.state.selection.main.head)).toBe("$\\frac{a}{".length);
    const item = editor("\\begin{itemize}\n  \\item |\n\\end{itemize}", none());
    expect(tabLanding(item.state, item.state.selection.main.head)).toBe(null);
  });

  it("finds the scope's opener", () => {
    const doc = "\\(a + \\frac{1}{2 + x}\\)";
    const v = editor(doc.replace("x", "x|"), none());
    const s = scopeAt(v.state, v.state.selection.main.head)!;
    expect(doc.slice(s.from, s.to)).toBe("{2 + x}");
    expect(s.block).toBe(false);
  });

  const hw = "\\begin{enumerate}\n  \\item Q\n    \\begin{itemize}\n      \\item a\n      \\begin{align*}\n        x &= 1|\n      \\end{align*}\n    \\end{itemize}\n\\end{enumerate}";

  it("lists the enclosing blocks innermost first, and ⌥N picks one", () => {
    const v = editor(hw, none());
    expect(blockLevels(v.state, v.state.selection.main.head).map((b) => v.state.doc.lineAt(b.to).text.trim())).toEqual(["\\end{align*}", "\\end{itemize}", "\\end{enumerate}"]);
    jumpOutLevel(v, 2);
    expect(show(v)).toBe(hw.replace("1|", "1").replace("    \\end{itemize}\n", "    \\end{itemize}\n    |\n"));
    expect(jumpOutLevel(editor(hw, none()), 4)).toBe(false);
  });
});
