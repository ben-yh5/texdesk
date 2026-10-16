import { describe, expect, it } from "vitest";
import { undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { describeLanguage, findCodeBlocks, insertCodeBlock, lastLanguage } from "../src/editor/codeblocks";
import { taboutTarget } from "../src/editor/tabout";
import { scanField } from "../src/scanner/field";
import { editor, fixtureFiles, press, runtimeFrom, select, show, type } from "./helpers";

const rt = () => runtimeFrom(fixtureFiles("snippets"));
const none = () => runtimeFrom([]);

/** Where Tab would move the cursor (with `|` marking the cursor), as a marked string. */
function tabout(doc: string): string {
  const c = doc.indexOf("|");
  const text = doc.slice(0, c) + doc.slice(c + 1);
  const state = EditorState.create({ doc: text, extensions: [scanField] });
  const t = taboutTarget(state, c);
  return t === null ? "(none)" : text.slice(0, t) + "|" + text.slice(t);
}

describe("tabout", () => {
  it("exits braces, parens and brackets in math", () => {
    expect(tabout("$\\frac{a|}{b}$")).toBe("$\\frac{a}{|b}$"); // into the next argument
    expect(tabout("$\\frac{a}{b|} + c$")).toBe("$\\frac{a}{b}| + c$");
    expect(tabout("$f(x| + 1)$")).toBe("$f(x + 1)|$");
    expect(tabout("$[0, 1|]$")).toBe("$[0, 1]|$");
  });
  it("skips nested groups", () => {
    expect(tabout("$\\sqrt{a^{2}| + b^{2}}$")).toBe("$\\sqrt{a^{2} + b^{2}}|$");
    expect(tabout("$\\sqrt{|a^{2} + b^{2}} + c$")).toBe("$\\sqrt{a^{2} + b^{2}}| + c$");
  });
  it("exits the math region when no group is open", () => {
    expect(tabout("text \\(x + y|\\) more")).toBe("text \\(x + y\\)| more");
    expect(tabout("$x|$ more")).toBe("$x$| more");
    expect(tabout("$$x|$$ more")).toBe("$$x$$| more");
    expect(tabout("\\[\n x|\n\\]\nafter")).toBe("\\[\n x\n\\]|\nafter");
    expect(tabout("\\begin{align*}\n x &= 1|\n\\end{align*}\n")).toBe("\\begin{align*}\n x &= 1\n\\end{align*}|\n");
  });
  it("exits an inner matrix environment before the math region", () => {
    expect(tabout("\\[\\begin{pmatrix} a| \\end{pmatrix} \\]")).toBe("\\[\\begin{pmatrix} a \\end{pmatrix}| \\]");
  });
  it("treats \\right) as a closer and escaped braces as text", () => {
    expect(tabout("$\\left( x| \\right) y$")).toBe("$\\left( x \\right)| y$");
    expect(tabout("$\\{ x| \\} y$")).toBe("$\\{ x \\} y$|");
  });
  it("in text, only exits braces", () => {
    expect(tabout("\\section{Intro|} text")).toBe("\\section{Intro}| text");
    expect(tabout("plain (paren|) text")).toBe("(none)");
    expect(tabout("\\begin{itemize}\n\\item a|\n\\end{itemize}")).toBe("(none)");
    expect(tabout("\\begin{document}\nhello|\n\\end{document}")).toBe("(none)");
  });
  it("doesn't cross a paragraph break in text", () => {
    expect(tabout("\\textbf{a|\n\nb}")).toBe("(none)");
  });
  it("\\text{} inside math exits the \\text group", () => {
    expect(tabout("$a \\text{if| b} c$")).toBe("$a \\text{if b}| c$");
  });
  it("no tabout in code", () => {
    expect(tabout("\\begin{lstlisting}\nf(x|)\n\\end{lstlisting}")).toBe("(none)");
  });
  it("Shift+Tab goes back a slot in math", () => {
    const back = (doc: string) => {
      const v = editor(doc, none());
      if (!press(v, "Shift-Tab")) return "(none)";
      return show(v);
    };
    expect(back("$\\frac{a}{b|}$")).toBe("$\\frac{a}{|b}$");
    expect(back("$\\frac{a}{|b}$")).toBe("$\\frac{a|}{b}$");
    expect(back("$\\frac{a|}{b}$")).toBe("|$\\frac{a}{b}$");
    expect(back("$\\left( \\frac{1}{2} \\right)^n|$")).toBe("$\\left( \\frac{1}{2} \\right)|^n$");
    expect(back("$\\left( \\frac{1}{2} \\right)|^n$")).toBe("$\\left( \\frac{1}{2}| \\right)^n$");
    expect(back("$a$ and \\(x^{2} + \\{y\\}|\\) more")).toBe("$a$ and \\(x^{2}| + \\{y\\}\\) more");
    expect(back("\\begin{align*}\n  x &= \\sqrt{2}\\\\\n  y|\n\\end{align*}")).toBe("\\begin{align*}\n  x &= \\sqrt{2}|\\\\\n  y\n\\end{align*}");
    // Not in text, where Shift+Tab still dedents.
    expect(back("  \\textbf{a|}")).not.toContain("|\\textbf");
  });
  it("Tab never stops where the cursor already is (nested snippets)", () => {
    const r = runtimeFrom([{ name: "s.ts", code: `import { snippets, s } from "texdesk";
export default snippets([
  s("mk", "\\\\($1\\\\)", { mode: "text", auto: true }),
  s("sqrt", "\\\\sqrt{ $1 }$2", { mode: "math", auto: true }),
]);` }]);
    const v = editor("Let |.", r);
    type(v, "mksqrt");
    type(v, "x");
    expect(show(v)).toBe("Let \\(\\sqrt{ x| }\\).");
    press(v, "Tab");
    expect(show(v)).toBe("Let \\(\\sqrt{ x }|\\).");
    press(v, "Tab"); // sqrt's exit is here too: straight out of \(…\)
    expect(show(v)).toBe("Let \\(\\sqrt{ x }\\)|.");
  });
  it("Tab after the last tab stop tabs out", () => {
    // A matrix with several cells: Tab visits them, then exits. (In a one-cell matrix, which
    // you fill in freely, Tab adds a column instead; see packs.test.ts.)
    const v = editor("$|$ after", rt());
    type(v, "pmat12");
    type(v, "x");
    press(v, "Tab");
    type(v, "y");
    press(v, "Tab"); // exit snippet ($0 after \end{pmatrix})
    press(v, "Tab"); // tabout of $…$
    expect(show(v)).toBe("$\\begin{pmatrix}\nx & y\n\\end{pmatrix}$| after");
  });
  it("a user Tab key handler still wins over tabout", () => {
    const v = editor("\\begin{align*}\n  x |\n\\end{align*}", rt());
    press(v, "Tab");
    expect(show(v)).toBe("\\begin{align*}\n  x  & |\n\\end{align*}");
  });
});

describe("lists", () => {
  it("Enter, Tab and Backspace on an \\item line type as usual (list helpers are a plugin's job)", () => {
    const doc = "\\begin{itemize}\n  \\item |\n\\end{itemize}";
    for (const key of ["Enter", "Backspace"]) expect(press(editor(doc, none()), key)).toBe(false);
    const v = editor("\\begin{itemize}\n  \\item |\n\\end{itemize}", none());
    press(v, "Tab");
    expect(show(v)).toBe("\\begin{itemize}\n  \\item   |\n\\end{itemize}");
  });
});

describe("code mode", () => {
  const block = (body: string) => `\\begin{lstlisting}[language=Python]\n${body}\n\\end{lstlisting}`;

  it("auto-closes brackets and quotes, and types over closers", () => {
    const v = editor(block("x = |"), none());
    type(v, "f(");
    expect(show(v)).toBe(block("x = f(|)"));
    type(v, '"a');
    expect(show(v)).toBe(block('x = f("a|")'));
    type(v, '")');
    expect(show(v)).toBe(block('x = f("a")|'));
  });
  it("doesn't pair an apostrophe after a letter", () => {
    const v = editor(block("# it|"), none());
    type(v, "'s");
    expect(show(v)).toBe(block("# it's|"));
  });
  it("brackets don't auto-close outside code", () => {
    const v = editor("text |", none());
    type(v, "(");
    expect(show(v)).toBe("text (|");
  });
  it("Enter keeps indentation; Tab indents; Shift+Tab dedents", () => {
    const v = editor(block("def f():\n    return 1|"), none());
    press(v, "Enter");
    expect(show(v)).toBe(block("def f():\n    return 1\n    |"));
    press(v, "Tab");
    expect(show(v)).toBe(block("def f():\n    return 1\n      |"));
  });
  it("snippets don't fire in code unless they ask for it", () => {
    const v = editor(block("|"), rt());
    type(v, "mk");
    expect(show(v)).toBe(block("mk|"));
  });
  it("finds blocks and their languages", () => {
    const doc = "a\n\\begin{lstlisting}[language=Python, numbers=none]\nx\n\\end{lstlisting}\n\\begin{minted}{java}\ny\n\\end{minted}\n\\begin{verbatim}\nz\n\\end{verbatim}";
    expect(findCodeBlocks(doc).map((b) => [doc.slice(b.from, b.to), b.lang])).toEqual([["x\n", "Python"], ["y\n", "java"], ["z\n", null]]);
  });
  it("maps listings language names to CodeMirror languages", () => {
    expect(describeLanguage("Python")?.name).toBe("Python");
    expect(describeLanguage("C++")?.name).toBe("C++");
    expect(describeLanguage("bash")?.name).toBe("Shell");
    expect(describeLanguage("SQL")?.name).toBe("SQL");
    expect(describeLanguage("[Sharp]C")?.name).toBe("C");
    expect(describeLanguage("nonsense")).toBe(null);
  });
});

describe("Paste as code", () => {
  it("inserts the code verbatim on its own lines, as one undo step", () => {
    const v = editor("Here: |\nnext", none());
    insertCodeBlock(v, "def f(x):\n\treturn '$x%'\n", "Python");
    expect(show(v)).toBe("Here: \n\\begin{lstlisting}[language=Python]\ndef f(x):\n\treturn '$x%'\n\\end{lstlisting}|\nnext");
    undo(v);
    expect(show(v)).toBe("Here: |\nnext");
  });
  it("keeps the surrounding indentation for the fence lines, and no option without a language", () => {
    const v = editor("  |", none());
    insertCodeBlock(v, "SELECT 1;", null);
    expect(v.state.doc.toString()).toBe("  \\begin{lstlisting}\nSELECT 1;\n  \\end{lstlisting}");
  });
  it("defaults to the last language used in the file", () => {
    const v = editor("\\begin{lstlisting}[language=Java]\nx\n\\end{lstlisting}\n|", none());
    expect(lastLanguage(v.state)).toBe("Java");
  });
  it("pasted code doesn't trigger snippets", () => {
    const v = editor("|", rt());
    insertCodeBlock(v, "mk pmat23", null);
    expect(v.state.doc.toString()).toContain("mk pmat23");
  });
});

describe("debug log", () => {
  it("records filtered candidates and outcomes for each keystroke", () => {
    const r = rt();
    const v = editor("$|$", r);
    type(v, "m");
    type(v, "k");
    expect(r.lastLog?.filtered).toEqual([expect.objectContaining({ label: '"mk"', reason: "mode is inline" })]);
    type(v, "q");
    expect(r.lastLog).toMatchObject({ event: "typed", attempts: [], filtered: [] });
    select(v, 1, 3);
  });
});

import { EditorView } from "@codemirror/view";
import { editorState } from "../src/editor/setup";
import { SnippetRuntime } from "../src/snippets/runtime";
import { settle } from "./helpers";

describe("code block highlighting", () => {
  it("highlights the body with the block's language and leaves LaTeX highlighting out of it", async () => {
    const doc = "Text $x$ % comment\n\\begin{lstlisting}[language=Python]\ndef f():\n    return '$not math$'  # note\n\\end{lstlisting}\n";
    const view = new EditorView({
      state: editorState({ doc, tex: true, runtime: new SnippetRuntime(), onUpdate: () => {}, onSave: () => {} }),
      parent: document.body,
    });
    for (let i = 0; i < 100 && !view.contentDOM.querySelector(".cm-ck"); i++) await settle(20);
    const lines = [...view.contentDOM.querySelectorAll(".cm-line")];
    const body = lines.slice(2, 4);
    expect(body.every((l) => l.classList.contains("cm-codeblock"))).toBe(true);
    expect(lines[0].classList.contains("cm-codeblock")).toBe(false);
    const kw = [...view.contentDOM.querySelectorAll(".cm-ck")].map((e) => e.textContent);
    expect(kw).toEqual(expect.arrayContaining(["def", "return"]));
    expect([...view.contentDOM.querySelectorAll(".cm-cs")].map((e) => e.textContent)).toContain("'$not math$'");
    expect([...view.contentDOM.querySelectorAll(".cm-cc")].map((e) => e.textContent)).toContain("# note");
    // The LaTeX comment on line 1 is still styled by the LaTeX highlighter (some class on it).
    expect(lines[0].querySelector("span:last-child")?.className).toBeTruthy();
    view.destroy();
  });
});
