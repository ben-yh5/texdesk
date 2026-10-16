// Fixture: generated matrix with a numbered tab stop in every cell.
import { snippets, s } from "texdesk";

export default snippets([
  s(/([pbv])mat(\d)(\d)/, (ctx) => {
    const m = ctx.match!;
    const [r, c] = [+m[2], +m[3]];
    let n = 1;
    const rows = Array.from({ length: r }, () =>
      Array.from({ length: c }, () => `$${n++}`).join(" & "));
    return `\\begin{${m[1]}matrix}\n${rows.join(" \\\\\n")}\n\\end{${m[1]}matrix}$0`;
  }, { mode: "math", auto: true, description: "generated matrix" }),
]);
