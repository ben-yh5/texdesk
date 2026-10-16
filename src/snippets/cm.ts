// CodeMirror wiring for the snippet engine.
//
// - Auto and visual snippets hook in via `EditorView.inputHandler`, which only sees
//   typed text (not paste, undo, or programmatic edits). The typed character is
//   dispatched as its own transaction and the expansion as a second, history-isolated
//   one, so a single undo restores exactly what was typed.
// - Tab / Shift-Tab / user key handlers go through one highest-precedence keymap,
//   rebuilt in a compartment whenever the snippet set reloads. Precedence for Tab:
//   field navigation > Tab-triggered snippets > user key handlers > tabout > insert
//   tab / indent. Enter: user key handlers > keep-indent newline in code > default.

import { Compartment, EditorSelection, EditorState, Extension, Prec } from "@codemirror/state";
import { EditorView, KeyBinding, ViewPlugin, keymap } from "@codemirror/view";
import { indentLess, indentMore, insertNewlineKeepIndent, isolateHistory } from "@codemirror/commands";
import { tabBack, tabout } from "../editor/tabout";
import { maybeEnlarge } from "../editor/brackets";
import { codeInput, inCode } from "../editor/codeblocks";
import { getIndentUnit, indentString } from "@codemirror/language";
import { contextAt, scanField } from "../scanner/field";
import { Expansion, expandSnippet, instantiateEdits, runKeyHandlers } from "./engine";
import { clearSessions, fieldPositions, hasSession, nextField, nextFieldPos, prevField, snippetSessions, startSession } from "./fields";
import type { SnippetRuntime } from "./runtime";

/** Applies an expansion's edits as one isolated history event. Returns false if nothing to apply. */
function apply(view: EditorView, rt: SnippetRuntime, exp: Expansion | null): boolean {
  if (!exp) return false;
  rt.recordLog(exp.log);
  if (!exp.edits.length) return false;
  let inst;
  try {
    inst = instantiateEdits(view.state, exp.edits);
  } catch (err) {
    const fired = exp.log.attempts.find((a) => a.outcome === "fired");
    rt.error(fired?.label ?? "?", fired?.file ?? "?", err);
    return false;
  }
  const { selection, effects } = startSession(inst.stops);
  view.dispatch({
    changes: inst.changes,
    selection,
    effects,
    annotations: isolateHistory.of("full"),
    userEvent: "input.snippet",
    scrollIntoView: true,
  });
  return true;
}

const singleCursor = (state: EditorState) => state.selection.ranges.length === 1;

function inputHandler(rt: SnippetRuntime): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (view.composing || view.state.readOnly || !singleCursor(view.state)) return false;
    if (codeInput(view, from, to, text)) return true;
    const set = rt.set;
    if (!set.snippets.length) return false;
    const sel = view.state.selection.main;

    // Visual: a trigger typed over a selection.
    if (!sel.empty && from === sel.from && to === sel.to &&
        set.snippets.some((e) => e.snippet.options.visual && e.snippet.trigger === text)) {
      if (apply(view, rt, expandSnippet(view.state, set, { kind: "visual", typed: text }, rt.fileInfo, rt))) return true;
    }

    if (!set.snippets.some((e) => e.snippet.options.auto)) return false;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: EditorSelection.cursor(from + text.length),
      userEvent: "input.type",
      scrollIntoView: true,
    });
    apply(view, rt, expandSnippet(view.state, set, { kind: "auto", typedFrom: from }, rt.fileInfo, rt));
    return true;
  });
}

/** Inserts one indent unit at each cursor. */
function insertIndent(view: EditorView): boolean {
  const unit = indentString(view.state, getIndentUnit(view.state));
  view.dispatch(view.state.update(view.state.replaceSelection(unit), { scrollIntoView: true, userEvent: "input" }));
  return true;
}

/**
 * Whether the next tab stop is outside the innermost environment at the cursor, and the
 * current snippet has no other tab stops inside that environment.
 */
