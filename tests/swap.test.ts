import { afterEach, describe, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { startCompletion } from "@codemirror/autocomplete";
import { blankState, editorState } from "../src/editor/setup";
import { runtimeFrom } from "./helpers";

const state = (tex: boolean) => editorState({ doc: "\\sec", tex, runtime: runtimeFrom([]), onUpdate() {}, onSave() {} });

describe("swapping a view's state", () => {
  afterEach(() => { vi.useRealTimers(); });

  // Autocomplete's timers outlive a setState (going to another tab, or back / forward), and
  // used to throw "Field is not present in this state" in a state without autocomplete.
  for (const [name, next] of [["a blank state", blankState], ["a non-.tex file's state", () => state(false)]] as const) {
    it(`to ${name} with completion pending doesn't throw`, () => {
      vi.useFakeTimers();
      const v = new EditorView({ state: state(true), parent: document.body });
      v.dispatch({ selection: { anchor: 4 } });
      startCompletion(v);
      v.setState(next());
      vi.advanceTimersByTime(500);
      v.destroy();
    });
  }
});
