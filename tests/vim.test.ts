import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { Vim, getCM } from "@replit/codemirror-vim";
import { editorState } from "../src/editor/setup";
import { applySettings, defaultConfig } from "../src/workspace/config";
import markdown from "../src/plugins/builtin/markdown-shortcuts.ts?raw";
import { fixtureFiles, runtimeFrom, show } from "./helpers";

function ed(doc: string, onSave = () => {}, runtime = runtimeFrom(fixtureFiles("snippets"))): EditorView {
  const state = editorState({
    doc, tex: true, runtime, onUpdate() {}, onSave,
    settings: { ...defaultConfig.editor, vim: true },
  });
  return new EditorView({ state, parent: document.body });
}

/** Sends real keydown events (vim listens on the DOM, not through keymaps). */
function keys(view: EditorView, seq: string[]) {
  for (const key of seq) view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("vim mode", () => {
  it("is off by default and read from editor.vim", () => {
    expect(defaultConfig.editor.vim).toBe(false);
    expect(applySettings(defaultConfig, { editor: { vim: true } }, [], "test").editor.vim).toBe(true);
  });
  it("normal-mode commands edit the document", () => {
    const v = ed("one two three");
    keys(v, ["w", "d", "w"]);
    expect(v.state.doc.toString()).toBe("one three");
    keys(v, ["u"]);
    expect(v.state.doc.toString()).toBe("one two three");
  });
  it(":w saves", () => {
    let saved = 0;
    const v = ed("x", () => saved++);
    Vim.handleEx(getCM(v) as Parameters<typeof Vim.handleEx>[0], "w");
    expect(saved).toBe(1);
  });
  it("* in visual mode runs the Markdown shortcuts' visual snippet: emphasis, then bold", () => {
    const v = ed("see this word", () => {}, runtimeFrom([{ name: "markdown.ts", code: markdown }]));
    keys(v, ["w", "v", "e", "*"]);
    expect(show(v)).toBe("see \\emph{[this]} word");
    keys(v, ["*"]);
    expect(show(v)).toBe("see \\textbf{[this]} word");
  });
  it("` in visual mode makes the selection inline code", () => {
    const v = ed("see this word", () => {}, runtimeFrom([{ name: "markdown.ts", code: markdown }]));
    keys(v, ["w", "v", "e", "`"]);
    expect(v.state.doc.toString()).toBe("see \\lstinline|this| word");
  });
});
