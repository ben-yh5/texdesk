// Suggestions while typing: file names inside `\link{…}`, `\input{…}`, `\include{…}`,
// `\lstinputlisting{…}` and `\includegraphics{…}` (the app supplies the workspace's files),
// plus LaTeX commands and environments (latexcomplete.ts).
//
// And, as in Obsidian, `[[` in text searches every file and folder in the workspace (fuzzy,
// by path) and turns into `\link{…}`; `[[name|text` gives `\link[text]{name}`, and
// `[[name#` lists that file's headings (`[[#` this file's) for `\link{name\#Heading}`.
// Typing `[[` adds the closing `]]`; finishing `[[name]]` yourself links to what you typed.

import {
  Completion, CompletionContext, CompletionResult, acceptCompletion, autocompletion, closeCompletion, completionStatus, selectedCompletion,
} from "@codemirror/autocomplete";
import { hasArguments, latexSources, userEnvCompartment, userEnvironments } from "./latexcomplete";
import { Facet, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { LinkCommand, findHeadings } from "../workspace/links";
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

/** Returns the heading titles of the file a `\link` target points to. */
export const linkHeadings = Facet.define<(target: string) => string[], ((target: string) => string[]) | null>({
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

/** Replaces `from`–`to` with `\link[alias]{target}` and puts the cursor after it. */
function writeLink(view: EditorView, from: number, to: number, target: string, alias: string | undefined) {
  const insert = `\\link${alias?.trim() ? `[${alias.trim()}]` : ""}{${target}}`;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.complete" });
}

/** The end of a `[[…` being replaced: past the `]]` after `to`, if it's there. */
const wikiEnd = (view: EditorView, to: number) => (view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to);

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
  const ranked = (q: string) => {
    const scored: { c: LinkCandidate; score: number }[] = [];
    for (const c of get("link")) {
      const score = fuzzyScore(q, c.path ?? c.target);
      if (score !== null) scored.push({ c, score });
    }
    return scored.sort((a, b) => b.score - a.score || (a.c.path ?? "").localeCompare(b.c.path ?? "")).map((x) => x.c);
  };
  const hash = query.indexOf("#");
  if (hash >= 0) {
    // `[[lec3#grad`: headings of the best file match for `lec3` (or this file, for `[[#grad`).
    const fileQuery = query.slice(0, hash).trim();
    const file = fileQuery ? ranked(fileQuery).find((c) => !c.name.endsWith("/")) : null;
    if (fileQuery && !file) return null;
    const titles = file ? ctx.state.facet(linkHeadings)?.(file.target) ?? [] : findHeadings(ctx.state.doc.toString()).map((h) => h.title);
    const headingQuery = query.slice(hash + 1);
    const scored: { title: string; score: number }[] = [];
    for (const title of new Set(titles)) {
      const score = fuzzyScore(headingQuery, title);
      if (score !== null) scored.push({ title, score });
    }
    if (headingQuery.trim()) scored.sort((a, b) => b.score - a.score);
    const options: Completion[] = scored.slice(0, 50).map(({ title }, i) => ({
      label: title,
      detail: file ? file.name : "this file",
      type: "heading",
      boost: -i,
      apply: (view, _c, _from, to) => writeLink(view, from, wikiEnd(view, to), `${file?.target ?? ""}\\#${title.replace(/([%#])/g, "\\$1")}`, alias),
    }));
    return { from: ctx.pos, options, filter: false };
  }
  const options: Completion[] = ranked(query).slice(0, 50).map((c, i) => ({
    label: c.target,
    displayLabel: c.name,
    detail: c.detail,
    type: "file",
    boost: -i,
    apply: (view, _c, _from, to) => writeLink(view, from, wikiEnd(view, to), c.target, alias),
  }));
  return { from: ctx.pos, options, filter: false };
}

/**
 * `[` right after `[` in text adds the closing `]]`. Typing `]` to finish `[[name]]` (stepping
 * over the added `]]`, or typing both) links to the name as typed, so a note that doesn't exist
 * yet can be linked too (⌘-click creates it).
 */
const wikiTyping = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.composing || from !== to || view.state.selection.ranges.length > 1 || (text !== "[" && text !== "]")) return false;
  const { state } = view;
  const line = state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);
  if (text === "[") {
    if (!/(^|[^\\])\[$/.test(before) || state.sliceDoc(from, from + 1) === "]" || contextAt(state, from - 1).mode !== "text") return false;
    view.dispatch({ changes: { from, insert: "[]]" }, selection: { anchor: from + 1 }, userEvent: "input.type", scrollIntoView: true });
    return true;
  }
  // `[[name|]]` with the cursor before the `]]`, or `[[name]|` with the second `]` being typed.
  const closing = state.sliceDoc(from, from + 2) === "]]";
  const m = closing ? WIKI.exec(before) : /(^|[^\\])\[\[([^[\]\n]*)\]$/.exec(before);
  if (!m) return false;
  const start = line.from + m.index + m[1].length;
  const [query, alias] = m[2].split("|", 2);
  if (!query.trim() || contextAt(state, start).mode !== "text") return false;
  writeLink(view, start, closing ? from + 2 : from, query.trim().replace(/\\?#/, "\\#"), alias);
  closeCompletion(view);
  return true;
});

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
  Prec.highest(wikiTyping),
  autocompletion({ override: [wikiSource, source, ...latexSources], icons: false }),
  userEnvCompartment.of(userEnvironments.of([])),
  theme,
];
