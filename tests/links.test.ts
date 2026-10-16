import { describe, expect, it } from "vitest";
import { MovedFileContext, findLinks, linkAt, linkTargetFor, outgoingLinks, resolveLink, rewriteLinks } from "../src/workspace/links";

const W = "/W";
const files = new Set([
  "/W/Fa30/1-CS101/hw/hw1.tex",
  "/W/Fa30/1-CS101/hw/hw2.tex",
  "/W/Fa30/1-CS101/hw/code/solve.py",
  "/W/Fa30/1-CS101/notes/lecture3.tex",
  "/W/Fa30/1-CS101/figures/plot.png",
  "/W/Fa30/2-MATH210/notes/lecture3.tex",
  "/W/hw.sty",
]);
const ctx = { root: W, files };
const hw1 = "/W/Fa30/1-CS101/hw/hw1.tex";

describe("finding links", () => {
  it("finds link-like commands with the target's offsets, skipping comments", () => {
    const text = "See \\link[Lecture]{../notes/lecture3} and \\input{ parts/a }.\n% \\link{commented}\n\\lstinputlisting[language=Python]{code/solve.py} 50\\% \\url{https://x.org}";
    const refs = findLinks(text);
    expect(refs.map((r) => [r.command, r.target, text.slice(r.from, r.to)])).toEqual([
      ["link", "../notes/lecture3", "../notes/lecture3"],
      ["input", "parts/a", "parts/a"],
      ["lstinputlisting", "code/solve.py", "code/solve.py"],
      ["url", "https://x.org", "https://x.org"],
    ]);
  });

  it("finds the link under a position on a line", () => {
    const line = "x \\link{hw2} y \\includegraphics[width=1in]{plot}";
    expect(linkAt(line, 4)?.target).toBe("hw2");
    expect(linkAt(line, 9)?.target).toBe("hw2");
    expect(linkAt(line, 14)).toBeNull();
    expect(linkAt(line, line.length - 2)).toMatchObject({ command: "includegraphics", target: "plot" });
  });
});

describe("resolving links", () => {
  it("relative to the file, adding .tex", () => {
    expect(resolveLink({ command: "link", target: "../notes/lecture3" }, hw1, ctx)).toEqual({ kind: "file", path: "/W/Fa30/1-CS101/notes/lecture3.tex" });
    expect(resolveLink({ command: "input", target: "./hw2.tex" }, hw1, ctx)).toEqual({ kind: "file", path: "/W/Fa30/1-CS101/hw/hw2.tex" });
    expect(resolveLink({ command: "lstinputlisting", target: "code/solve.py" }, hw1, ctx)).toEqual({ kind: "file", path: "/W/Fa30/1-CS101/hw/code/solve.py" });
  });

  it("relative to the workspace root and search folders", () => {
    expect(resolveLink({ command: "link", target: "hw.sty" }, hw1, ctx)).toEqual({ kind: "file", path: "/W/hw.sty" });
    expect(resolveLink({ command: "includegraphics", target: "plot" }, hw1, { ...ctx, searchDirs: ["/W/Fa30/1-CS101/figures"] }))
      .toEqual({ kind: "file", path: "/W/Fa30/1-CS101/figures/plot.png" });
  });

  it("a bare \\link name finds the file anywhere, preferring the nearest", () => {
    expect(resolveLink({ command: "link", target: "lecture3" }, hw1, ctx)).toEqual({ kind: "file", path: "/W/Fa30/1-CS101/notes/lecture3.tex" });
    expect(resolveLink({ command: "link", target: "lecture3" }, "/W/Fa30/2-MATH210/hw/hw1.tex", ctx)).toEqual({ kind: "file", path: "/W/Fa30/2-MATH210/notes/lecture3.tex" });
    // Only \link searches the whole workspace.
    expect(resolveLink({ command: "input", target: "lecture3" }, hw1, ctx)).toBeNull();
  });

  it("../ paths are relative to the file only, never to a search folder", () => {
    const figures = { ...ctx, searchDirs: ["/W/Fa30/1-CS101/figures"] };
    // From figures/, ../hw/hw2 would land on a real file; from notes/week1/ it's nothing.
    expect(resolveLink({ command: "input", target: "../hw/hw2" }, "/W/Fa30/1-CS101/notes/week1/x.tex", figures)).toBeNull();
  });

  it("URLs, anchors, escapes and misses", () => {
    expect(resolveLink({ command: "href", target: "https://example.com" }, hw1, ctx)).toEqual({ kind: "url", url: "https://example.com" });
    expect(resolveLink({ command: "link", target: "hw2#question-3" }, hw1, ctx)).toEqual({ kind: "file", path: "/W/Fa30/1-CS101/hw/hw2.tex" });
    expect(resolveLink({ command: "link", target: "file:./hw2.tex" }, hw1, ctx)).toEqual({ kind: "file", path: "/W/Fa30/1-CS101/hw/hw2.tex" });
    expect(resolveLink({ command: "link", target: "nope" }, hw1, ctx)).toBeNull();
  });
});

