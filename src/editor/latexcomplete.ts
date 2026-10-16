// LaTeX suggestions as you type: `\` + letters suggests commands (math ones in math, text
// ones in text, plus the document's own \newcommands), and `\begin{` suggests environments;
// accepting one writes its `\end{…}` and puts the cursor inside. `\end{` offers the
// environment you're in first.

import { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { Compartment, EditorSelection, EditorState, Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { contextAt } from "../scanner/field";
import { mathMacros } from "./mathpreview";
import { matchingEnd } from "./brackets";
import { nextField, nextFieldPos } from "../snippets/fields";
import { COMMANDS } from "./commands";

const LISTS = new Set(["itemize", "enumerate", "description"]);

const MATH_ENVS = "pmatrix bmatrix Bmatrix vmatrix Vmatrix matrix smallmatrix cases aligned gathered split array alignedat";
const TEXT_ENVS = `align align* equation equation* gather gather* multline multline* itemize enumerate description
figure table tabular center flushleft flushright quote quotation verbatim lstlisting minipage
proof theorem lemma definition corollary proposition remark example abstract tikzpicture`;

/** Environments the app found in the workspace .sty files and the preamble (\newtheorem, \newenvironment). */
export const userEnvironments = Facet.define<string[], string[]>({ combine: (v) => v.flat() });
export const userEnvCompartment = new Compartment();
export function setUserEnvironments(view: EditorView, names: string[]) {
  view.dispatch({ effects: userEnvCompartment.reconfigure(userEnvironments.of(names)) });
}

/** \newtheorem{name}… and \newenvironment{name}… in `text`. */
export function extractEnvironments(text: string): string[] {
  return [...text.matchAll(/\\(?:newtheorem|newenvironment|renewenvironment|NewDocumentEnvironment)\*?\s*\{([A-Za-z*]+)\}/g)].map((m) => m[1]);
}

/** What goes between `\begin{name}` and `\end{name}`; `|` is the cursor. */
function envBody(name: string): { args: string; body: string } {
  if (name === "itemize" || name === "enumerate") return { args: "", body: "\\item |" };
  if (name === "description") return { args: "", body: "\\item[|] " };
  if (name === "tabular" || name === "array") return { args: "{|}", body: "" };
  if (name === "minipage") return { args: "{|}", body: "" };
  if (name === "lstlisting") return { args: "[language=|]", body: "" };
  if (name === "figure" || name === "table") return { args: "[H]", body: "\\centering\n|" };
  return { args: "", body: "|" };
}

const indentOf = (state: EditorState, pos: number) => /^\s*/.exec(state.doc.lineAt(pos).text)![0];

/** Inserts `text` (with one `|` cursor marker) over [from, to). */
function insertWithCursor(view: EditorView, from: number, to: number, text: string) {
  const at = text.indexOf("|");
  const insert = at < 0 ? text : text.slice(0, at) + text.slice(at + 1);
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + (at < 0 ? insert.length : at) },
    userEvent: "input.complete",
    scrollIntoView: true,
  });
}

