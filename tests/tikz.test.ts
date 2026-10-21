import { describe, expect, it } from "vitest";
import {
  addItem, deleteItem, diagramDocument, fmt, freshName, instrument, moveItem, nameItem, outdent, parsePicture, pictureAt, preambleOf, readProbes, reindent, setPoint, setText, surroundings, toUnits,
} from "../src/diagram/tikz";

const PIC = String.raw`\begin{tikzpicture}[scale=2, >=stealth]
  \node[draw, circle] (a) at (0,0) {$f(x)$};
  \node at (2, 1) {unnamed}; % a comment; with a semicolon
  \draw[->, thick] (a) -- (2,1) -- ++(1,0) node[right] {x(1,2)};
  \begin{scope}[shift={(3,0)}]
    \draw (0,0) rectangle (1,0.5);
  \end{scope}
  \foreach \i in {1,2} { \fill (\i,-1) circle (2pt); }
  \coordinate (c) at (1,-0.5);
  \node[right=of a] (b) {B};
\end{tikzpicture}`;

const summary = (src: string) => {
  const pic = parsePicture(src);
  return pic.items.map((i) => ({
    kind: i.kind, command: i.command, name: i.name, at: i.at && [i.at.x, i.at.y],
    text: i.text && src.slice(i.text.from, i.text.to), points: i.coords.map((c) => [c.x, c.y]),
  }));
};

describe("parsePicture", () => {
  it("splits the body into statements and reads nodes, coordinates and path points", () => {
    expect(summary(PIC)).toEqual([
      { kind: "node", command: "\\node", name: "a", at: [0, 0], text: "$f(x)$", points: [] },
      { kind: "node", command: "\\node", name: undefined, at: [2, 1], text: "unnamed", points: [] },
      // ++(1,0) is relative, and (1,2) is inside the node's text.
      { kind: "path", command: "\\draw", name: undefined, at: undefined, text: undefined, points: [[2, 1]] },
      { kind: "other", command: "\\begin", name: undefined, at: undefined, text: undefined, points: [] },
      { kind: "path", command: "\\draw", name: undefined, at: undefined, text: undefined, points: [[0, 0], [1, 0.5]] },
      { kind: "other", command: "\\end", name: undefined, at: undefined, text: undefined, points: [] },
      // A \foreach is one statement, body and all.
      { kind: "other", command: "\\foreach", name: undefined, at: undefined, text: undefined, points: [] },
      { kind: "coordinate", command: "\\coordinate", name: "c", at: [1, -0.5], text: undefined, points: [] },
      // Placed relative to another node: no literal position.
      { kind: "node", command: "\\node", name: "b", at: undefined, text: "B", points: [] },
    ]);
  });

  it("handles a picture with no options and an empty body", () => {
    expect(parsePicture("\\begin{tikzpicture}\n\\end{tikzpicture}").items).toEqual([]);
  });

  it("reads \\foreach with a single statement as its body", () => {
    const src = "\\begin{tikzpicture}\n\\foreach \\x in {0,1} \\draw (\\x,0) -- (\\x,1);\n\\node at (1,1) {a};\n\\end{tikzpicture}";
    expect(summary(src).map((i) => i.command)).toEqual(["\\foreach", "\\node"]);
  });
});

describe("editing", () => {
  const pic = parsePicture(PIC);
  const [a, unnamed, arrow, , rect] = pic.items;

  it("moves a node's position, keeping how the point was written", () => {
    expect(moveItem(pic, a, 0.5, -0.25)).toContain("(a) at (0.5,-0.25) {$f(x)$}");
    expect(moveItem(pic, unnamed, 1, 0)).toContain("\\node at (3, 1) {unnamed}");
  });

  it("moves all of a path's literal points, and only those", () => {
    const out = moveItem(pic, rect, 1, 1);
    expect(out).toContain("\\draw (1,1) rectangle (2,1.5);");
    expect(moveItem(pic, arrow, 1, 0)).toContain("(a) -- (3,1) -- ++(1,0) node[right] {x(1,2)}");
  });

  it("sets one point", () => {
    expect(setPoint(pic, rect.coords[1], 2, 0.75)).toContain("(0,0) rectangle (2,0.75)");
  });

  it("changes a node's text", () => {
    expect(setText(pic, a, "$g$")).toContain("(a) at (0,0) {$g$};");
  });

  it("deletes a statement with its line", () => {
    const out = deleteItem(pic, unnamed);
    expect(out).not.toContain("unnamed");
    expect(out).toContain("{$f(x)$};\n  \\draw[->, thick]");
  });

  it("adds a statement before \\end{tikzpicture}, indented like the others", () => {
    expect(addItem(pic, "\\draw (0,0) -- (1,1);")).toMatch(/\{B\};\n {2}\\draw \(0,0\) -- \(1,1\);\n\\end\{tikzpicture\}$/);
    expect(addItem(parsePicture("\\begin{tikzpicture}\n\\end{tikzpicture}"), "\\node at (0,0) {x};")).toBe("\\begin{tikzpicture}\n  \\node at (0,0) {x};\n\\end{tikzpicture}");
    expect(addItem(parsePicture("\\begin{tikzpicture}\\end{tikzpicture}"), "\\node at (0,0) {x};")).toBe("\\begin{tikzpicture}\n  \\node at (0,0) {x};\n\\end{tikzpicture}");
  });

  it("names a node so lines can connect to it", () => {
    expect(freshName(pic)).toBe("n1");
    expect(nameItem(pic, unnamed, "n1")).toContain("\\node (n1) at (2, 1) {unnamed}");
  });

  it("writes numbers short", () => {
    expect([fmt(1), fmt(0.25), fmt(1 / 3), fmt(-0.0001), fmt(2.5000001)]).toEqual(["1", "0.25", "0.333", "0", "2.5"]);
  });
});

