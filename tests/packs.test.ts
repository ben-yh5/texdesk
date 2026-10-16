import { describe, expect, it } from "vitest";
import { undo } from "@codemirror/commands";
import lists from "../src/plugins/builtin/bullet-lists.ts?raw";
import markdown from "../src/plugins/builtin/markdown-shortcuts.ts?raw";
import matrixKeys from "../src/plugins/builtin/matrix-keys.ts?raw";
import castel from "../src/plugins/builtin/castel.ts?raw";
import { editor, press, runtimeFrom, select, show, type } from "./helpers";

const rt = (name: string, code: string) => {
  const r = runtimeFrom([{ name, code }]);
  expect(r.loadErrors).toEqual([]);
  return r;
};

describe("built-in plugin: matrix & align keys", () => {
  const r = () => rt("matrix-keys.ts", matrixKeys);

  it("Tab adds a column and Enter a row inside a matrix", () => {
    const v = editor("\\[\\begin{pmatrix}\n  a|\n\\end{pmatrix}\\]", r());
    press(v, "Tab");
    type(v, "b");
    press(v, "Enter");
    type(v, "c");
    expect(show(v)).toBe("\\[\\begin{pmatrix}\n  a & b \\\\\n  c|\n\\end{pmatrix}\\]");
  });

  it("works in align*, and Shift+Enter is a plain newline", () => {
    const v = editor("\\begin{align*}\n  x &= 1|\n\\end{align*}", r());
    press(v, "Shift-Enter");
    expect(show(v)).toBe("\\begin{align*}\n  x &= 1\n  |\n\\end{align*}");
  });

  it("inside a bracket in an align row, Tab moves between slots instead of adding a column", () => {
    const v = editor("\\begin{align*}\n  x &= \\frac{a|}{b}\n\\end{align*}", r());
    press(v, "Tab");
    expect(show(v)).toBe("\\begin{align*}\n  x &= \\frac{a}{|b}\n\\end{align*}");
    press(v, "Tab");
    expect(show(v)).toBe("\\begin{align*}\n  x &= \\frac{a}{b}|\n\\end{align*}");
    press(v, "Tab");
    expect(show(v)).toBe("\\begin{align*}\n  x &= \\frac{a}{b} & |\n\\end{align*}");
    const t = editor("\\begin{align*}\n  x &= 1 & \\text{by lin|}\n\\end{align*}", r());
    press(t, "Tab");
    expect(show(t)).toBe("\\begin{align*}\n  x &= 1 & \\text{by lin}|\n\\end{align*}");
  });

  it("leaves Tab and Enter alone elsewhere", () => {
    const v = editor("\\[ x| \\]", r());
    expect(press(v, "Enter")).toBe(false);
  });
});

