import { describe, expect, it } from "vitest";
import { undo } from "@codemirror/commands";
import { editor, fixtureFiles, press, runtimeFrom, select, show, type } from "./helpers";

const rt = () => runtimeFrom(fixtureFiles("snippets"));

describe("acceptance: auto-fraction via previousExpression()", () => {
  it("wraps the previous expression and leaves a tab stop for the denominator", () => {
    const v = editor("\\( 1 + (a+b)| \\)", rt());
    type(v, "/");
    expect(show(v)).toBe("\\( 1 + \\frac{a+b}{|} \\)");
    type(v, "c");
    press(v, "Tab");
    expect(show(v)).toBe("\\( 1 + \\frac{a+b}{c}| \\)");
  });
  it("handles scripts and commands", () => {
    const v = editor("$x^2|$", rt());
    type(v, "/");
    expect(show(v)).toBe("$\\frac{x^2}{|}$");
  });
  it("declines (types a plain /) with no previous expression", () => {
    const v = editor("$a + |$", rt());
    type(v, "/");
    expect(show(v)).toBe("$a + /|$");
  });
  it("doesn't fire in text mode", () => {
    const v = editor("and/|", rt());
    type(v, "/");
    expect(show(v)).toBe("and//|");
  });
});

describe("acceptance: generated matrix with numbered tab stops", () => {
  it("pmat23 expands to a 2×3 pmatrix and Tab visits every cell, then exits", () => {
    const v = editor("\\[\n  |\n\\]", rt());
    type(v, "pmat23");
    expect(v.state.doc.toString()).toBe("\\[\n  \\begin{pmatrix}\n   &  &  \\\\\n   &  & \n  \\end{pmatrix}\n\\]");
    const cells = ["a", "b", "c", "d", "e", "f"];
    cells.forEach((c, i) => {
      type(v, c);
      press(v, "Tab");
      if (i < cells.length - 1) expect(v.state.selection.main.empty).toBe(true);
    });
    expect(show(v)).toBe("\\[\n  \\begin{pmatrix}\n  a & b & c \\\\\n  d & e & f\n  \\end{pmatrix}|\n\\]");
  });
  it("bmat and vmat use the captured letter", () => {
    const v = editor("$|$", rt());
    type(v, "bmat11");
    expect(v.state.doc.toString()).toBe("$\\begin{bmatrix}\n\n\\end{bmatrix}$");
  });
});

describe("acceptance: visual wrap", () => {
  it("typing the trigger over a selection wraps it", () => {
    const v = editor("$a + |x+y = 1$", rt());
    select(v, 5, 8);
    type(v, "U");
    expect(show(v)).toBe("$a + \\underbrace{x+y}_{|} = 1$");
    type(v, "n");
    press(v, "Tab");
    expect(show(v)).toBe("$a + \\underbrace{x+y}_{n}| = 1$");
  });
  it("without a selection the trigger is just typed", () => {
    const v = editor("$|$", rt());
    type(v, "U");
    expect(show(v)).toBe("$U|$");
  });
  it("visual snippets respect mode", () => {
    const v = editor("|word", rt());
    select(v, 0, 4);
    type(v, "U");
    expect(show(v)).toBe("U|");
  });
  it("one undo restores the selection text", () => {
    const v = editor("$|xy$", rt());
    select(v, 1, 3);
    type(v, "U");
    undo(v);
    expect(v.state.doc.toString()).toBe("$xy$");
  });
});

