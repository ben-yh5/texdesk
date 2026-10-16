import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { contextAt, scanField } from "../src/scanner/field";
import { envStackOf, modeOf, scanDocument, scanLine, initialState, statesEqual, ScanState } from "../src/scanner/scanner";

/** Mode and env stack at the `|` in `doc`. */
function at(doc: string) {
  const c = doc.indexOf("|");
  const text = doc.slice(0, c) + doc.slice(c + 1);
  const lines = text.split("\n");
  const states = scanDocument(lines);
  const before = text.slice(0, c).split("\n");
  const ln = before.length - 1;
  const s = scanLine(states[ln], lines[ln], before[ln].length);
  return { mode: modeOf(s), env: envStackOf(s) };
}
const mode = (doc: string) => at(doc).mode;

describe("math-context scanner: delimiters", () => {
  it("text by default", () => expect(mode("hello |world")).toBe("text"));
  it("$…$ inline", () => {
    expect(mode("a $x| y$ b")).toBe("inline");
    expect(mode("a $x y$ |b")).toBe("text");
  });
  it("\\(…\\) inline", () => {
    expect(mode("a \\(x|\\) b")).toBe("inline");
    expect(mode("a \\(x\\)| b")).toBe("text");
  });
  it("cursor right after an opening delimiter is inside", () => {
    expect(mode("\\(|\\)")).toBe("inline");
    expect(mode("$|$")).toBe("inline");
  });
  it("cursor between the backslash and paren of a delimiter is outside", () => {
    expect(mode("a \\|(x\\)")).toBe("text");
  });
  it("$$…$$ display", () => {
    expect(mode("$$x|$$")).toBe("display");
    expect(mode("$$x$$|")).toBe("text");
  });
  it("\\[…\\] display, across lines", () => {
    expect(mode("\\[\n  x|\n\\]")).toBe("display");
    expect(mode("\\[\n  x\n\\]\n|")).toBe("text");
  });
  it("escaped \\$ is not a delimiter", () => {
    expect(mode("costs \\$5 and |more")).toBe("text");
    expect(mode("$a \\$ b|$")).toBe("inline");
  });
  it("\\\\$ is a line break followed by a real $", () => {
    expect(mode("a \\\\$x|$")).toBe("inline");
  });
  it("$a$$b$ is two inline maths", () => {
    expect(mode("$a$$b|$")).toBe("inline");
    expect(mode("$a$$b$|")).toBe("text");
  });
  it("\\( inside math is not a new delimiter", () => {
    expect(mode("\\[ \\( x \\) |\\]")).toBe("display");
  });
});

describe("math-context scanner: environments", () => {
  it("display environments and starred forms", () => {
    for (const env of ["equation", "align", "gather", "multline", "flalign", "eqnarray", "equation*", "align*", "gather*", "multline*"]) {
      expect(mode(`\\begin{${env}}\n x|\n\\end{${env}}`), env).toBe("display");
      expect(mode(`\\begin{${env}}\n x\n\\end{${env}}\n|`), env).toBe("text");
    }
  });
  it("\\begin{math} is inline", () => expect(mode("\\begin{math} x| \\end{math}")).toBe("inline"));
  it("matrix-family environments inherit the surrounding mode", () => {
    expect(mode("\\(\\begin{pmatrix} a| \\end{pmatrix}\\)")).toBe("inline");
    expect(mode("\\[\\begin{bmatrix} a| \\end{bmatrix}\\]")).toBe("display");
    expect(mode("\\(\\begin{cases} a| \\end{cases}\\)")).toBe("inline");
  });
  it("tracks the environment stack, innermost last", () => {
    const doc = "\\begin{document}\n\\begin{enumerate}\n\\item\n\\begin{align*}\n\\begin{pmatrix}\n1 & |2\n\\end{pmatrix}\n\\end{align*}\n\\end{enumerate}\n\\end{document}";
    expect(at(doc)).toEqual({ mode: "display", env: ["document", "enumerate", "align*", "pmatrix"] });
  });
  it("pops back to the matching environment on \\end", () => {
    expect(at("\\begin{document}\n\\begin{align}x\\end{align} |").env).toEqual(["document"]);
  });
  it("recovers from a missing \\end of an inner env", () => {
    expect(at("\\begin{document}\\begin{itemize}\\begin{enumerate}\\end{itemize} |").env).toEqual(["document"]);
  });
  it("text environments are text", () => expect(mode("\\begin{itemize}\n\\item a|\n\\end{itemize}")).toBe("text"));
});

describe("math-context scanner: text inside math", () => {
  it("\\text{…} in math is text", () => {
    expect(mode("$a \\text{if |b} c$")).toBe("text");
    expect(mode("$a \\text{if b} |c$")).toBe("inline");
  });
  it("nested braces inside \\text", () => {
    expect(mode("$\\text{a {b} |c}$")).toBe("text");
    expect(mode("$\\text{a {b} c} |$")).toBe("inline");
  });
  it("math inside \\text inside math", () => {
    expect(mode("\\[ \\text{for $x| > 0$} \\]")).toBe("inline");
    expect(mode("\\[ \\text{for $x > 0$ |} \\]")).toBe("text");
    expect(mode("\\[ \\text{for $x > 0$} |\\]")).toBe("display");
  });
  it("\\textbf, \\mbox and \\intertext count too", () => {
    expect(mode("$\\textbf{a|}$")).toBe("text");
    expect(mode("$\\mbox{a|}$")).toBe("text");
    expect(mode("\\begin{align}\n\\intertext{so |}\n\\end{align}")).toBe("text");
  });
  it("\\text outside math does nothing special", () => {
    expect(mode("\\textbf{a $x|$}")).toBe("inline");
  });
});

