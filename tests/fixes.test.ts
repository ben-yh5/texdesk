import { describe, expect, it } from "vitest";
import { ruleFix } from "../src/compile/fixes";
import { knownCommandNames } from "../src/editor/commands";

const known = knownCommandNames();
const fixOf = (line: string, message: string, hint?: string) => ruleFix(message, 1, [line], known, hint)?.replacement ?? null;

// Messages and hints as real Tectonic builds produce them (see scripts/check-rule-fixes.ts).
describe("built-in fixes for common errors", () => {
  it("a missing } (runaway argument)", () => {
    expect(fixOf("  \\item Let $x = \\frac{1}{2$ and $y = 3$.", "!File ended while scanning use of \\frac", "{2$ and $y = 3$. \\end {enumerate} \\end {document} "))
      .toBe("  \\item Let $x = \\frac{1}{2}$ and $y = 3$.");
  });
  it("a missing } (Missing } inserted)", () => {
    expect(fixOf("  \\item Then $\\sqrt{x + 1 = 2$.", "Missing } inserted")).toBe("  \\item Then $\\sqrt{x + 1 = 2}$.");
  });
  it("misspelled commands, including swapped letters", () => {
    expect(fixOf("  \\item Suppose $\\alhpa > 0$.", "Undefined control sequence", "alhpa")).toBe("  \\item Suppose $\\alpha > 0$.");
    expect(fixOf("  \\item This is \\textbg{important}.", "Undefined control sequence", "textbg")).toBe("  \\item This is \\textbf{important}.");
    expect(fixOf("  \\item $\\zzzzzz$", "Undefined control sequence", "zzzzzz")).toBeNull(); // nothing close: no guess
  });
  it("\\begin{X} closed by \\end{Y}", () => {
    expect(fixOf("  \\end{align}", "LaTeX Error: \\begin{align*} on input line 5 ended by \\end{align}.")).toBe("  \\end{align*}");
  });
  it("& in text, but not in math", () => {
    expect(fixOf("Smith & Jones showed $a & b$.", "Misplaced alignment tab character &")).toBe("Smith \\& Jones showed $a & b$.");
  });
  it("math-only commands and ^ _ outside math", () => {
    expect(fixOf("  \\item The set \\mathbb{R} of reals.", "LaTeX Error: \\mathbb allowed only in math mode.")).toBe("  \\item The set $\\mathbb{R}$ of reals.");
    expect(fixOf("  \\item We have x^2 + y_1 = 3 here.", "Missing $ inserted")).toBe("  \\item We have $x^2 + y_1 = 3$ here.");
  });
  it("stray } and missing {", () => {
    expect(fixOf("  \\item Let $x = 1}$ be given.", "Extra }, or forgotten $")).toBe("  \\item Let $x = 1$ be given.");
    expect(fixOf("  \\item Let $x = \\frac{1}2}$ be given.", "Extra }, or forgotten $")).toBe("  \\item Let $x = \\frac{1}2$ be given.");
  });
  it("an unclosed { on an earlier line than the error", () => {
    const lines = ["  \\item \\[", "    \\sum_{i=1}^{n i", "  \\]"];
    expect(ruleFix("Missing } inserted", 3, lines, known)).toMatchObject({ line: 2, replacement: "    \\sum_{i=1}^{n i}" });
    const align = ["\\begin{align*}", "    x &= \\frac{a}{b \\\\", "    y &= 2", "\\end{align*}"];
    expect(ruleFix("!File ended while scanning use of \\align*", 2, align, known, "x &= \\frac {a}{b \\\\ y &= 2")).toMatchObject({ line: 2, replacement: "    x &= \\frac{a}{b} \\\\" });
  });
  it("an environment never closed before an outer \\end gets its own \\end; a typo is renamed", () => {
    const lines = ["\\begin{enumerate}", "  \\item a", "  \\begin{itemize}", "    \\item b", "\\end{enumerate}"];
    expect(ruleFix("LaTeX Error: \\begin{itemize} on input line 3 ended by \\end{enumerate}.", 5, lines, known)?.replacement).toBe("  \\end{itemize}\n\\end{enumerate}");
  });
  it("\\left without \\right, and \\right without \\left", () => {
    expect(fixOf("  \\item $\\left( \\frac{a}{b} = c$", "Missing \\right. inserted")).toBe("  \\item $\\left( \\frac{a}{b} = c \\right)$");
    expect(fixOf("  \\item $\\frac{a}{b} \\right) = c$", "Extra \\right")).toBe("  \\item $\\frac{a}{b} ) = c$");
  });
  it("a $ that's never closed, found from the error a line later", () => {
    const lines = ["  \\item Let $x + 1 be given.", "\\end{enumerate}"];
    expect(ruleFix("LaTeX Error: Command \\end{enumerate} invalid in math mode.", 2, lines, known)).toMatchObject({ line: 1, replacement: "  \\item Let $x + 1$ be given." });
  });

  it("anything else is left to the model", () => {
    expect(fixOf("\\item text", "Something's wrong--perhaps a missing \\item")).toBeNull();
  });
});