function environmentSource(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = /\\(begin|end)\{([A-Za-z*]*)$/.exec(before);
  if (!m) return null;
  const from = ctx.pos - m[2].length;
  const c = contextAt(ctx.state, ctx.pos);
  if (c.mode === "code") return null;
  const inMath = c.mode === "inline" || c.mode === "display";
  const doc = ctx.state.doc.toString();
  const used = [...doc.matchAll(/\\begin\{([A-Za-z*]+)\}/g)].map((x) => x[1]);
  const names = [...new Set([
    ...(inMath ? MATH_ENVS.split(/\s+/) : [...TEXT_ENVS.split(/\s+/), ...MATH_ENVS.split(/\s+/)]),
    ...ctx.state.facet(userEnvironments),
    ...used,
  ])].filter(Boolean);

  if (m[1] === "end") {
    const open = c.envStack[c.envStack.length - 1];
    const options: Completion[] = names.map((n) => ({
      label: n, type: "type", boost: n === open ? 99 : 0,
      apply: (view, _c, f, t) => insertWithCursor(view, f, view.state.sliceDoc(t, t + 1) === "}" ? t + 1 : t, `${n}}|`),
    }));
    return { from, options, validFor: /^[A-Za-z*]*$/ };
  }

  const options: Completion[] = names.map((n) => ({
    label: n,
    type: "type",
    detail: "environment",
    apply: (view, _c, f, t) => {
      if (fillExisting(view, n, f, t)) return;
      const indent = indentOf(view.state, f);
      const end = view.state.sliceDoc(t, t + 1) === "}" ? t + 1 : t;
      const { args, body } = envBody(n);
      const inner = body.split("\n").map((l) => `${indent}  ${l}`).join("\n");
      // The cursor goes to the first | (in the arguments, else in the body).
      const text = `${n}}${args}\n${inner}\n${indent}\\end{${n}}`;
      const first = text.indexOf("|");
      insertWithCursor(view, f, end, text.slice(0, first + 1) + text.slice(first + 1).replace(/\|/g, ""));
    },
  }));
  return { from, options, validFor: /^[A-Za-z*]*$/ };
}

/**
 * When the environment already has its \end (the `beg` snippet writes both, with the name
 * mirrored), accepting a suggestion just fills in the name, at every cursor and in the
 * matching \end, then moves into the body. Returns false if there's no \end yet.
 */
function fillExisting(view: EditorView, name: string, from: number, to: number): boolean {
  const state = view.state;
  const end = matchingEnd(state, from);
  if (!end && state.selection.ranges.length < 2) return false;
  const changes: { from: number; to: number; insert: string }[] = [{ from, to, insert: name }];
  for (const r of state.selection.ranges) {
    if (r.head === to || !r.empty) continue;
    const line = state.doc.lineAt(r.head);
    const m = /\\(?:begin|end)\{([A-Za-z*]*)$/.exec(line.text.slice(0, r.head - line.from));
    if (m) changes.push({ from: r.head - m[1].length, to: r.head, insert: name });
  }
  // The \end gets the name too, unless a mirrored cursor there is already filling it in.
  if (end && !changes.some((c) => c.from >= end.nameFrom && c.from <= end.nameTo)) {
    changes.push({ from: end.nameFrom, to: end.nameTo, insert: name });
  }
  const cs = state.changes(changes);
  view.dispatch({ changes: cs, selection: EditorSelection.cursor(cs.mapPos(to, 1)), userEvent: "input.complete" });
  // Into the body: the snippet's next tab stop, else the line after \begin{…}.
  if (nextFieldPos(view.state) !== null && nextField(view)) return true;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (line.number < view.state.doc.lines) {
    const next = view.state.doc.line(line.number + 1);
    if (!/^\s*\\end\{/.test(next.text)) view.dispatch({ selection: EditorSelection.cursor(next.to) });
  }
  return true;
}

function commandSource(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = /(\\+)([A-Za-z]+)$/.exec(before);
  // An even run of backslashes is "\\" (a line break) followed by plain letters.
  if (!m || m[1].length % 2 === 0) return null;
  const c = contextAt(ctx.state, ctx.pos);
  if (c.mode === "code") return null;
  const inMath = c.mode === "inline" || c.mode === "display";
  const from = ctx.pos - m[2].length;
  const inList = LISTS.has(c.envStack[c.envStack.length - 1] ?? "");
  const options: Completion[] = COMMANDS
    .filter((x) => x.where === "any" || (x.where === "math") === inMath)
    .map((x) => {
      const opt = command(x.name, x.template, x.name === "item" ? "list item" : x.where === "any" ? "" : x.where);
      return x.name === "item" && inList ? { ...opt, boost: 50 } : opt;
    });
  for (const name of Object.keys(ctx.state.facet(mathMacros))) {
    const n = name.replace(/^\\/, "");
    if (!COMMANDS.some((x) => x.name === n)) options.push({ ...command(n, "", "your macro"), boost: 2 });
  }
  return { from, options, validFor: /^[A-Za-z*]*$/ };
}

function command(name: string, template: string, detail: string): Completion {
  return {
    label: name,
    detail: template.trim() ? `${template.replace(/\|/g, "")}${detail ? `  ${detail}` : ""}` : detail || undefined,
    type: "command",
    // Templateless commands need no apply: inserting the name is enough.
    apply: template ? (view, _c, f, t) => insertWithCursor(view, f, t, name + template) : name,
  };
}

/** The template a command completion inserts, if any (for "Enter on a fully typed name"). */
export const hasArguments = (c: Completion) => typeof c.apply === "function";

export const latexSources = [environmentSource, commandSource];