describe("math-context scanner: comments and code", () => {
  it("ignores delimiters after %", () => {
    expect(mode("text % $ not math\n|")).toBe("text");
    expect(mode("$x % comment $\n y|$")).toBe("inline");
  });
  it("\\% is not a comment", () => expect(mode("50\\% $x|$")).toBe("inline"));
  it("code environments are code and ignore $ and %", () => {
    expect(mode("\\begin{lstlisting}[language=Python]\nprint('$|')\n\\end{lstlisting}")).toBe("code");
    expect(mode("\\begin{lstlisting}\nx = '$'  % not a comment\n\\end{lstlisting}\n|")).toBe("text");
    expect(mode("\\begin{verbatim}\n\\begin{align}\n\\end{verbatim}\n|")).toBe("text");
  });
  it("code env stack and recovery", () => {
    expect(at("\\begin{document}\n\\begin{lstlisting}\n|x\n\\end{lstlisting}").env).toEqual(["document", "lstlisting"]);
  });
  it("\\verb and \\lstinline are code, and don't span lines", () => {
    expect(mode("\\verb|$x|$|")).toBe("text");
    expect(mode("\\verb!a $ b|!")).toBe("code");
    expect(mode("\\lstinline{x = '$|'}")).toBe("code");
    expect(mode("\\lstinline{x = '$'} $y|$")).toBe("inline");
    expect(mode("\\verb!unterminated\n|")).toBe("text");
  });
});

describe("math-context scanner: recovery", () => {
  it("a blank line closes unterminated delimited math", () => {
    expect(mode("oops $x\n\nnew paragraph |")).toBe("text");
    expect(mode("oops \\[x\n\n|")).toBe("text");
  });
  it("typing on a blank line inside \\[ \\] is still math", () => {
    expect(mode("\\[\n|\n\\]")).toBe("display");
  });
  it("blank lines don't close environments", () => {
    expect(mode("\\begin{align}\n\nx|\n\\end{align}")).toBe("display");
  });
});

describe("scanField (incremental)", () => {
  const sample = [
    "\\documentclass{article}", "\\begin{document}", "Text with $x^2$ and \\(y\\).", "\\[", "  a + b", "\\]",
    "\\begin{align*}", "  x &= 1 \\\\", "  \\text{so } y &= 2", "\\end{align*}", "% comment $", "\\begin{lstlisting}",
    "print('$')", "\\end{lstlisting}", "Done.", "\\end{document}",
  ].join("\n");

  function check(state: EditorState) {
    const expected = scanDocument(state.doc.toString().split("\n"));
    const actual = state.field(scanField).states;
    expect(actual.length).toBe(expected.length);
    actual.forEach((s: ScanState, i: number) => expect(statesEqual(s, expected[i]), `line ${i + 1}`).toBe(true));
  }

  it("matches a full rescan after random edits", () => {
    let state = EditorState.create({ doc: sample, extensions: [scanField] });
    const inserts = ["$", "\\[", "\\]", "\n", "\\begin{align}", "\\end{align}", "x", "%", "\\text{", "}", "\n\n", "\\(", "\\)"];
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; i < 400; i++) {
      const len = state.doc.length;
      const from = rand(len + 1);
      const to = Math.min(len, from + (rand(3) === 0 ? rand(6) : 0));
      state = state.update({ changes: { from, to, insert: inserts[rand(inserts.length)] } }).state;
      check(state);
    }
  });

  it("contextAt reads mode and env stack at a position", () => {
    const state = EditorState.create({ doc: sample, extensions: [scanField] });
    const pos = state.doc.line(8).from + 4;
    expect(contextAt(state, pos)).toMatchObject({ mode: "display", envStack: ["document", "align*"] });
  });

  it("is fast enough for a 2,000-line file", () => {
    const lines: string[] = ["\\begin{document}"];
    for (let i = 0; i < 2000; i++) lines.push(i % 5 === 0 ? "\\begin{align*} x_{" + i + "} &= \\text{y} \\end{align*}" : `Line ${i} with $a_${i}$ and \\(b\\) % note`);
    lines.push("\\end{document}");
    let state = EditorState.create({ doc: lines.join("\n"), extensions: [scanField] });
    const mid = state.doc.line(1000).from + 5;
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      state = state.update({ changes: { from: mid + i, insert: "x" } }).state;
      contextAt(state, mid + i + 1);
    }
    const perKeystroke = (performance.now() - t0) / 200;
    expect(perKeystroke).toBeLessThan(1);
    // A delimiter that changes every following line still has to finish quickly.
    const t1 = performance.now();
    state = state.update({ changes: { from: state.doc.line(10).from, insert: "\\begin{lstlisting}" } }).state;
    expect(performance.now() - t1).toBeLessThan(20);
  });

  it("initial state is text with no environments", () => {
    expect(modeOf(initialState)).toBe("text");
    expect(envStackOf(initialState)).toEqual([]);
  });
});
