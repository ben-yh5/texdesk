// Fixture: declarative one-liners, mode filters, word boundaries, priorities, Tab triggers.
import { snippets, s } from "texdesk";
import { GREEK } from "./shared";

export default snippets([
  s("mk", "\\($0\\)", { mode: "text", auto: true }),
  s("dm", "\\[\n\t$0\n\\]", { mode: "text", auto: true, wordBoundary: true }),
  s("RR", "\\mathbb{R}", { mode: "math", auto: true }),
  s(/(?<![A-Za-z\\])([A-Za-z])(\d)/, (ctx) => `${ctx.match![1]}_{${ctx.match![2]}}`, { mode: "math", auto: true }),
  s("sr", "^{2}", { mode: "math", auto: true }),
  s("lim", "\\lim_{${1:n} \\to ${2:\\infty}} $0", { mode: "math", auto: true }),
  s("beg", "\\begin{$1}\n\t$0\n\\end{$1}", { mode: "text" }),
  s(new RegExp(`@(${Object.keys(GREEK).join("|")})`), (ctx) => `\\${GREEK[ctx.match![1]]}`, { mode: "math", auto: true }),
  s("ooo", "\\infty", { mode: "math", auto: true, priority: 1 }),
  s("oo", "\\circ", { mode: "math", auto: true }),
  s("dol", "costs $$5", { mode: "text", auto: true }),
]);
