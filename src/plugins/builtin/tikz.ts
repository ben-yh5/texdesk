// TikZ diagrams (a built-in TeXdesk plugin; Duplicate it in Settings → Plugins to edit your own copy).
//
// "tikz" and a space, alone on a line → an empty tikzpicture, opened in the diagram editor.

import { snippets, s, type Context } from "texdesk";

export default snippets([
  s(/^(\s*)tikz $/, (ctx: Context) => `${ctx.match![1]}\\begin{tikzpicture}\n\t$0\n\\end{tikzpicture}`, {
    mode: "text", auto: true, command: "edit_diagram", description: "tikzpicture, opened in the diagram editor",
  }),
]);
