import { describe, expect, it } from "vitest";
import { parseDictionary, proseWords, rankSuggestions, wordsToCheck } from "../src/editor/spelling";
import { indentColumns } from "../src/editor/wrapindent";

const words = (text: string) => proseWords(text).map((w) => w.word);

describe("prose words", () => {
  it("skips math, code, comments and command names, keeping text inside \\text{}", () => {
    expect(words("The probabilty $P(\\text{evnt}) = x$ is \\emph{smal}. % a cmment\n\\[ \\frac{ab}{cd} \\]"))
      .toEqual(["The", "probabilty", "evnt", "is", "smal"]);
    expect(words("Run \\verb|pritn| or\n\\begin{lstlisting}\nprint(helo)\n\\end{lstlisting}\ndone")).toEqual(["Run", "or", "done"]);
  });

  it("skips the preamble and arguments that aren't prose", () => {
    const doc = "\\documentclass{article}\n\\usepackage{amsmath}\n\\title{Ignord}\n\\begin{document}\nSee \\ref{sec:intrdo}, \\cite[p.~3]{knuth} and \\includegraphics[width=2in]{plto}.";
    expect(words(doc)).toEqual(["See", "and"]);
  });

  it("checks a \\link label but not its target", () => {
    expect(words("Read \\link[Problme set]{../hw/hw2} now")).toEqual(["Read", "Problme", "set", "now"]);
  });

  it("leaves out acronyms, CamelCase, single letters and pieces of 2nd or x2", () => {
    expect(words("A NASA iPhone LaTeX 2nd x2 don't café")).toEqual(["iPhone", "don't", "café"]);
  });

  it("reports offsets into the whole text", () => {
    const text = "\\begin{document}\nhi tehre";
    const w = proseWords(text).find((x) => x.word === "tehre")!;
    expect(text.slice(w.from, w.to)).toBe("tehre");
  });

  it("asks about each word once, minus the dictionary", () => {
    const dict = parseDictionary("# mine\nTectonic\nsynctex\n\n");
    expect(wordsToCheck(proseWords("tectonic Tectonic synctex SyncTeX foo foo"), dict)).toEqual(["foo"]);
  });

  it("ranks the autocorrection first", () => {
    expect(rankSuggestions(["teh", "the", "ten"], "the")).toEqual(["the", "teh", "ten"]);
    expect(rankSuggestions(["the", "ten"], "tea")).toEqual(["tea", "the", "ten"]);
    expect(rankSuggestions(["the", "ten"], null)).toEqual(["the", "ten"]);
  });
});

describe("wrapped-line indent", () => {
  it("counts the leading whitespace in columns", () => {
    expect(indentColumns("    \\item x", 4)).toBe(4);
    expect(indentColumns("\t  x", 4)).toBe(6);
    expect(indentColumns("  \tx", 4)).toBe(4);
    expect(indentColumns("x  ", 4)).toBe(0);
  });
});
