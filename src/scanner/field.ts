// CodeMirror integration for the scanner: a StateField holding the scanner state
// at the start of every line, updated incrementally on each change.

import { EditorState, StateField, Text, Facet } from "@codemirror/state";
import {
  CompiledConfig, Mode, ScanState, compileConfig, envStackOf, initialState, modeOf, scanLine, statesEqual,
} from "./scanner";

export const scannerConfig = Facet.define<CompiledConfig, CompiledConfig>({
  combine: (vs) => vs[vs.length - 1] ?? compileConfig(),
});

interface LineStates {
  /** states[i] = scanner state at the start of line i+1 (CodeMirror lines are 1-based). */
  readonly states: ScanState[];
}

function full(doc: Text, cc: CompiledConfig): LineStates {
  const states: ScanState[] = new Array(doc.lines);
  let s = initialState;
  for (let n = 1; n <= doc.lines; n++) {
    states[n - 1] = s;
    s = scanLine(s, doc.line(n).text, -1, cc);
  }
  return { states };
}

export const scanField = StateField.define<LineStates>({
  create: (state) => full(state.doc, state.facet(scannerConfig)),
  update(value, tr) {
    const cc = tr.state.facet(scannerConfig);
    if (cc !== tr.startState.facet(scannerConfig)) return full(tr.state.doc, cc);
    if (!tr.docChanged) return value;

    const doc = tr.state.doc;
    let firstB = Infinity, lastB = -1;
    tr.changes.iterChangedRanges((_fa, _ta, fb, tb) => {
      firstB = Math.min(firstB, fb);
      lastB = Math.max(lastB, tb);
    });
    const firstLine = doc.lineAt(firstB).number;
    const lastChangedLine = doc.lineAt(lastB).number;
    const lineDelta = doc.lines - tr.startState.doc.lines;
    const old = value.states;

    const states: ScanState[] = old.slice(0, firstLine);
    let s = states[firstLine - 1] ?? initialState;
    for (let n = firstLine; n <= doc.lines; n++) {
      if (n > lastChangedLine) {
        const prev = old[n - 1 - lineDelta];
        if (prev && statesEqual(prev, s)) {
          // Everything after this point is unchanged; reuse the old states.
          for (let m = n; m <= doc.lines; m++) states[m - 1] = old[m - 1 - lineDelta];
          return { states };
        }
      }
      states[n - 1] = s;
      s = scanLine(s, doc.line(n).text, -1, cc);
    }
    return { states };
  },
});

export interface MathContext {
  mode: Mode;
  envStack: string[];
  state: ScanState;
}

/** Mode and environment stack at a document position. */
export function contextAt(state: EditorState, pos: number): MathContext {
  const line = state.doc.lineAt(pos);
  const start = state.field(scanField).states[line.number - 1];
  const s = scanLine(start, line.text, pos - line.from, state.facet(scannerConfig));
  return { mode: modeOf(s), envStack: envStackOf(s), state: s };
}
