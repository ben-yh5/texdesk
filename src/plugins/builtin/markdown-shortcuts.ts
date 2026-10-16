// Markdown shortcuts (a built-in TeXdesk plugin; Duplicate it in Settings → Plugins to edit your own copy).
// They expand as you type, in text (not math or code), so the file stays plain LaTeX.
//
// At the start of a line:
//   "* "              → a bulleted list (itemize); inside a list, a new \item
//                       (for "- ", turn on the Bullet lists plugin)
//   "1. "             → a numbered list (enumerate); inside a list, a new \item
//   "# ", "## ", "### " → \section{}, \subsection{}, \subsubsection{}
//   "> "              → a quote
//   "```"             → a code block (lstlisting); type the language, Tab, then the code
// Anywhere in text:
//   **bold** → \textbf{}   *emphasis* → \emph{}   `code` → \lstinline   [text](url) → \href
// In a list:
//   Tab on an empty \item       → nests it: a new list of the same kind inside the item above
//   Shift+Tab on an empty \item → moves it back out to the outer list
// On a selection:
//   *  → \emph{selection}; * again → \textbf{selection} (so ** bolds); a third * → \textbf{\emph{…}}
//   `  → \lstinline|selection| (on one line)

import { snippets, s, key, type Context } from "texdesk";

/** Text from the trigger, inserted literally ($ is special in snippet strings). */
const lit = (t: string) => t.replace(/\$/g, "$$$$");
const balanced = (t: string) => {
  let d = 0;
  for (const c of t.replace(/\\[{}]/g, "")) if ((d += c === "{" ? 1 : c === "}" ? -1 : 0) < 0) return false;
  return d === 0;
};
/** `\cmd{selection}` with the selection still selected (as tab stop 1) when it can be. */
const wrap = (cmd: string, t: string) => balanced(t) ? `\\${cmd}{\${1:${lit(t)}}}$0` : `\\${cmd}{${lit(t)}}$0`;

/** * over a selection: emphasize it, or turn an emphasis that's exactly the selection into bold. */
function star(ctx: Context) {
  const t = ctx.selection;
  if (ctx.before.endsWith("\\emph{") && ctx.after.startsWith(t + "}")) {
    const from = ctx.triggerRange.from - "\\emph{".length;
    return ctx.replace({ from, to: ctx.triggerRange.to + 1 }, wrap("textbf", t));
  }
  return wrap("emph", t);
}

const LIST = /\\(begin|end)\{(?:itemize|enumerate)\}|\\item\b/g;
const isList = (env?: string) => env === "itemize" || env === "enumerate";
const emptyItem = (ctx: Context) => /^\s*\\item\s*$/.test(ctx.doc.lineAt(ctx.cursor).text) && !ctx.after.trim();

/** The innermost list around `pos`: where its \begin is, and whether one of its \items comes before `pos`. */
function listBefore(doc: Context["doc"], pos: number): { begin: number; item: boolean } | null {
  const ms = [...doc.slice(0, pos).matchAll(LIST)];
  let depth = 0, item = false;
  for (let k = ms.length - 1; k >= 0; k--) {
    const m = ms[k];
    if (!m[1]) item ||= depth === 0;
    else if (m[1] === "end") depth++;
    else if (depth-- === 0) return { begin: m.index!, item };
  }
  return null;
}

/** Where the \end{…} closing the list at `from` ends, or -1. */
function endOfList(doc: Context["doc"], from: number): number {
  const rest = doc.slice(from);
  let depth = 1;
  for (const m of rest.matchAll(LIST)) {
    if (m[1] === "begin") depth++;
    else if (m[1] === "end" && --depth === 0) return from + m.index! + m[0].length;
  }
  return -1;
}

/** Tab on an empty \item: make it the first item of a list nested in the previous item. */
function nest(ctx: Context) {
  if (!emptyItem(ctx)) return false;
  const line = ctx.doc.lineAt(ctx.cursor);
  if (!listBefore(ctx.doc, line.from)?.item) return false;
  const from = line.from + /^\s*/.exec(line.text)![0].length;
  return ctx.replace({ from, to: line.to }, `\\begin{${ctx.env}}\n\t\\item $0\n\\end{${ctx.env}}`);
}