describe("backlinks", () => {
  it("lists a file's links to other files, with lines", () => {
    const text = "\\documentclass{article}\n\\usepackage{hw}\nSee \\link{lecture3}.\n\\link{https://x.org} \\link{hw1} \\link{missing}";
    expect(outgoingLinks(text, hw1, ctx)).toEqual([
      { path: "/W/Fa30/1-CS101/notes/lecture3.tex", line: 3, text: "See \\link{lecture3}." },
    ]);
  });

  it("new links are relative and drop .tex", () => {
    expect(linkTargetFor(hw1, "/W/Fa30/1-CS101/notes/lecture3.tex")).toBe("../notes/lecture3");
    expect(linkTargetFor(hw1, "/W/Fa30/1-CS101/hw/hw2.tex")).toBe("hw2");
    expect(linkTargetFor(hw1, "/W/Fa30/1-CS101/hw/code/solve.py")).toBe("code/solve.py");
  });
});

describe("updating links after a move", () => {
  /** Context for `file` after moving `from` → `to` (a file or a folder). */
  function moveCtx(file: string, from: string, to: string): MovedFileContext {
    const moved = (p: string) => (p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : null);
    const after = new Set([...files].map((f) => moved(f) ?? f));
    const back = (p: string) => (p === to || p.startsWith(to + "/") ? from + p.slice(to.length) : p);
    return { oldFile: back(file), newFile: file, before: { root: W, files }, after: { root: W, files: after }, moved };
  }
  const lecture = "/W/Fa30/1-CS101/notes/lecture3.tex";

  it("links to a moved file point to its new place; bare names and labels are left alone", () => {
    const text = "\\link[Lecture]{../notes/lecture3} \\input{../notes/lecture3.tex#sec} \\link{lecture3} \\link{hw2} \\href{https://x.org}{x}";
    const r = rewriteLinks(text, moveCtx(hw1, lecture, "/W/Fa30/1-CS101/notes/week1/lecture3.tex"));
    expect(r).toEqual({
      count: 2,
      text: "\\link[Lecture]{../notes/week1/lecture3} \\input{../notes/week1/lecture3.tex#sec} \\link{lecture3} \\link{hw2} \\href{https://x.org}{x}",
    });
  });

  it("a moved file's own relative links are rebased", () => {
    const moved = "/W/Fa30/1-CS101/archive/hw1.tex";
    const text = "\\lstinputlisting{code/solve.py}\n\\link{hw2}\n\\link{../notes/lecture3}\n\\link{hw.sty}";
    const r = rewriteLinks(text, moveCtx(moved, hw1, moved));
    // \\link{hw2} still finds hw2.tex by name, so it stays as written.
    expect(r.text).toBe("\\lstinputlisting{../hw/code/solve.py}\n\\link{hw2}\n\\link{../notes/lecture3}\n\\link{hw.sty}");
    expect(r.count).toBe(1);
  });

  it("moving a whole folder keeps links inside it, and fixes links into it", () => {
    const from = "/W/Fa30/1-CS101/hw";
    const to = "/W/Fa30/1-CS101/psets";
    const inside = rewriteLinks("\\link{hw2} \\lstinputlisting{code/solve.py} \\link{../notes/lecture3}", moveCtx(`${to}/hw1.tex`, from, to));
    expect(inside.count).toBe(0);
    const outside = rewriteLinks("\\link{../hw/hw2} and \\link{hw2}", moveCtx(lecture, from, to));
    expect(outside.text).toBe("\\link{../psets/hw2} and \\link{hw2}");
  });

  it("links that were already broken, and commented-out ones, are left alone", () => {
    const r = rewriteLinks("\\link{nowhere} % \\link{../notes/lecture3}", moveCtx(hw1, lecture, "/W/elsewhere/lecture3.tex"));
    expect(r.count).toBe(0);
  });
});
