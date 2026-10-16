import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { BracketOptions, brackets, cycleBracketSize, delimiters, pairs } from "../src/editor/brackets";
import { snippetExtension } from "../src/snippets/cm";
import { press, runtimeFrom, settle, show, type } from "./helpers";

function ed(doc: string, opts: Partial<BracketOptions> = {}): EditorView {
  const c = doc.indexOf("|");
  const state = EditorState.create({
    doc: doc.slice(0, c) + doc.slice(c + 1),
    selection: EditorSelection.single(c),
    extensions: [history(), indentUnit.of("  "), brackets({ autoPair: true, autoEnlarge: true, ...opts }), snippetExtension(runtimeFrom([]))],
  });
  return new EditorView({ state, parent: document.body });
}

describe("finding brackets", () => {
  it("pairs plain, \\{ \\}, \\left/\\right and sized bars; \\( \\) aren't brackets", () => {
    const t = "\\( \\left( \\frac{a}{b} \\right] + [x] + \\{y\\} + \\big| z \\big| + f(x) \\)";
    const got = pairs(delimiters(t)).map((p) => t.slice(p.open.from, p.open.to) + "…" + t.slice(p.close.from, p.close.to));
    expect(got.sort()).toEqual(["(…)", "[…]", "\\big|…\\big|", "\\left(…\\right]", "\\{…\\}"].sort());
  });
});

describe("typing", () => {
  it("a closer that's already there is stepped over when the line balances", () => {
    const v = ed("\\( f(x|) \\)");
    type(v, ")");
    expect(show(v)).toBe("\\( f(x)| \\)");
    const u = ed("\\( ((x|) \\)");
    type(u, ")");
    expect(show(u)).toBe("\\( ((x)|) \\)");
  });

  it("{ pairs in text unless a letter follows; \\{ pairs everywhere", () => {
    const v = ed("\\textbf|");
    type(v, "{");
    expect(show(v)).toBe("\\textbf{|}");
    type(v, "hi}");
    expect(show(v)).toBe("\\textbf{hi}|");
    const w = ed("x |abc");
    type(w, "{");
    expect(show(w)).toBe("x {|abc");
    const m = ed("\\( |x \\)");
    type(m, "\\{");
    expect(show(m)).toBe("\\( \\{|\\}x \\)");
  });

  it("auto pairing can be turned off", () => {
    const v = ed("\\textbf|", { autoPair: false });
    type(v, "{");
    expect(show(v)).toBe("\\textbf{|");
  });
});

describe("Backspace in an empty pair", () => {
  it("deletes both halves", () => {
    for (const [doc, after] of [
      ["\\( (|) \\)", "\\(  \\)"], ["\\( \\left(|\\right) \\)", "\\(  \\)"], ["\\( \\{|\\} \\)", "\\(  \\)"], ["\\textbf{|}", "\\textbf"],
    ]) {
      const v = ed(doc);
      press(v, "Backspace");
      expect(show(v)).toBe(after.replace("  ", " | ").replace(/^(\\textbf)$/, "$1|"));
    }
  });
  it("leaves non-empty pairs alone", () => {
    expect(press(ed("\\( (x|) \\)"), "Backspace")).toBe(false);
  });
});

describe("auto-enlarge", () => {
  it("closing a bracket around \\frac makes it \\left…\\right", async () => {
    const v = ed("\\[ (\\frac{1}{2}| \\]");
    type(v, ")");
    await settle(5);
    expect(show(v)).toBe("\\[ \\left(\\frac{1}{2}\\right)| \\]");
    undo(v);
    expect(show(v)).toBe("\\[ (\\frac{1}{2})| \\]"); // one undo takes back just the enlarging
  });

  it("also when stepping over or tabbing out of the closer", async () => {
    const v = ed("\\[ (\\sum x|) \\]");
    type(v, ")");
    await settle(5);
    expect(show(v)).toBe("\\[ \\left(\\sum x\\right)| \\]");
    const t = ed("\\[ [\\int f|] \\]");
    press(t, "Tab");
    expect(show(t)).toBe("\\[ \\left[\\int f\\right]| \\]");
  });

  it("leaves plain contents, text and sized brackets alone, and can be turned off", async () => {
    for (const doc of ["\\[ (a+b| \\]", "(\\frac| text", "\\[ \\big(\\frac{1}{2}| \\]"]) {
      const v = ed(doc);
      type(v, ")");
      await settle(5);
      expect(show(v)).toBe(doc.replace("|", ")|").replace("\\big(\\frac{1}{2})", "\\big(\\frac{1}{2})"));
    }
    const off = ed("\\[ (\\frac{1}{2}| \\]", { autoEnlarge: false });
    type(off, ")");
    await settle(5);
    expect(show(off)).toBe("\\[ (\\frac{1}{2})| \\]");
  });
});

describe("cycling bracket size", () => {
  it("( ) → \\left( \\right) → \\big → \\Big → \\bigg → \\Bigg → ( )", () => {
    const v = ed("\\[ (a|+b) \\]");
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) { cycleBracketSize(v); seen.push(v.state.doc.toString()); }
    expect(seen).toEqual([
      "\\[ \\left(a+b\\right) \\]", "\\[ \\big(a+b\\big) \\]", "\\[ \\Big(a+b\\Big) \\]",
      "\\[ \\bigg(a+b\\bigg) \\]", "\\[ \\Bigg(a+b\\Bigg) \\]", "\\[ (a+b) \\]",
    ]);
  });
  it("works on \\{ \\} and the innermost pair", () => {
    const v = ed("\\[ \\{ x : (a|) \\} \\]");
    cycleBracketSize(v);
    expect(v.state.doc.toString()).toBe("\\[ \\{ x : \\left(a\\right) \\} \\]");
    const w = ed("\\[ \\{ x| : a \\} \\]");
    cycleBracketSize(w);
    expect(w.state.doc.toString()).toBe("\\[ \\left\\{ x : a \\right\\} \\]");
  });
});

describe("\\begin / \\end", () => {
  it("renaming one end renames the other, as one undo step", () => {
    const v = ed("\\begin{align|}\nx\n\\end{align}");
    type(v, "*");
    expect(v.state.doc.toString()).toBe("\\begin{align*}\nx\n\\end{align*}");
    const w = ed("\\begin{itemize}\n\\begin{enumerate}\n\\end{enumerate}\n\\end{itemiz|e}");
    // A Backspace (the test editor has no default keymap, so delete as CodeMirror would).
    const at = w.state.selection.main.head;
    w.dispatch({ changes: { from: at - 1, to: at }, userEvent: "delete.backward" });
    expect(w.state.doc.toString()).toBe("\\begin{itemie}\n\\begin{enumerate}\n\\end{enumerate}\n\\end{itemie}");
    undo(w);
    expect(w.state.doc.toString()).toBe("\\begin{itemize}\n\\begin{enumerate}\n\\end{enumerate}\n\\end{itemize}");
  });

  it("the matching \\begin/\\end and \\left/\\right are highlighted", () => {
    const v = ed("\\begin{al|ign}\nx\n\\end{align}");
    expect([...v.dom.querySelectorAll(".cm-matchingEnv")].map((e) => e.textContent)).toEqual(["\\begin{align}", "\\end{align}"]);
    const w = ed("\\[ \\le|ft( x \\right) \\]");
    expect([...w.dom.querySelectorAll(".cm-matchingEnv")].map((e) => e.textContent)).toEqual(["\\left(", "\\right)"]);
  });
});
