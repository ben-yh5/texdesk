// ⌘L's picker: the cursor moves to a misspelling, which is highlighted, with its suggestions
// numbered under it, best first. 1–6 (or Space for the selected one, moved with ←→↑↓ or j/k)
// replaces the word with that one and puts the cursor back where it was; Esc puts it back
// without changing anything. Any other key (or moving the cursor, or editing) puts the
// picker away and leaves the cursor at the word. Hovering an underlined misspelling shows
// the same row of suggestions, to click.

import { EditorSelection, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, Tooltip, hoverTooltip, showTooltip } from "@codemirror/view";
import { Diagnostic, forEachDiagnostic } from "@codemirror/lint";
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
  /** The option Space picks. */
  selected: number;
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

/** The row of numbered suggestions; `extra` adds unnumbered items after them. */
function pickerDom(word: string, options: string[], onPick: (i: number) => void, selected = -1, extra: { name: string; class: string; run(): void }[] = []): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-spellfix";
  if (!options.length) dom.textContent = `No suggestions for “${word}”`;
  const item = (cls: string, run: () => void) => {
    const el = dom.appendChild(document.createElement("span"));
    el.className = cls;
    el.addEventListener("mousedown", (e) => { e.preventDefault(); run(); });
    return el;
  };
  options.forEach((option, i) => {
    const el = item(i === selected ? "cm-spellfix-option cm-spellfix-selected" : "cm-spellfix-option", () => onPick(i));
    el.appendChild(document.createElement("kbd")).textContent = String(i + 1);
    el.appendChild(document.createTextNode(option));
  });
  for (const x of extra) item(`cm-spellfix-option ${x.class}`, x.run).textContent = x.name;
  return dom;
}

function pickerTooltip(fix: SpellFix): Tooltip {
  return {
    pos: fix.from,
    above: false,
    create: (view) => ({ dom: pickerDom(fix.word, fix.options, (i) => pick(view, i), fix.selected) }),
  };
}

/** Marks a misspelling's action that isn't a suggestion (Add to dictionary). */
export const EXTRA_ACTION = "cm-spellfix-extra";

/** Hovering a misspelling (a "spelling" diagnostic) shows its suggestions like the picker. */
const spellHover = hoverTooltip((view, pos, side) => {
  let found: { d: Diagnostic; from: number; to: number } | null = null;
  forEachDiagnostic(view.state, (d, from, to) => {
    if (d.source === "spelling" && pos >= from && pos <= to && (pos > from || side > 0) && (pos < to || side < 0)) found = { d, from, to };
  });
  if (!found) return null;
  const { d, from, to } = found as { d: Diagnostic; from: number; to: number };
  // Where the misspelling is now, in case the document changed under the tooltip.
  const apply = (action: NonNullable<Diagnostic["actions"]>[number]) => {
    forEachDiagnostic(view.state, (x, f, t) => { if (x === d) action.apply(view, f, t); });
  };
  const actions = d.actions ?? [];
  const suggestions = actions.filter((a) => a.markClass !== EXTRA_ACTION);
  const extra = actions.filter((a) => a.markClass === EXTRA_ACTION).map((a) => ({ name: a.name, class: EXTRA_ACTION, run: () => apply(a) }));
  return {
    pos: from,
    end: to,
    above: false,
    create: () => ({ dom: pickerDom(view.state.sliceDoc(from, to), suggestions.map((a) => a.name), (i) => apply(suggestions[i]), -1, extra) }),
  };
});

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
    if (plain && e.key === " " && pick(view, openSpellFix(view)!.selected)) { e.preventDefault(); return true; }
    const step = !plain ? 0 : ["ArrowRight", "ArrowDown", "j"].includes(e.key) ? 1 : ["ArrowLeft", "ArrowUp", "k"].includes(e.key) ? -1 : 0;
    if (step) {
      e.preventDefault();
      const fix = openSpellFix(view)!;
      const selected = Math.min(Math.max(fix.selected + step, 0), Math.max(fix.options.length - 1, 0));
      view.dispatch({ effects: showSpellFix.of({ ...fix, selected }) });
      return true;
    }
    if (plain && e.key === "Escape") { e.preventDefault(); goHome(view); return true; }
    // Any other key puts the picker away (and does what it does). Not a shortcut: ⌘L again
    // needs it, and one that moves the cursor or edits puts it away anyway.
    if (!e.ctrlKey && !e.metaKey) view.dispatch({ effects: showSpellFix.of(null) });
    return false;
  },
}));

export const spellFix = [spellFixField, pickerKeys, spellHover];