describe("acceptance: environment-scoped key handlers", () => {
  it("Tab inserts ' & ' inside align*", () => {
    const v = editor("\\begin{align*}\n  x |\n\\end{align*}", rt());
    expect(press(v, "Tab")).toBe(true);
    expect(show(v)).toBe("\\begin{align*}\n  x  & |\n\\end{align*}");
  });
  it("Enter inserts a row break inside a matrix", () => {
    const v = editor("$\\begin{pmatrix} a|\\end{pmatrix}$", rt());
    press(v, "Enter");
    expect(show(v)).toBe("$\\begin{pmatrix} a \\\\\n|\\end{pmatrix}$");
  });
  it("Tab outside those environments falls through to inserting indentation", () => {
    const v = editor("\\begin{itemize}\n|\n\\end{itemize}", rt());
    press(v, "Tab");
    expect(show(v)).toBe("\\begin{itemize}\n  |\n\\end{itemize}");
  });
  it("Enter outside does nothing special (handler not consulted)", () => {
    const v = editor("text|", rt());
    expect(press(v, "Enter")).toBe(false);
  });
  it("precedence: Tab moves between fields of a generated matrix instead of running the handler", () => {
    const v = editor("\\begin{align*}\n|\n\\end{align*}", rt());
    type(v, "pmat12");
    type(v, "a");
    press(v, "Tab");
    type(v, "b");
    expect(v.state.doc.toString()).toBe("\\begin{align*}\n\\begin{pmatrix}\na & b\n\\end{pmatrix}\n\\end{align*}");
    press(v, "Tab"); // exits the snippet
    press(v, "Tab"); // no fields left: now the handler runs
    expect(v.state.doc.toString()).toContain("\\end{pmatrix} & ");
  });
});

describe("snippet engine behavior", () => {
  it("one-liners and mode filters", () => {
    const v = editor("|", rt());
    type(v, "mk");
    expect(show(v)).toBe("\\(|\\)");
    type(v, "RR");
    expect(show(v)).toBe("\\(\\mathbb{R}|\\)");
    type(v, "mk");
    expect(show(v)).toBe("\\(\\mathbb{R}mk|\\)");
  });
  it("one undo after an auto-expansion restores exactly what was typed", () => {
    const v = editor("see |", rt());
    type(v, "mk");
    expect(show(v)).toBe("see \\(|\\)");
    undo(v);
    expect(show(v)).toBe("see mk|");
  });
  it("undo after typing inside an expansion removes only the typing first", () => {
    const v = editor("|", rt());
    type(v, "mk");
    type(v, "x");
    undo(v);
    expect(show(v)).toBe("\\(|\\)");
    undo(v);
    expect(show(v)).toBe("mk|");
  });
  it("regex triggers are anchored at the cursor", () => {
    const v = editor("$|$", rt());
    type(v, "x2");
    expect(show(v)).toBe("$x_{2}|$");
    type(v, " ab");
    expect(show(v)).toBe("$x_{2} ab|$");
  });
  it("word boundary", () => {
    const v = editor("a|", rt());
    type(v, "dm");
    expect(show(v)).toBe("adm|");
    const w = editor("so |", rt());
    type(w, "dm");
    expect(show(w)).toBe("so \\[\n  |\n\\]");
  });
  it("defaults are selected and Tab cycles through them", () => {
    const v = editor("$|$", rt());
    type(v, "lim");
    expect(show(v)).toBe("$\\lim_{[n] \\to \\infty} $");
    press(v, "Tab");
    expect(show(v)).toBe("$\\lim_{n \\to [\\infty]} $");
    press(v, "Shift-Tab");
    expect(show(v)).toBe("$\\lim_{[n] \\to \\infty} $");
    type(v, "k");
    press(v, "Tab");
    press(v, "Tab");
    expect(show(v)).toBe("$\\lim_{k \\to \\infty} |$");
  });
  it("nested snippets return to the outer snippet's next field", () => {
    const v = editor("$|$", rt());
    type(v, "lim");     // field 1 selected: n
    type(v, "x");       // replaces n
    type(v, "sr");      // nested expansion, no fields of its own
    press(v, "Tab");    // → outer field 2
    expect(show(v)).toBe("$\\lim_{x^{2} \\to [\\infty]} $");
    type(v, "(a+b)/");  // nested auto-fraction with its own field
    type(v, "2");
    press(v, "Tab");    // inner exit
    press(v, "Tab");    // outer exit
    expect(show(v)).toBe("$\\lim_{x^{2} \\to \\frac{a+b}{2}} |$");
  });
  it("Tab-triggered (non-auto) snippets with mirrored fields", () => {
    const v = editor("|", rt());
    type(v, "beg");
    expect(show(v)).toBe("beg|");
    press(v, "Tab");
    type(v, "proof");
    expect(v.state.doc.toString()).toBe("\\begin{proof}\n  \n\\end{proof}");
    press(v, "Tab");
    expect(show(v)).toBe("\\begin{proof}\n  |\n\\end{proof}");
  });
  it("priority beats definition order; longer match breaks ties", () => {
    const v = editor("$|$", rt());
    type(v, "oo");
    expect(show(v)).toBe("$\\circ|$");
    const w = editor("$oo|$", rt());
    // 'ooo' (priority 1) beats 'oo' when both match on the same keystroke
    type(w, "o");
    expect(show(w)).toBe("$\\infty|$");
  });
  it("imports between snippet files work", () => {
    const v = editor("$|$", rt());
    type(v, "@b");
    expect(show(v)).toBe("$\\beta|$");
  });
  it("$$ inserts a literal dollar", () => {
    const v = editor("|", rt());
    type(v, "dol");
    expect(show(v)).toBe("costs $5|");
  });
  it("Escape abandons the active fields", () => {
    const v = editor("$|$", rt());
    type(v, "pmat12");
    expect(press(v, "Escape")).toBe(true);
    press(v, "Tab"); // no fields: falls through to indent
    expect(v.state.doc.toString()).toContain("  ");
  });
  it("moving the cursor out of a snippet ends its fields", () => {
    const v = editor("$|$ after", rt());
    type(v, "pmat12");
    select(v, v.state.doc.length, v.state.doc.length);
    press(v, "Tab");
    expect(v.state.doc.toString().endsWith("after  ")).toBe(true);
  });
  it("records a debug log of what matched and why", () => {
    const r = rt();
    const v = editor("|", r);
    type(v, "mk");
    expect(r.lastLog?.attempts).toEqual([expect.objectContaining({ label: '"mk"', outcome: "fired" })]);
    type(v, "x");
    const w = editor("$a+|$", r);
    type(w, "/");
    expect(r.lastLog?.attempts).toEqual([expect.objectContaining({ label: "auto-fraction", outcome: "declined" })]);
  });
});

