import { describe, expect, it } from "vitest";
import { previousExpression } from "../src/snippets/expression";

const prev = (s: string) => previousExpression(s)?.text ?? null;
const unwrapped = (s: string) => previousExpression(s)?.unwrapped ?? null;

describe("previousExpression", () => {
  it("runs of letters and digits", () => {
    expect(prev("1 + 2x")).toBe("2x");
    expect(prev("a + b")).toBe("b");
    expect(prev("42")).toBe("42");
  });
  it("commands", () => {
    expect(prev("x + \\alpha")).toBe("\\alpha");
    expect(prev("2\\pi")).toBe("2\\pi");
    expect(prev("\\sqrt{2}")).toBe("\\sqrt{2}");
    expect(prev("1 + \\frac{a}{b}")).toBe("\\frac{a}{b}");
    expect(prev("\\mathbf{x}")).toBe("\\mathbf{x}");
  });
  it("operator commands end the expression", () => {
    expect(prev("a \\cdot b")).toBe("b");
    expect(prev("a\\cdot b")).toBe("b");
    expect(prev("x\\cdot")).toBe(null);
    expect(prev("a\\times{b}")).toBe("{b}");
  });
  it("groups", () => {
    expect(prev("1 + (a+b)")).toBe("(a+b)");
    expect(prev("x = [0, 1]")).toBe("[0, 1]");
    expect(prev("{a}")).toBe("{a}");
    expect(prev("((a)(b))")).toBe("((a)(b))");
  });
  it("function application is one expression", () => {
    expect(prev("1 + f(x)")).toBe("f(x)");
    expect(prev("\\sin(x)")).toBe("\\sin(x)");
  });
  it("sub- and superscripts attach to their base", () => {
    expect(prev("1 + x^2")).toBe("x^2");
    expect(prev("1 + x_{i}^{2}")).toBe("x_{i}^{2}");
    expect(prev("e^{i\\pi}")).toBe("e^{i\\pi}");
    expect(prev("(a+b)^2")).toBe("(a+b)^2");
    expect(prev("\\alpha_1")).toBe("\\alpha_1");
  });
  it("primes", () => {
    expect(prev("f'(x)")).toBe("f'(x)");
    expect(prev("y''")).toBe("y''");
  });
  it("\\left…\\right pairs", () => {
    expect(prev("1 + \\left( a+b \\right)")).toBe("\\left( a+b \\right)");
    expect(prev("\\left[ \\left( x \\right) \\right]")).toBe("\\left[ \\left( x \\right) \\right]");
  });
  it("stops at whitespace, operators, and unmatched openers", () => {
    expect(prev("x ")).toBe(null);
    expect(prev("a+")).toBe(null);
    expect(prev("\\frac{a")).toBe("a");
    expect(prev("(")).toBe(null);
  });
  it("does not cross math delimiters", () => {
    expect(prev("\\(x)")).toBe(null);
    expect(prev("$x)")).toBe(null);
    expect(prev("text \\(ab")).toBe("ab");
  });
  it("escaped braces and backslashes", () => {
    expect(prev("\\\\x")).toBe("x");
    expect(prev("a\\}")).toBe(null);
  });
  it("unwraps one pair of outer parens only", () => {
    expect(unwrapped("(a+b)")).toBe("a+b");
    expect(unwrapped("((a+b))")).toBe("(a+b)");
    expect(unwrapped("(a)(b)")).toBe("(a)(b)");
    expect(unwrapped("(a+b)^2")).toBe("(a+b)^2");
    expect(unwrapped("\\left(x+1\\right)")).toBe("x+1");
    expect(unwrapped("x")).toBe("x");
  });
  it("returns a document range", () => {
    expect(previousExpression("a + bc", 100)).toEqual({ text: "bc", unwrapped: "bc", range: { from: 104, to: 106 } });
  });
});
