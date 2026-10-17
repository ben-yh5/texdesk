// ⌘L's picker: the cursor moves to a misspelling, which is highlighted, with its suggestions
// numbered under it, best first. 1–6 replaces the word with that one and puts the cursor
// back where it was; Esc puts it back without changing anything. Any other key (or moving
// the cursor, or editing) puts the picker away and leaves the cursor at the word.

import { EditorSelection, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, Tooltip, showTooltip } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";

/** At most this many suggestions, for 1–6. */
export const MAX_OPTIONS = 6;

export interface SpellFix {
  /** The misspelling. */
  from: number;
  to: number;
  word: string;
  /** Its suggestions, best first. */
  options: string[];
  /** Where the cursor was before ⌘L, to go back to. */
  home: number;
}

export const showSpellFix = StateEffect.define<SpellFix | null>();

const wordMark = Decoration.mark({ class: "cm-spellfix-word" });

const spellFixField = StateField.define<SpellFix | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(showSpellFix)) return e.value;
    return value && (tr.docChanged || tr.selection) ? null : value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => (v ? Decoration.set(wordMark.range(v.from, v.to)) : Decoration.none)),
    showTooltip.from(f, (v) => (v ? pickerTooltip(v) : null)),
  ],
});

/** The open picker, if any (⌘L again keeps its `home`). */
export function openSpellFix(view: EditorView): SpellFix | null {
  return view.state.field(spellFixField, false) ?? null;
}

function pickerTooltip(fix: SpellFix): Tooltip {
  return {
    pos: fix.from,
    above: false,
    create: (view) => {
      const dom = document.createElement("div");
      dom.className = "cm-spellfix";
      if (!fix.options.length) dom.textContent = `No suggestions for “${fix.word}”`;
      fix.options.forEach((option, i) => {
        const item = dom.appendChild(document.createElement("span"));
        item.className = "cm-spellfix-option";
        item.appendChild(document.createElement("kbd")).textContent = String(i + 1);
        item.appendChild(document.createTextNode(option));
        item.addEventListener("mousedown", (e) => { e.preventDefault(); pick(view, i); });
      });
      return { dom };
    },
  };
}

/** Replaces the word with option `i` and puts the cursor back; false if there's no such option. */
function pick(view: EditorView, i: number): boolean {
  const fix = openSpellFix(view);
  const option = fix?.options[i];
  if (!fix || option === undefined) return false;
  const changes = view.state.changes({ from: fix.from, to: fix.to, insert: option });
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(changes.mapPos(fix.home, 1)),
    annotations: isolateHistory.of("full"),
    userEvent: "input.spelling",
    scrollIntoView: true,
  });
  return true;
}

function goHome(view: EditorView) {
  const fix = openSpellFix(view);
  if (fix) view.dispatch({ selection: EditorSelection.cursor(fix.home), effects: showSpellFix.of(null), scrollIntoView: true });
}

const pickerKeys = Prec.highest(EditorView.domEventHandlers({
  keydown(e, view) {
    if (!openSpellFix(view) || ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return false;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    const n = plain && /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
    if (n && n <= MAX_OPTIONS && pick(view, n - 1)) { e.preventDefault(); return true; }
    if (plain && e.key === "Escape") { e.preventDefault(); goHome(view); return true; }
    // Any other key puts the picker away (and does what it does). Not a shortcut: ⌘L again
    // needs it, and one that moves the cursor or edits puts it away anyway.
    if (!e.ctrlKey && !e.metaKey) view.dispatch({ effects: showSpellFix.of(null) });
    return false;
  },
}));

export const spellFix = [spellFixField, pickerKeys];