describe("loader and error isolation", () => {
  it("a file that fails to compile or import is skipped; the rest load", () => {
    const r = runtimeFrom(fixtureFiles("broken"));
    const errs = Object.fromEntries(r.loadErrors.map((e) => [e.file, e.message]));
    expect(errs["syntax.ts"]).toMatch(/compile error/);
    expect(errs["badimport.ts"]).toMatch(/may only import "texdesk"/);
    expect(errs["fine.ts"]).toBeUndefined();
    const v = editor("|", r);
    type(v, "ok");
    expect(show(v)).toBe("fine|");
  });
  it("a snippet that throws is reported and the next candidate runs", () => {
    const r = runtimeFrom(fixtureFiles("broken"));
    const v = editor("|", r);
    type(v, "boom");
    // Only the error: a busy machine may also add a "slow snippet" warning, which isn't what this tests.
    expect(r.runtimeProblems.filter((p) => p.kind !== "slow")).toEqual([expect.objectContaining({ file: "throws.ts", message: "kaboom", kind: "runtime" })]);
    expect(show(v)).toBe("boOK|");
  });
  it("async snippets are rejected", () => {
    const r = runtimeFrom(fixtureFiles("broken"));
    const v = editor("|", r);
    type(v, "as");
    expect(r.runtimeProblems[0]?.message).toMatch(/synchronous/);
    expect(show(v)).toBe("as|");
  });
  it("snippets are inactive without loaded snippet files", () => {
    const v = editor("|", runtimeFrom([]));
    type(v, "mk");
    expect(show(v)).toBe("mk|");
  });
});
