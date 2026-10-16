// Tab stops. Each expanded snippet with fields pushes a session; sessions stack, so a
// snippet expanded inside another snippet's field returns to the outer snippet once its
// own fields are done.

import { ChangeDesc, EditorSelection, EditorState, Range as CMRange, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import type { AbsStop } from "./engine";

export interface Session {
  /** Visiting order; the last stop is the exit. */
  stops: AbsStop[];
  /** Index into `stops` of the field being edited. */
  active: number;
}

const pushSession = StateEffect.define<Session>();
const setActive = StateEffect.define<number>();
const popSession = StateEffect.define<null>();
export const clearSessions = StateEffect.define<null>();

function mapSession(s: Session, ch: ChangeDesc): Session {
  const exitIdx = s.stops.length - 1;
  return {
    active: s.active,
    stops: s.stops.map((stop, i) => ({
      index: stop.index,
      ranges: stop.ranges.map((r) => {
        if (i === s.active) return { from: ch.mapPos(r.from, -1), to: ch.mapPos(r.to, 1) };
        if (i === exitIdx || r.from === r.to) { const p = ch.mapPos(r.from, 1); return { from: p, to: p }; }
        const from = ch.mapPos(r.from, 1);
        return { from, to: Math.max(from, ch.mapPos(r.to, -1)) };
      }),
    })),
  };
}

function contains(s: Session, pos: number): boolean {
  let lo = Infinity, hi = -Infinity;
  for (const st of s.stops) for (const r of st.ranges) { lo = Math.min(lo, r.from); hi = Math.max(hi, r.to); }
  return pos >= lo && pos <= hi;
}

const activeMark = Decoration.mark({ class: "cm-snippet-field cm-snippet-field-active" });
const idleMark = Decoration.mark({ class: "cm-snippet-field" });

export const snippetSessions = StateField.define<Session[]>({
  create: () => [],
  update(value, tr) {
    let sessions = tr.docChanged ? value.map((s) => mapSession(s, tr.changes)) : value;
    for (const e of tr.effects) {
      if (e.is(pushSession)) sessions = [...sessions, e.value];
      else if (e.is(setActive) && sessions.length) {
        sessions = [...sessions.slice(0, -1), { ...sessions[sessions.length - 1], active: e.value }];
      } else if (e.is(popSession)) sessions = sessions.slice(0, -1);
      else if (e.is(clearSessions)) sessions = [];
    }
    if (sessions.length && (tr.selection || tr.docChanged)) {
      const head = tr.state.selection.main.head;
      while (sessions.length && !contains(sessions[sessions.length - 1], head)) sessions = sessions.slice(0, -1);
    }
    return sessions;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (sessions): DecorationSet => {
      const top = sessions[sessions.length - 1];
      if (!top) return Decoration.none;
      const marks: CMRange<Decoration>[] = [];
      top.stops.forEach((stop, i) => {
        if (i === top.stops.length - 1) return;
        for (const r of stop.ranges) if (r.to > r.from) marks.push((i === top.active ? activeMark : idleMark).range(r.from, r.to));
      });
      return Decoration.set(marks, true);
    }),
});

function selectionFor(stop: AbsStop): EditorSelection {
  return EditorSelection.create(stop.ranges.map((r) => EditorSelection.range(r.from, r.to)));
}

/**
 * Effects + selection to start a snippet's fields. With only an exit stop, just places
 * the cursor there.
 */
export function startSession(stops: AbsStop[]): { selection: EditorSelection; effects: StateEffect<unknown>[] } {
  if (stops.length === 1) return { selection: EditorSelection.single(stops[0].ranges[0].from), effects: [] };
  return { selection: selectionFor(stops[0]), effects: [pushSession.of({ stops, active: 0 })] };
}

export function hasSession(view: EditorView): boolean {
  return (view.state.field(snippetSessions, false)?.length ?? 0) > 0;
}

/** Positions of the innermost snippet's tab stops, not counting its exit. */
export function fieldPositions(state: EditorState): number[] {
  const top = state.field(snippetSessions, false)?.at(-1);
  return top ? top.stops.slice(0, -1).map((s) => s.ranges[0].from) : [];
}

/** Where Tab would move the cursor (the next tab stop of the innermost snippet), or null. */
/**
 * What Tab does with the snippet fields: the next stop that actually moves the cursor.
 * Stops at the cursor itself (an empty `$2` right before the exit, an inner snippet's exit
 * where the outer field continues) are passed over, finishing those snippets on the way, so
 * Tab never "does nothing". `selection` is null when every remaining stop was passed over.
 */
function planNext(state: EditorState): { selection: EditorSelection | null; effects: StateEffect<unknown>[] } | null {
  const sessions = state.field(snippetSessions, false) ?? [];
  if (!sessions.length) return null;
  const sel = state.selection.main;
  const effects: StateEffect<unknown>[] = [];
  for (let d = sessions.length - 1; d >= 0; d--) {
    const top = sessions[d];
    for (let next = top.active + 1; next < top.stops.length; next++) {
      const stop = top.stops[next];
      const r = stop.ranges[0];
      const stays = sel.empty && r.from === r.to && r.from === sel.head;
      if (next === top.stops.length - 1) {
        effects.push(popSession.of(null));
        if (!stays) return { selection: EditorSelection.single(r.from), effects };
        break; // this snippet is done; continue with the one around it
      }
      if (!stays) return { selection: selectionFor(stop), effects: [...effects, setActive.of(next)] };
    }
  }
  return { selection: null, effects };
}

export function nextFieldPos(state: EditorState): number | null {
  return planNext(state)?.selection?.main.from ?? null;
}

/** Moves to the next field (see planNext). False if no field moves the cursor. */
export function nextField(view: EditorView): boolean {
  const plan = planNext(view.state);
  if (!plan) return false;
  if (!plan.selection) {
    view.dispatch({ effects: plan.effects });
    return false;
  }
  view.dispatch({ selection: plan.selection, effects: plan.effects, scrollIntoView: true });
  return true;
}

export function prevField(view: EditorView): boolean {
  const sessions = view.state.field(snippetSessions, false);
  const top = sessions?.[sessions.length - 1];
  if (!top) return false;
  if (top.active === 0) return true; // stay put, but don't fall through to dedent
  const prev = top.active - 1;
  view.dispatch({ selection: selectionFor(top.stops[prev]), effects: setActive.of(prev), scrollIntoView: true });
  return true;
}
