// Fixture: visual wrap over a selection.
import { snippets, s } from "texdesk";

export default snippets([
  s("U", (ctx) => `\\underbrace{${ctx.selection}}_{$1}$0`, { mode: "math", visual: true }),
]);
