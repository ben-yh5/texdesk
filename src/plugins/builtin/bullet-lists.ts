// Bullet lists (a built-in TeXdesk plugin; Duplicate it in Settings → Plugins to edit your own copy).
// It expands as you type, in text (not math or code), so the file stays plain LaTeX.
//
// "- " at the start of a line → a bulleted list (itemize); directly inside an itemize, just
// a new \item. One undo (⌘Z) gets back the "- ".
//
// In an itemize:
//   Enter        → a new \item on the next line
//   Enter on an empty \item → ends the list (removes it and continues after \end{itemize},
//                  or as a new \item of the outer itemize when lists are nested)
//   Shift+Enter  → a plain newline, for more text in the same item
//
// In an itemize or enumerate:
//   Tab on an empty \item       → nests it: a new list of the same kind inside the item above
//   Shift+Tab on an empty \item → moves it back out to the outer list

import { snippets, s, key, type Context } from "texdesk";

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


function enter(ctx: Context) {
  const line = ctx.doc.lineAt(ctx.cursor);
  if (!/^\s*\\item\s*$/.test(line.text) || ctx.after.trim()) return "\n\\item $0";
  // An empty item: drop it and leave the list.
  const end = endOfList(ctx.doc, ctx.cursor);
  if (end < 0) return false;
  const outer = ctx.envStack[ctx.envStack.length - 2] === "itemize";
  return [
    ctx.replace({ from: Math.max(0, line.from - 1), to: line.to }, ""),
    ctx.replace({ from: end, to: end }, outer ? "\n\\item $0" : "\n$0"),
  ];
}

export default snippets([
  s(/^(\s*)- $/, (ctx) => {
    // Only the first line needs the indentation: new lines get the current line's automatically.
    const i = ctx.match![1];
    if (ctx.env === "itemize") return `${i}\\item $0`;
    return `${i}\\begin{itemize}\n  \\item $0\n\\end{itemize}`;
  }, { mode: "text", auto: true, description: "- starts a bulleted list" }),
]);

export const keys = [
  key("Enter", { mode: "text", env: "itemize", description: "new \\item (on an empty one: end the list)" }, enter),
  key("Shift-Enter", { mode: "text", env: "itemize", description: "plain newline" }, () => "\n"),
  key("Tab", { mode: "text", env: /^(itemize|enumerate)$/, description: "on an empty \\item: nest it in the item above" }, nest),
  key("Shift-Tab", { mode: "text", env: /^(itemize|enumerate)$/, description: "on an empty nested \\item: move it out a level" }, unnest),
];