/** Shift+Tab on an empty \item of a nested list: move it out to the outer list. */
function unnest(ctx: Context) {
  if (!emptyItem(ctx) || !isList(ctx.envStack[ctx.envStack.length - 2])) return false;
  const line = ctx.doc.lineAt(ctx.cursor);
  const list = listBefore(ctx.doc, line.from);
  const end = endOfList(ctx.doc, line.to);
  if (!list || end < 0) return false;
  // Its only item: the nested list goes away.
  if (/^\\begin\{\w+\}\s*$/.test(ctx.doc.slice(list.begin, line.from)) && /^\s*\\end\{\w+\}$/.test(ctx.doc.slice(line.to, end)))
    return ctx.replace({ from: list.begin, to: end }, "\\item $0");
  return [
    ctx.replace({ from: Math.max(0, line.from - 1), to: line.to }, ""),
    ctx.replace({ from: end, to: end }, "\n\\item $0"),
  ];
}

/** \lstinline with a delimiter that isn't in the code. */
function inlineCode(code: string) {
  const d = ["|", "!", "+", "@", "~"].find((c) => !code.includes(c)) ?? "|";
  return `\\lstinline${d}${lit(code)}${d}`;
}

const inList = (ctx: Context) => isList(ctx.env);

function list(kind: "itemize" | "enumerate") {
  return (ctx: Context) => {
    // Only the first line needs the indentation: new lines get the current line's automatically.
    const i = ctx.match![1];
    if (inList(ctx)) return `${i}\\item $0`;
    return `${i}\\begin{${kind}}\n  \\item $0\n\\end{${kind}}`;
  };
}

const heading = (cmd: string) => (ctx: Context) => `${ctx.match![1]}\\${cmd}{$1}$0`;

export default snippets([
  s(/^(\s*)\* $/, list("itemize"), { mode: "text", auto: true, description: "* starts a bulleted list" }),
  s(/^(\s*)1\. $/, list("enumerate"), { mode: "text", auto: true, description: "1. starts a numbered list" }),
  s(/^(\s*)# $/, heading("section"), { mode: "text", auto: true, description: "# section" }),
  s(/^(\s*)## $/, heading("subsection"), { mode: "text", auto: true, description: "## subsection" }),
  s(/^(\s*)### $/, heading("subsubsection"), { mode: "text", auto: true, description: "### subsubsection" }),
  s(/^(\s*)> $/, (ctx) => { const i = ctx.match![1]; return `${i}\\begin{quote}\n  $0\n\\end{quote}`; }, { mode: "text", auto: true, description: "> quote" }),
  s(/^(\s*)```$/, (ctx) => { const i = ctx.match![1]; return `${i}\\begin{lstlisting}[language=$1]\n$2\n\\end{lstlisting}`; }, { mode: "text", auto: true, description: "``` code block" }),

  s(/\*\*([^*\n]+)\*\*$/, (ctx) => `\\textbf{${lit(ctx.match![1])}}`, { mode: "text", auto: true, description: "**bold**" }),
  s(/(?<![*\\])\*([^*\s][^*\n]*?)\*$/, (ctx) => `\\emph{${lit(ctx.match![1])}}`, { mode: "text", auto: true, description: "*emphasis*" }),
  s("*", star, { mode: "text", visual: true, description: "* on a selection: emphasis, then bold" }),
  s(/`([^`\n]+)`$/, (ctx) => inlineCode(ctx.match![1]), { mode: "text", auto: true, description: "`code`" }),
  s("`", (ctx) => !ctx.selection.includes("\n") && inlineCode(ctx.selection), { mode: "text", visual: true, description: "` on a selection: inline code" }),
  s(/\[([^\]\n]+)\]\(([^)\s]+)\)$/, (ctx) => `\\href{${lit(ctx.match![2])}}{${lit(ctx.match![1])}}`, { mode: "text", auto: true, description: "[text](url)" }),
]);

export const keys = [
  key("Tab", { mode: "text", env: /^(itemize|enumerate)$/, description: "on an empty \\item: nest it in the item above" }, nest),
  key("Shift-Tab", { mode: "text", env: /^(itemize|enumerate)$/, description: "on an empty nested \\item: move it out a level" }, unnest),
];
