// Numbered jumps: hold ⌥ and up to six places near the cursor get a number; ⌥1…⌥6 goes
// there, ⌥0 goes back to where the last numbered jump started.
//
// The places are typing spots — where you'd start typing next — a few lines either way:
// line ends, empty arguments (`\frac{|}{}`), right after inline math, the start of an
// item's text, `&` cells, and a new line after the `\end` of each block around the cursor.
// Which six, and their order, is a fixed rule (see `jumpTargets`), so the same cursor
// always gets the same numbers.

import { EditorSelection, EditorState, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { Mode, modeOf, scanLine } from "../scanner/scanner";
import { scanField, scannerConfig } from "../scanner/field";
import { Scope, blockLevels, leaveBlock } from "./jumpout";

/** At most this many numbered targets. */
export const MAX_TARGETS = 6;
/** How many lines either side of the cursor to look for spots. */
const RADIUS = 15;
/** At most this many targets on one side while the other has spots, so both directions show. */
const PER_SIDE = 4;
/** How long ⌥ is held before the numbers show (a quick ⌥+digit chord doesn't flash them). */
export const SHOW_DELAY = 150;

export interface JumpTarget {
  /** Where the cursor goes (for an exit: the end of the `\end` line, where the badge is). */
  pos: number;
  /** Leaving this block onto a new line after its `\end`, rather than moving the cursor. */
  exit?: Scope;
}

/** A line that's only a `\begin{…}` / `\end{…}` (its end isn't a place to type). */
const BEGIN_END_LINE = /^\s*\\(begin|end)\s*\{[^}]*\}(\[[^\]]*\]|\{[^}]*\})*\s*(%.*)?$/;
const ITEM = /\\item\b(\[[^\]]*\])?\s*/g;

/** The typing spots on line `n` (not counting block exits). */
function lineSpots(state: EditorState, n: number): number[] {
  const line = state.doc.line(n);
  const text = line.text;
  if (!text.trim() || /^\s*%/.test(text) || BEGIN_END_LINE.test(text)) return [];
  const out: number[] = [];
  // Where the scanner leaves math for text: right after inline math.
  const steps: [number, Mode][] = [];
  scanLine(state.field(scanField).states[n - 1], text, -1, state.facet(scannerConfig), (i, stack) => steps.push([i, modeOf(stack)]));
  for (let k = 1; k < steps.length; k++) {
    if (steps[k - 1][1] === "inline" && steps[k][1] === "text" && steps[k][0] < text.length) out.push(line.from + steps[k][0]);
  }
  const comment = text.search(/(^|[^\\])%/);
  const code = comment < 0 ? text : text.slice(0, comment + (text[comment] === "%" ? 0 : 1));
  for (let i = code.indexOf("{}"); i >= 0; i = code.indexOf("{}", i + 1)) {
    if (code[i - 1] !== "\\") out.push(line.from + i + 1);
  }
  for (const m of code.matchAll(ITEM)) out.push(line.from + m.index + m[0].length);
  for (let i = code.indexOf("&"); i >= 0; i = code.indexOf("&", i + 1)) {
    if (code[i - 1] !== "\\") out.push(line.from + i + 1 + (code[i + 1] === " " ? 1 : 0));
  }
  out.push(line.from + code.trimEnd().length);
  return out;
}

/**
 * The numbered targets from `pos`, 1 first. Spots within RADIUS lines plus the exit of each
 * block around the cursor; the innermost exit is always kept; the rest go by distance (lines,
 * then columns) with at most PER_SIDE on one side unless the other runs out; then numbered by
 * distance, ahead first on a tie.
 */
export function jumpTargets(state: EditorState, pos: number): JumpTarget[] {
  const here = state.doc.lineAt(pos);
  const col = pos - here.from;
  const dist = (p: number) => {
    const l = state.doc.lineAt(p);
    return [Math.abs(l.number - here.number), Math.abs(p - l.from - col), p > pos ? 0 : 1];
  };
  const byDistance = (a: JumpTarget, b: JumpTarget) => {
    const da = dist(a.pos), db = dist(b.pos);
    return da[0] - db[0] || da[1] - db[1] || da[2] - db[2] || a.pos - b.pos;
  };

  const seen = new Set<number>();
  const exits: JumpTarget[] = blockLevels(state, pos).map((s) => ({ pos: state.doc.lineAt(s.to).to, exit: s }));
  for (const e of exits) seen.add(e.pos);
  const spots: JumpTarget[] = [];
  const first = Math.max(1, here.number - RADIUS), last = Math.min(state.doc.lines, here.number + RADIUS);
  for (let n = first; n <= last; n++) {
    for (const p of lineSpots(state, n)) {
      if (p === pos || seen.has(p)) continue;
      seen.add(p);
      spots.push({ pos: p });
    }
  }

  const chosen: JumpTarget[] = exits.slice(0, 1);
  const rest = [...spots, ...exits.slice(1)].sort(byDistance);
  const sides = { ahead: chosen.length, behind: 0 };
  for (const t of rest) {
    if (chosen.length >= MAX_TARGETS) break;
    const side = t.pos > pos ? "ahead" : "behind";
    if (sides[side] >= PER_SIDE) continue;
    sides[side]++;
    chosen.push(t);
  }
  // One side ran out: the other fills the rest.
  for (const t of rest) {
    if (chosen.length >= MAX_TARGETS) break;
    if (!chosen.includes(t)) chosen.push(t);
  }
  return chosen.sort(byDistance);
}

// ---- jumping and going back --------------------------------------------------------------

const pushBack = StateEffect.define<number>();
const popBack = StateEffect.define<null>();

