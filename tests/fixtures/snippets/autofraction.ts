// Fixture: auto-fraction via previousExpression().
import { snippets, s } from "texdesk";

export default snippets([
  s("/", (ctx) => {
    const num = ctx.previousExpression();
    if (!num) return false;
    return ctx.replace({ from: num.range.from, to: ctx.cursor }, `\\frac{${num.unwrapped}}{$1}$0`);
  }, { mode: "math", auto: true, description: "auto-fraction" }),
]);
