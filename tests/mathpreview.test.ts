import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { scanField } from "../src/scanner/field";
import { extractMacros, mathMacros, mathPreview, mathRegionAt, previewSource, renderMath } from "../src/editor/mathpreview";
import { PREAMBLE_STY } from "../src/workspace/templates";
import { settle } from "./helpers";

/** The region around `|`, shown as the doc with [ ] around the content. */
function region(doc: string): string {
  const c = doc.indexOf("|");
  const text = doc.slice(0, c) + doc.slice(c + 1);
  const r = mathRegionAt(EditorState.create({ doc: text, extensions: [scanField] }), c);
  if (!r) return "(none)";
  return `${text.slice(0, r.from)}[${text.slice(r.from, r.to)}]${text.slice(r.to)}${r.display ? " display" : " inline"}${r.env ? " " + r.env : ""}`;
}

describe("math region", () => {
  it("inline delimiters", () => {
    expect(region("a \\(x|+1\\) b")).toBe("a \\([x+1]\\) b inline");
    expect(region("a $x|$ b")).toBe("a $[x]$ b inline");
    expect(region("a \\(|\\) b")).toBe("a \\([]\\) b inline");
  });
  it("display delimiters across lines", () => {
    expect(region("\\[\n  \\int| f\n\\]")).toBe("\\[[\n  \\int f\n]\\] display");
    expect(region("$$a|$$")).toBe("$$[a]$$ display");
  });
  it("environments", () => {
    expect(region("\\begin{align*}\n x &= 1 \\\\\n y| &= 2\n\\end{align*}")).toBe("\\begin{align*}[\n x &= 1 \\\\\n y &= 2\n]\\end{align*} display align*");
  });
  it("includes \\text{} and inner environments", () => {
    expect(region("$a \\text{if| b} c$")).toBe("$[a \\text{if b} c]$ inline");
    expect(region("\\(\\begin{pmatrix} 1| \\end{pmatrix}\\)")).toBe("\\([\\begin{pmatrix} 1 \\end{pmatrix}]\\) inline");
  });
  it("none in text or code", () => {
    expect(region("plain |text")).toBe("(none)");
    expect(region("\\begin{lstlisting}\n$x|$\n\\end{lstlisting}")).toBe("(none)");
  });
});

describe("macros", () => {
  it("reads the seeded preamble.sty", () => {
    const m = extractMacros(PREAMBLE_STY);
    expect(m["\\R"]).toBe("\\mathbb{R}");
    expect(m["\\N"]).toBe("\\mathbb{N}");
  });
  it("handles arguments, nested braces, \\def, stars, and comments", () => {
    const m = extractMacros("\\newcommand{\\abs}[1]{\\left|#1\\right|}\n\\newcommand\\set[1]{\\{#1\\}}\n\\def\\eps{\\varepsilon}\n\\DeclareMathOperator*{\\argmax}{arg\\,max}\n% \\newcommand{\\no}{x}");
    expect(m).toEqual({ "\\abs": "\\left|#1\\right|", "\\set": "\\{#1\\}", "\\eps": "\\varepsilon", "\\argmax": "\\operatorname*{arg\\,max}" });
  });
});

describe("rendering", () => {
  it("wraps align-like environments and strips labels", () => {
    expect(previewSource("x &= 1 \\label{eq:a} \\\\ y &= 2 \\nonumber", "align*")).toBe("\\begin{aligned}x &= 1  \\\\ y &= 2\\end{aligned}");
  });
  it("renders with macros, and shows errors inline instead of throwing", () => {
    expect(renderMath("\\R^n", false, { "\\R": "\\mathbb{R}" })).toContain("katex");
    expect(renderMath("\\frac{1}{", false, {})).toContain("katex-error");
  });
  it("shows a tooltip while the cursor is in math", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "see $\\R^2$ here", selection: { anchor: 6 }, extensions: [scanField, mathPreview, mathMacros.of({ "\\R": "\\mathbb{R}" })] }),
      parent: document.body,
    });
    await settle(20);
    expect(document.querySelector(".cm-math-preview .katex")).toBeTruthy();
    view.dispatch({ selection: { anchor: 13 } });
    await settle(20);
    expect(document.querySelector(".cm-math-preview")).toBe(null);
    view.destroy();
  });
});