/** Where each numbered jump started, most recent last (for ⌥0). */
const backStack = StateField.define<number[]>({
  create: () => [],
  update(v, tr) {
    if (tr.docChanged) v = v.map((p) => tr.changes.mapPos(p));
    for (const e of tr.effects) {
      if (e.is(pushBack)) v = [...v.slice(-49), e.value];
      else if (e.is(popBack)) v = v.slice(0, -1);
    }
    return v;
  },
});

/** Jumps to target `n` (1-based) from the cursor. */
export function jumpTo(view: EditorView, n: number): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty || view.state.selection.ranges.length > 1) return false;
  const t = jumpTargets(view.state, sel.head)[n - 1];
  if (!t) return false;
  if (t.exit) {
    view.dispatch({ effects: pushBack.of(sel.head) });
    return leaveBlock(view, t.exit);
  }
  view.dispatch({ selection: EditorSelection.cursor(t.pos), effects: pushBack.of(sel.head), scrollIntoView: true, userEvent: "select.jump" });
  return true;
}

/** Goes back to where the last numbered jump started. */
export function jumpBack(view: EditorView): boolean {
  const stack = view.state.field(backStack, false);
  if (!stack?.length) return false;
  view.dispatch({ selection: EditorSelection.cursor(stack[stack.length - 1]), effects: popBack.of(null), scrollIntoView: true, userEvent: "select.jump" });
  return true;
}

// ---- the badges --------------------------------------------------------------------------

/** A number drawn over the text at a spot, taking no space (so nothing reflows). */
class Badge extends WidgetType {
  constructor(readonly text: string, readonly lineEnd: boolean) { super(); }
  eq(o: Badge) { return o.text === this.text && o.lineEnd === this.lineEnd; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-jump-badge" + (this.lineEnd ? " cm-jump-badge-end" : "");
    el.setAttribute("aria-hidden", "true");
    const label = el.appendChild(document.createElement("span"));
    label.className = "cm-jump-label";
    label.textContent = this.text;
    return el;
  }
  ignoreEvent() { return true; }
}

const setShown = StateEffect.define<boolean>();
/** Whether the numbers are showing (⌥ held). */
export const badgesShown = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setShown)) v = e.value;
    return v;
  },
});

function decorate(view: EditorView): DecorationSet {
  const state = view.state, sel = state.selection.main;
  if (!state.field(badgesShown, false) || !sel.empty) return Decoration.none;
  const decos: Range<Decoration>[] = jumpTargets(state, sel.head).map((t, i) => {
    const lineEnd = t.pos === state.doc.lineAt(t.pos).to;
    return Decoration.widget({ widget: new Badge(t.exit ? `${i + 1} ↵` : String(i + 1), lineEnd), side: 1 }).range(t.pos);
  });
  return Decoration.set(decos, true);
}

const badgePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly view: EditorView) { this.decorations = decorate(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.viewportChanged || u.transactions.some((t) => t.effects.length)) {
      this.decorations = decorate(u.view);
    }
  }
  show(on: boolean) {
    clearTimeout(this.timer);
    if (this.view.state.field(badgesShown, false) !== on) this.view.dispatch({ effects: setShown.of(on) });
  }
  destroy() { clearTimeout(this.timer); }
}, {
  decorations: (p) => p.decorations,
  eventHandlers: {
    keydown(e) {
      if (e.key === "Alt") {
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.show(true), SHOW_DELAY);
        }
        return false;
      }
      // By physical key: ⌥+digit types a symbol (¡ ™ £…) on macOS.
      const digit = /^Digit([0-9])$/.exec(e.code);
      if (digit && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        const n = Number(digit[1]);
        if (n === 0) jumpBack(this.view);
        else if (n <= MAX_TARGETS) jumpTo(this.view, n);
        // Still holding ⌥: show the numbers from the new spot.
        this.show(true);
        return true;
      }
      this.show(false);
      return false;
    },
    keyup(e) { if (e.key === "Alt") this.show(false); },
    blur() { this.show(false); },
  },
});

const badgeTheme = EditorView.baseTheme({
  ".cm-jump-badge": { position: "relative", display: "inline-block", width: "0", height: "1em", verticalAlign: "text-bottom", pointerEvents: "none" },
  ".cm-jump-badge .cm-jump-label": { position: "absolute", left: "0", bottom: "0", transform: "translateX(-50%)", whiteSpace: "nowrap", zIndex: "2" },
  ".cm-jump-badge-end .cm-jump-label": { transform: "none", left: "0.4em" },
  ".cm-jump-label": {
    // An indented line's hanging indent (wrapindent.ts) sets a negative text-indent, which an inline-block inherits.
    textIndent: "0",
    display: "inline-block", padding: "0 0.4em", borderRadius: "4px", fontFamily: "var(--td-ui, system-ui)",
    // The text and background colours swapped, with a ring of background, so it reads as a sticker over the text.
    fontSize: "0.8em", fontWeight: "700", lineHeight: "1.4", color: "var(--td-bg, #fff)", backgroundColor: "var(--td-fg, #24262b)",
    boxShadow: "0 0 0 1.5px var(--td-bg, #fff)", userSelect: "none",
  },
  // Popups (the math preview) would cover the numbers, and jump out's ↵ would sit under one.
  "&.cm-jump-labels-on .cm-tooltip, &.cm-jump-labels-on .cm-jumpout-landing": { visibility: "hidden" },
});

/** Hold ⌥ for numbered targets near the cursor; ⌥1…⌥6 jumps, ⌥0 goes back. */
export const numberedJumps = [
  backStack,
  badgesShown,
  EditorView.editorAttributes.compute([badgesShown], (state) => (state.field(badgesShown) ? { class: "cm-jump-labels-on" } : ({} as Record<string, string>))),
  badgePlugin,
  badgeTheme,
];
