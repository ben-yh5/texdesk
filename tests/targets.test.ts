import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { SnippetRuntime } from "../src/snippets/runtime";
import { SHOW_DELAY, jumpBack, jumpTargets, jumpTo, numberedJumps } from "../src/editor/targets";
import { editor, show } from "./helpers";

const none = () => new SnippetRuntime();
const proof = [
  "\\begin{proof}",
  "  \\begin{enumerate}",
  "    \\item Let $x = 2$.",
  "    \\item Then| so \\frac{}{} holds.",
  "    \\item Hence $y$ is positive.",
  "  \\end{enumerate}",
  "\\end{proof}",
].join("\n");

/** The targets as `line:col` (1-based line, 0-based column), with ↵ for a block exit. */
function targets(v: EditorView): string[] {
  return jumpTargets(v.state, v.state.selection.main.head).map((t) => {
    const l = v.state.doc.lineAt(t.pos);
    return `${l.number}:${t.pos - l.from}${t.exit ? "↵" : ""}`;
  });
}

describe("numbered jumps", () => {
  it("numbers up to six typing spots by distance, keeping the innermost block exit", () => {
    expect(targets(editor(proof, none()))).toEqual([
      "4:10", // after \item on the same line
      "4:24", // \frac{|}{}
      "4:26", // \frac{}{|}
      "4:34", // the line's end
      "3:10", // the line above's item text
      "6:17↵", // out of the list
    ]);
  });

  it("finds the spot after inline math and in align cells", () => {
    const v = editor("\\begin{align*}\n  a &= b \\\\\n  c| &= d\n\\end{align*}\nSee $x$ here.", none());
    const t = targets(v);
    expect(t).toContain("2:5"); // after "a &"
    expect(t).toContain("3:5"); // after "c &"
    expect(t).toContain("4:12↵"); // out of align*
    expect(targets(editor("A| line with $x$ in it.", none()))).toEqual(["1:15", "1:22"]);
  });

  it("takes at most four on one side while the other has spots, else fills from it", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}.`);
    expect(targets(editor(lines.join("\n").replace("Line 1.", "Line 1.|"), none()))).toHaveLength(6);
    const mid = lines.map((l, i) => (i === 5 ? l + "|" : l)).join("\n");
    const t = targets(editor(mid, none()));
    expect(t).toHaveLength(6);
    const line = (s: string) => Number(s.split(":")[0]);
    expect(t.filter((s) => line(s) > 6).length).toBeLessThanOrEqual(4);
    expect(t.filter((s) => line(s) < 6).length).toBeLessThanOrEqual(4);
  });

  it("skips blank lines, comments and \\begin/\\end lines", () => {
    const t = targets(editor("% a comment\n\nText|\n\n\\begin{figure}\n\\end{figure}", none()));
    expect(t).toEqual([]);
  });

  it("jumps to a spot, leaves a block onto a new line, and ⌥0 goes back", () => {
    const v = editor(proof, none(), [numberedJumps]);
    jumpTo(v, 2);
    expect(show(v).split("\n")[3]).toBe("    \\item Then so \\frac{|}{} holds.");
    jumpTo(v, 99);
    jumpBack(v);
    expect(show(v).split("\n")[3]).toBe("    \\item Then| so \\frac{}{} holds.");
    jumpTo(v, 6);
    expect(show(v).split("\n").slice(5, 8)).toEqual(["  \\end{enumerate}", "  |", "\\end{proof}"]);
  });
});

describe("holding ⌥", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("shows the numbers after a short hold, jumps with ⌥+digit, and hides them on release", () => {
    const v = editor(proof, none(), [numberedJumps]);
    v.focus();
    const key = (type: string, init: KeyboardEventInit) => v.contentDOM.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
    const badges = () => [...v.contentDOM.querySelectorAll(".cm-jump-label")].map((e) => e.textContent);
    key("keydown", { key: "Alt", code: "AltLeft", altKey: true });
    expect(badges()).toEqual([]);
    vi.advanceTimersByTime(SHOW_DELAY);
    expect(badges()).toEqual(["5", "1", "2", "3", "4", "6 ↵"]); // in document order
    key("keydown", { key: "£", code: "Digit3", altKey: true });
    expect(show(v).split("\n")[3]).toBe("    \\item Then so \\frac{}{|} holds.");
    key("keydown", { key: "º", code: "Digit0", altKey: true });
    expect(show(v).split("\n")[3]).toBe("    \\item Then| so \\frac{}{} holds.");
    key("keyup", { key: "Alt", code: "AltLeft" });
    expect(badges()).toEqual([]);
    v.destroy();
  });

  it("a quick ⌥+digit jumps without showing the numbers", () => {
    const v = editor(proof, none(), [numberedJumps]);
    const key = (type: string, init: KeyboardEventInit) => v.contentDOM.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
    key("keydown", { key: "Alt", code: "AltLeft", altKey: true });
    key("keydown", { key: "™", code: "Digit4", altKey: true });
    key("keyup", { key: "Alt", code: "AltLeft" });
    vi.advanceTimersByTime(SHOW_DELAY * 2);
    expect(show(v).split("\n")[3]).toBe("    \\item Then so \\frac{}{} holds.|");
    expect(v.contentDOM.querySelector(".cm-jump-label")).toBeNull();
    v.destroy();
  });
});