describe("built-in plugin: bullet lists", () => {
  const r = () => rt("lists.ts", lists);

  it("- then space on an empty line makes an itemize block; undo gets back the -", () => {
    const v = editor("a\n  |\nb", r());
    type(v, "- ");
    expect(show(v)).toBe("a\n  \\begin{itemize}\n    \\item |\n  \\end{itemize}\nb");
    undo(v);
    expect(show(v)).toBe("a\n  - |\nb");
  });

  it("- inside an itemize is just a new item; under an enumerate item, a bulleted list there", () => {
    const v = editor("\\begin{itemize}\n  \\item a\n  |\n\\end{itemize}", r());
    type(v, "- ");
    expect(show(v)).toBe("\\begin{itemize}\n  \\item a\n  \\item |\n\\end{itemize}");
    const w = editor("\\begin{enumerate}\n  \\item Prove it.\n    |\n\\end{enumerate}", r());
    type(w, "- ");
    expect(show(w)).toBe("\\begin{enumerate}\n  \\item Prove it.\n    \\begin{itemize}\n      \\item |\n    \\end{itemize}\n\\end{enumerate}");
  });

  it("doesn't fire mid-line, in math, or in code", () => {
    for (const doc of ["a |", "$|$", "\\[\n|\n\\]", "\\begin{lstlisting}\n|\n\\end{lstlisting}"]) {
      const v = editor(doc, r());
      type(v, "- ");
      expect(v.state.doc.toString()).not.toContain("itemize");
    }
  });

  it("Enter in an itemize adds an \item, keeping the indentation and splitting the line", () => {
    const v = editor("\\begin{itemize}\n  \\item a|\n\\end{itemize}", r());
    press(v, "Enter");
    expect(show(v)).toBe("\\begin{itemize}\n  \\item a\n  \\item |\n\\end{itemize}");
    const w = editor("\\begin{itemize}\n  \\item ab|cd\n\\end{itemize}", r());
    press(w, "Enter");
    expect(show(w)).toBe("\\begin{itemize}\n  \\item ab\n  \\item |cd\n\\end{itemize}");
  });

  it("Enter on an empty \item ends the list; in a nested list, continues the outer one", () => {
    const v = editor("\\begin{itemize}\n  \\item a\n  \\item |\n\\end{itemize}\nb", r());
    press(v, "Enter");
    expect(show(v)).toBe("\\begin{itemize}\n  \\item a\n\\end{itemize}\n|\nb");
    undo(v);
    expect(show(v)).toBe("\\begin{itemize}\n  \\item a\n  \\item |\n\\end{itemize}\nb");
    const w = editor("\\begin{itemize}\n  \\item a\n  \\begin{itemize}\n    \\item b\n    \\item |\n  \\end{itemize}\n\\end{itemize}", r());
    press(w, "Enter");
    expect(show(w)).toBe("\\begin{itemize}\n  \\item a\n  \\begin{itemize}\n    \\item b\n  \\end{itemize}\n  \\item |\n\\end{itemize}");
  });

  it("Enter right after inline math in an item still adds an \\item", () => {
    const v = editor("\\begin{itemize}\n  \\item $x$|\n\\end{itemize}", r());
    press(v, "Enter");
    expect(show(v)).toBe("\\begin{itemize}\n  \\item $x$\n  \\item |\n\\end{itemize}");
  });

  it("Shift+Enter is a plain newline; Enter outside an itemize (e.g. enumerate) is left alone", () => {
    const v = editor("\\begin{itemize}\n  \\item a|\n\\end{itemize}", r());
    press(v, "Shift-Enter");
    expect(show(v)).toBe("\\begin{itemize}\n  \\item a\n  |\n\\end{itemize}");
    for (const doc of ["\\begin{enumerate}\n  \\item a|\n\\end{enumerate}", "a|", "\\begin{itemize}\n  \\item $x|$\n\\end{itemize}"]) {
      expect(press(editor(doc, r()), "Enter")).toBe(false);
    }
  });
});

describe("built-in plugin: Markdown shortcuts", () => {
  const r = () => rt("markdown.ts", markdown);

  it("* starts a bulleted list, 1. a numbered one; inside a list, just a new item", () => {
    const v = editor("|", r());
    type(v, "* ");
    expect(show(v)).toBe("\\begin{itemize}\n  \\item |\n\\end{itemize}");
    const w = editor("  |", r());
    type(w, "1. ");
    expect(show(w)).toBe("  \\begin{enumerate}\n    \\item |\n  \\end{enumerate}");
    const x = editor("\\begin{enumerate}\n  \\item a\n  |\n\\end{enumerate}", r());
    type(x, "1. ");
    expect(show(x)).toBe("\\begin{enumerate}\n  \\item a\n  \\item |\n\\end{enumerate}");
  });

  it("leaves - alone (that's the Bullet lists pack)", () => {
    const v = editor("|", r());
    type(v, "- ");
    expect(show(v)).toBe("- |");
  });

  it("headings, bold, emphasis, code and links", () => {
    const v = editor("|", r());
    type(v, "## ");
    expect(show(v)).toBe("\\subsection{|}");
    const w = editor("|", r());
    type(w, "a **b** and *c* with `x|y` see [here](https://x.org)");
    expect(show(w)).toBe("a \\textbf{b} and \\emph{c} with \\lstinline!x|y! see \\href{https://x.org}{here}|");
  });

  it("` on a selection makes it inline code; not across lines", () => {
    const v = editor("run |a|b here", r());
    select(v, 4, 7);
    type(v, "`");
    expect(show(v)).toBe("run \\lstinline!a|b!| here");
    const w = editor("|a\nb", r());
    select(w, 0, 3);
    type(w, "`");
    expect(w.state.doc.toString()).toBe("`");
  });

  it("* on a selection emphasizes it, * again makes it bold, a third adds emphasis inside", () => {
    const v = editor("see |this word here", r());
    select(v, 4, 13);
    type(v, "*");
    expect(show(v)).toBe("see \\emph{[this word]} here");
    type(v, "*");
    expect(show(v)).toBe("see \\textbf{[this word]} here");
    type(v, "*");
    expect(show(v)).toBe("see \\textbf{\\emph{[this word]}} here");
    undo(v);
    expect(show(v)).toBe("see \\textbf{[this word]} here");
  });

  it("* on a selection with unbalanced braces still wraps it, without keeping it selected", () => {
    const v = editor("a} |b", r());
    select(v, 0, 2);
    type(v, "*");
    expect(show(v)).toBe("\\emph{a}}| b");
  });

  it("doesn't fire mid-line, in math, or in code", () => {
    const v = editor("|", r());
    type(v, "x * y");
    expect(show(v)).toBe("x * y|");
    for (const doc of ["$|$", "\\begin{lstlisting}\n|\n\\end{lstlisting}"]) {
      const m = editor(doc, r());
      type(m, "**b**");
      expect(m.state.doc.toString()).not.toContain("textbf");
    }
  });
});

