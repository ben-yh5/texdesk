import { describe, expect, it } from "vitest";
import { parseSnippet } from "../src/snippets/snippet-string";

describe("snippet strings", () => {
  it("plain text with an implicit exit at the end", () => {
    expect(parseSnippet("\\alpha")).toEqual({ text: "\\alpha", hasExit: false, stops: [{ index: 0, ranges: [{ from: 6, to: 6 }] }] });
  });
  it("orders stops 1..n then $0", () => {
    const p = parseSnippet("\\frac{$1}{$2}$0");
    expect(p.text).toBe("\\frac{}{}");
    expect(p.stops.map((s) => [s.index, s.ranges[0].from])).toEqual([[1, 6], [2, 8], [0, 9]]);
  });
  it("defaults", () => {
    const p = parseSnippet("\\lim_{${1:n} \\to ${2:\\infty}} $0");
    expect(p.text).toBe("\\lim_{n \\to \\infty} ");
    expect(p.stops[0].ranges[0]).toEqual({ from: 6, to: 7 });
    expect(p.text.slice(p.stops[1].ranges[0].from, p.stops[1].ranges[0].to)).toBe("\\infty");
  });
  it("defaults with nested braces", () => {
    const p = parseSnippet("${1:\\frac{a}{b}}!");
    expect(p.text).toBe("\\frac{a}{b}!");
    expect(p.stops[0].ranges[0]).toEqual({ from: 0, to: 11 });
  });
  it("mirrored fields", () => {
    const p = parseSnippet("\\begin{$1}$0\\end{$1}");
    expect(p.text).toBe("\\begin{}\\end{}");
    expect(p.stops[0].ranges).toEqual([{ from: 7, to: 7 }, { from: 13, to: 13 }]);
  });
  it("literal dollars", () => {
    expect(parseSnippet("costs $$5").text).toBe("costs $5");
    expect(parseSnippet("$x$").text).toBe("$x$");
    expect(parseSnippet("$$$1$$").text).toBe("$$");
    expect(parseSnippet("\\$").text).toBe("\\$");
    expect(parseSnippet("a $ b").text).toBe("a $ b");
    expect(parseSnippet("${x}").text).toBe("${x}");
  });
  it("multi-digit stops", () => {
    const p = parseSnippet("$10 $2");
    expect(p.stops.map((s) => s.index)).toEqual([2, 10, 0]);
  });
  it("indents continuation lines and expands leading tabs", () => {
    const p = parseSnippet("\\[\n\t$0\n\\]", { indent: "    ", indentUnit: "  " });
    expect(p.text).toBe("\\[\n      \n    \\]");
    expect(p.stops[0].ranges[0].from).toBe(9);
  });
  it("keeps tabs that aren't at a line start", () => {
    expect(parseSnippet("a\tb", { indentUnit: "  " }).text).toBe("a\tb");
  });
});