describe("finding the picture", () => {
  const doc = "text\n% \\begin{tikzpicture} commented\n\\begin{tikzpicture}\n\\node {a};\n\\end{tikzpicture}\nafter";
  it("finds the picture around the cursor, not a commented-out one", () => {
    const span = pictureAt(doc, doc.indexOf("\\node"))!;
    expect(doc.slice(span.from, span.to)).toBe("\\begin{tikzpicture}\n\\node {a};\n\\end{tikzpicture}");
    expect(pictureAt(doc, doc.indexOf("after") + 2)).toBeNull();
    expect(pictureAt(doc, 2)).toBeNull();
  });

  it("takes the given number of lines around the picture as context", () => {
    const lines = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `l${a + i}`).join("\n");
    const text = `${lines(1, 15)}\nx \\begin{tikzpicture}\\end{tikzpicture} y\n${lines(16, 30)}`;
    const span = pictureAt(text, text.indexOf("\\end"))!;
    const around = { before: text.slice(0, span.from), after: text.slice(span.to) };
    expect(surroundings(around, 10)).toEqual({ before: `${lines(6, 15)}\nx `, after: ` y\n${lines(16, 25)}` });
    expect(surroundings(around, 0)).toEqual({ before: "x ", after: " y" });
    expect(surroundings({ before: "", after: "" }, 5)).toEqual({ before: "", after: "" });
  });

  it("takes an indented picture's indentation off its lines, and puts it back", () => {
    const pic = "\\begin{tikzpicture}\n    \\node {a};\n\n  \\end{tikzpicture}";
    expect(outdent(pic, "  ")).toBe("\\begin{tikzpicture}\n  \\node {a};\n\n\\end{tikzpicture}");
    expect(reindent(outdent(pic, "  "), "  ")).toBe(pic);
    // A rewritten picture (e.g. Claude's) gets the indentation of the line it's on.
    expect(reindent("\\begin{tikzpicture}\n  \\draw (0,0) -- (1,1);\n\\end{tikzpicture}", "\t")).toBe("\\begin{tikzpicture}\n\t  \\draw (0,0) -- (1,1);\n\t\\end{tikzpicture}");
  });

  it("takes the preamble before \\begin{document}", () => {
    expect(preambleOf("\\documentclass{article}\n\\usepackage{tikz}\n\\begin{document}\nhi\n\\end{document}")).toBe("\\documentclass{article}\n\\usepackage{tikz}\n");
    expect(preambleOf("\\section{x}")).toBe("");
  });
});

describe("the editor's build", () => {
  it("adds probes after each statement and names unnamed nodes in the built copy", () => {
    const out = instrument(parsePicture(PIC));
    expect(out).toContain("{$f(x)$};\\texdeskunits{s0}\\texdeskbox{s0}{a}");
    expect(out).toContain("\\node (texdesk-s1) at (2, 1) {unnamed};\\texdeskunits{s1}\\texdeskbox{s1}{texdesk-s1}");
    expect(out).toContain("node[right] {x(1,2)};\\texdeskunits{s2}\\texdeskout{s2.c0}{(2,1)}");
    expect(out).toContain("\\texdeskout{s7.c}{(c)}");
    expect(out).toMatch(/\\texdeskunits\{top\}\\texdeskbb\n\\end\{tikzpicture\}$/);
    // Nothing inside the \foreach.
    expect(out).toContain("\\foreach \\i in {1,2} { \\fill (\\i,-1) circle (2pt); }\n");
  });

  it("wraps the picture in a standalone document with the document's preamble", () => {
    const doc = diagramDocument("\\documentclass[11pt]{article}\n\\usepackage{amsmath}\n", "PIC");
    expect(doc).toMatch(/^\\documentclass\[tikz,border=4pt\]\{standalone\}\n\\usepackage\{amsmath\}\n\\makeatletter[^]*\\begin\{document\}\nPIC\n\\end\{document\}\n$/);
    expect(diagramDocument("", "PIC")).toContain("{standalone}\n\\usepackage{tikz}\n");
  });

  it("reads what the probes logged and converts distances to picture units", () => {
    // As TikZ logs a picture drawn at scale=2 (1 unit = 2cm = 56.905pt).
    const log = "(./diagram.tex\nTXD s0.o 0.0pt 0.0pt\nTXD s0.x 56.90549pt 0.0pt\nTXD s0.y 0.0pt 56.90549pt\nTXD bb.sw -15.68509pt -60.90549pt\n";
    const probes = readProbes(log);
    expect(probes.get("bb.sw")).toEqual({ x: -15.68509, y: -60.90549 });
    const u = toUnits(probes, "s0", 56.90549, -28.452745)!;
    expect(u.x).toBeCloseTo(1);
    expect(u.y).toBeCloseTo(-0.5);
    // Rotated 90° (a scope's rotate=90): x goes up, y goes left.
    const rot = readProbes("TXD r.o 10pt 0pt\nTXD r.x 10pt 28pt\nTXD r.y -18pt 0pt\n");
    const v = toUnits(rot, "r", 0, 28)!;
    expect(v.x).toBeCloseTo(1);
    expect(v.y).toBeCloseTo(0);
    expect(toUnits(probes, "missing", 1, 1)).toBeNull();
  });
});