function freeFormEnvironment(state: EditorState): boolean {
  const here = contextAt(state, state.selection.main.head).envStack;
  if (!here.length) return false;
  const inside = (pos: number) => {
    const there = contextAt(state, pos).envStack;
    return there.length >= here.length && here.every((e, i) => there[i] === e);
  };
  const next = nextFieldPos(state);
  if (next === null || inside(next)) return false;
  return fieldPositions(state).filter(inside).length <= 1;
}

function buildKeymap(rt: SnippetRuntime): KeyBinding[] {
  const userKeys = new Set(rt.set.keys.map((k) => k.handler.key));
  const names = new Set(["Tab", "Shift-Tab", "Enter", ...userKeys]);

  const runFor = (name: string) => (view: EditorView): boolean => {
    if (name === "Tab" && nextFieldPos(view.state) !== null) {
      // In an environment the snippet left free-form (one tab stop in it, e.g. pmat's body),
      // a Tab key handler for it (Tab → " & " in a matrix) beats jumping out to the next stop.
      // A generated matrix whose cells are tab stops keeps Tab for visiting them, then exits.
      if (singleCursor(view.state) && userKeys.has("Tab") && freeFormEnvironment(view.state) &&
          apply(view, rt, runKeyHandlers(view.state, rt.set, "Tab", rt.fileInfo, rt))) return true;
      if (nextField(view)) { maybeEnlarge(view); return true; }
    } else if (name === "Tab" && hasSession(view)) {
      nextField(view); // every stop left is at the cursor: finish those snippets, then tab out below
    }
    if (name === "Shift-Tab" && prevField(view)) return true;
    const single = singleCursor(view.state);
    if (single && name === "Tab" &&
        apply(view, rt, expandSnippet(view.state, rt.set, { kind: "tab" }, rt.fileInfo, rt))) return true;
    if (single && userKeys.has(name) &&
        apply(view, rt, runKeyHandlers(view.state, rt.set, name, rt.fileInfo, rt))) return true;
    if (single && name === "Tab" && tabout(view)) { maybeEnlarge(view); return true; }
    if (single && name === "Shift-Tab" && tabBack(view)) return true;
    if (name === "Enter" && inCode(view.state)) return insertNewlineKeepIndent(view);
    if (name === "Tab") return view.state.selection.ranges.some((r) => !r.empty) ? indentMore(view) : insertIndent(view);
    if (name === "Shift-Tab") return indentLess(view);
    return false;
  };

  return [
    ...[...names].map((key) => ({ key, run: runFor(key) })),
    {
      key: "Escape",
      run: (view) => {
        if (!hasSession(view)) return false;
        view.dispatch({ effects: clearSessions.of(null) });
        return true;
      },
    },
  ];
}

const fieldTheme = EditorView.baseTheme({
  ".cm-snippet-field": { borderBottom: "1px dotted var(--td-accent, #6a8cff)" },
  ".cm-snippet-field-active": { backgroundColor: "var(--td-field-bg, rgba(106, 140, 255, 0.14))" },
});

/** Everything the snippet engine needs in an editor showing a `.tex` file. */
export function snippetExtension(rt: SnippetRuntime): Extension {
  const keys = new Compartment();
  const reloader = ViewPlugin.define((view) => {
    let last = rt.set;
    let alive = true;
    const unsubscribe = rt.subscribe(() => {
      if (rt.set === last) return;
      last = rt.set;
      // Defer: subscribers may fire during another view update.
      queueMicrotask(() => alive && view.dispatch({ effects: keys.reconfigure(keymap.of(buildKeymap(rt))) }));
    });
    return { destroy() { alive = false; unsubscribe(); } };
  });
  return [
    scanField,
    snippetSessions,
    EditorState.allowMultipleSelections.of(true),
    inputHandler(rt),
    Prec.highest(keys.of(keymap.of(buildKeymap(rt)))),
    reloader,
    fieldTheme,
  ];
}
