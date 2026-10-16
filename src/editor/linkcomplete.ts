// Suggestions while typing: file names inside `\link{…}`, `\input{…}`, `\include{…}`,
// `\lstinputlisting{…}` and `\includegraphics{…}` (the app supplies the workspace's files),
// plus LaTeX commands and environments (latexcomplete.ts).
//
// And, as in Obsidian, `[[` in text searches every file and folder in the workspace (fuzzy,
// by path) and turns into `\link{…}`; `[[name|text` gives `\link[text]{name}`.

import {
  Completion, CompletionContext, CompletionResult, acceptCompletion, autocompletion, closeCompletion, completionStatus, selectedCompletion,
} from "@codemirror/autocomplete";
import { hasArguments, latexSources, userEnvCompartment, userEnvironments } from "./latexcomplete";
import { Facet, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { LinkCommand } from "../workspace/links";
import { fuzzyScore } from "../workspace/fuzzy";
import { contextAt } from "../scanner/field";

export interface LinkCandidate {
  /** Text inserted between the braces. */
  target: string;
  /** Shown in the list (usually the file name). */
  name: string;
  /** Shown dimmed next to the name (usually the folder). */
  detail?: string;
  /** Workspace-relative path, matched by `[[` searches. */
  path?: string;
}

/** Returns the files that fit in `command`'s braces. */
export const linkCandidates = Facet.define<(command: LinkCommand) => LinkCandidate[], ((command: LinkCommand) => LinkCandidate[]) | null>({
  combine: (v) => v[v.length - 1] ?? null,
});

const COMPLETES = ["link", "input", "include", "lstinputlisting", "includegraphics"] as const;
const OPEN = new RegExp(`\\\\(${COMPLETES.join("|")})\\*?\\s*(?:\\[[^\\]\\n]*\\])?\\s*\\{([^{}\\n]*)$`);

function source(ctx: CompletionContext): CompletionResult | null {
  const get = ctx.state.facet(linkCandidates);
  if (!get) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = OPEN.exec(before);
  if (!m || /(^|[^\\])%/.test(before.slice(0, m.index))) return null;
  const options: Completion[] = get(m[1] as LinkCommand).map((c) => ({
    label: c.target,
    displayLabel: c.name,
    detail: c.detail,
    type: "file",
    // Typing the closing brace yourself is fine too; this just adds it when missing.
    apply: (view, _c, from, to) => {
      const close = view.state.sliceDoc(to, to + 1) === "}" ? "" : "}";
      view.dispatch({ changes: { from, to, insert: c.target + close }, selection: { anchor: from + c.target.length + 1 }, userEvent: "input.complete" });
    },
  }));
  return { from: ctx.pos - m[2].length, options, validFor: /^[^{}\s%]*$/ };
}

const WIKI = /(^|[^\\])\[\[([^[\]\n]*)$/;

/** `[[query`: every file and folder, best fuzzy matches first; accepting writes `\link{…}`. */
function wikiSource(ctx: CompletionContext): CompletionResult | null {
  const get = ctx.state.facet(linkCandidates);
  if (!get) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const m = WIKI.exec(line.text.slice(0, ctx.pos - line.from));
  if (!m) return null;
  const from = line.from + m.index + m[1].length;
  if (contextAt(ctx.state, from).mode !== "text") return null;
  const [query, alias] = m[2].split("|", 2);
  const scored: { c: LinkCandidate; score: number }[] = [];
  for (const c of get("link")) {
    const score = fuzzyScore(query, c.path ?? c.target);
    if (score !== null) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.c.path ?? "").localeCompare(b.c.path ?? ""));
  const options: Completion[] = scored.slice(0, 50).map(({ c }, i) => ({
    label: c.target,
    displayLabel: c.name,
    detail: c.detail,
    type: "file",
    boost: -i,
    apply: (view, _c, _from, to) => {
      const end = view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to;
      const insert = `\\link${alias?.trim() ? `[${alias.trim()}]` : ""}{${c.target}}`;
      view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length }, userEvent: "input.complete" });
    },
  }));
  return { from: ctx.pos, options, filter: false };
}

const theme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--td-ui)", maxHeight: "16em" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "2px 10px 2px 8px", lineHeight: "1.5" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--td-selection)", color: "var(--td-fg)" },
  ".cm-completionDetail": { marginLeft: "10px", color: "var(--td-muted)", fontStyle: "normal", fontSize: "0.9em" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--td-accent)" },
  ".cm-completionIcon": { display: "none" },
});

/**
 * Enter right after typing a whole command name that takes no arguments (`\alpha`) is a
 * newline, not "accept the suggestion that's exactly what you typed".
 */
function enterOnTypedName(view: EditorView): boolean {
  if (completionStatus(view.state) !== "active") return false;
  const sel = selectedCompletion(view.state);
  if (!sel || sel.type !== "command" || hasArguments(sel)) return false;
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const typed = /\\([A-Za-z]+)$/.exec(line.text.slice(0, pos - line.from))?.[1];
  if (typed !== sel.label) return false;
  closeCompletion(view);
  return false; // let Enter do whatever it does next (newline, list item, \\ in align…)
}

/**
 * Suggestions for links/paths, LaTeX commands and environments. Goes before the snippet
 * extension, so Tab/Enter pick a suggestion while the list is open.
 */
export const linkCompletion = [
  Prec.highest(keymap.of([
    { key: "Enter", run: enterOnTypedName },
    { key: "Tab", run: (v) => completionStatus(v.state) === "active" && acceptCompletion(v) },
  ])),
  autocompletion({ override: [wikiSource, source, ...latexSources], icons: false }),
  userEnvCompartment.of(userEnvironments.of([])),
  theme,
];
