import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { replaceAll, searchPanelOpen, setSearchQuery, SearchQuery } from "@codemirror/search";
import { editorState } from "../src/editor/setup";
import { openFind } from "../src/editor/search";
import { runtimeFrom } from "./helpers";
import { searchFile, searchFiles, snippet } from "../src/workspace/search";

const ed = (doc: string) =>
  new EditorView({ state: editorState({ doc, tex: true, runtime: runtimeFrom([]), onUpdate() {}, onSave() {} }), parent: document.body });

describe("find and replace", () => {
  it("⌘F (Ctrl+F off the Mac) opens the panel with the selection as the query", () => {
    const v = ed("one two one");
    v.dispatch({ selection: { anchor: 4, head: 7 } });
    v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(searchPanelOpen(v.state)).toBe(true);
    expect(v.dom.querySelector<HTMLInputElement>(".cm-search input[name=search]")!.value).toBe("two");
  });

  it("find and replace focuses the replace field, and replaces", () => {
    const v = ed("one two one");
    openFind(v, true);
    expect(document.activeElement).toBe(v.dom.querySelector(".cm-search input[name=replace]"));
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "one", replace: "1" })) });
    replaceAll(v);
    expect(v.state.doc.toString()).toBe("1 two 1");
  });
});

describe("search in files", () => {
  const files = [searchFile("/w/a.tex", "Hello world\n  hello again"), searchFile("/w/b.tex", "nothing\nHELLO hello")];

  it("finds every match, file by file, ignoring case for a lowercase query", () => {
    expect(searchFiles(files, "hello").map((h) => `${h.path}:${h.line}:${h.from}`)).toEqual(["/w/a.tex:1:0", "/w/a.tex:2:2", "/w/b.tex:2:0", "/w/b.tex:2:6"]);
  });

  it("matches case when the query has a capital, and stops at the limit", () => {
    expect(searchFiles(files, "HELLO").map((h) => h.path)).toEqual(["/w/b.tex"]);
    expect(searchFiles(files, "hello", 2)).toHaveLength(2);
    expect(searchFiles(files, "")).toEqual([]);
  });

  it("trims a long line around the match", () => {
    const text = "x".repeat(300) + "needle" + "y".repeat(300);
    const [hit] = searchFiles([searchFile("/f.tex", text)], "needle");
    const s = snippet(hit, 40);
    expect(s.text.slice(s.from, s.to)).toBe("needle");
    expect(s.text.startsWith("…") && s.text.endsWith("…")).toBe(true);
    const short = snippet(searchFiles([searchFile("/f.tex", "    \\item needle")], "needle")[0]);
    expect(short).toEqual({ text: "\\item needle", from: 6, to: 12 });
  });
});