describe("built-in plugins: nesting lists with Tab", () => {
  for (const [name, code] of [["lists.ts", lists], ["markdown.ts", markdown]] as const) {
    const r = () => rt(name, code);

    it(`${name}: Tab on an empty \\item nests a list of the same kind; Shift+Tab undoes it`, () => {
      const v = editor("\\begin{enumerate}\n  \\item a\n  \\item |\n\\end{enumerate}", r());
      press(v, "Tab");
      expect(show(v)).toBe("\\begin{enumerate}\n  \\item a\n  \\begin{enumerate}\n    \\item |\n  \\end{enumerate}\n\\end{enumerate}");
      press(v, "Shift-Tab");
      expect(show(v)).toBe("\\begin{enumerate}\n  \\item a\n  \\item |\n\\end{enumerate}");
      undo(v);
      expect(show(v)).toBe("\\begin{enumerate}\n  \\item a\n  \\begin{enumerate}\n    \\item |\n  \\end{enumerate}\n\\end{enumerate}");
    });

    it(`${name}: Shift+Tab after other nested items continues the outer list`, () => {
      const v = editor("\\begin{itemize}\n  \\item a\n  \\begin{itemize}\n    \\item b\n    \\item |\n  \\end{itemize}\n\\end{itemize}", r());
      press(v, "Shift-Tab");
      expect(show(v)).toBe("\\begin{itemize}\n  \\item a\n  \\begin{itemize}\n    \\item b\n  \\end{itemize}\n  \\item |\n\\end{itemize}");
    });

    it(`${name}: leaves Tab alone on a non-empty item, the first item, and Shift+Tab at the top level`, () => {
      const v = editor("\\begin{itemize}\n  \\item a|\n\\end{itemize}", r());
      press(v, "Tab");
      expect(show(v).match(/begin/g)).toHaveLength(1);
      const w = editor("\\begin{itemize}\n  \\item |\n\\end{itemize}", r());
      press(w, "Tab");
      expect(show(w).match(/begin/g)).toHaveLength(1);
      const x = editor("\\begin{itemize}\n  \\item a\n  \\item |\n\\end{itemize}", r());
      press(x, "Shift-Tab");
      expect(show(x)).toContain("\\item |\n\\end{itemize}");
    });
  }
});

describe("built-in plugin: Gilles Castel's snippets", () => {
  const r = () => rt("castel.ts", castel);

  it("mk and dm enter math; beg at the start of a line makes an environment", () => {
    const v = editor("Let |", r());
    type(v, "mkx");
    expect(show(v)).toBe("Let $x|$");
    const d = editor("|", r());
    type(d, "dm");
    expect(show(d)).toBe("\\[\n|\n.\\] ");
    const b = editor("|", r());
    type(b, "beg");
    expect(show(b)).toBe("\\begin{|}\n  \n\\end{|}"); // mirrored
  });

  it("fractions: //, x/ and (…)/", () => {
    const v = editor("$|$", r());
    type(v, "//");
    expect(show(v)).toBe("$\\frac{|}{}$");
    const x = editor("$|$", r());
    type(x, "x/");
    expect(show(x)).toBe("$\\frac{x}{|}$");
    const p = editor("$|$", r());
    type(p, "(a+b)/");
    expect(show(p)).toBe("$\\frac{a+b}{|}$");
  });

  it("auto subscripts, powers and backslash-less functions, in math only", () => {
    const v = editor("$|$", r());
    type(v, "x1 + a_12 + ysr + sin");
    expect(show(v)).toBe("$x_1 + a_{12} + y^2 + \\sin|$");
    const t = editor("|", r());
    type(t, "x1 sin sr");
    expect(show(t)).toBe("x1 sin sr|");
  });

  it("symbols: <=, ->, RR, inn, ooo", () => {
    const v = editor("$|$", r());
    type(v, "a<=b->RR innooo");
    expect(show(v)).toBe("$a\\le b\\to \\R \\in \\infty|$");
  });
});
