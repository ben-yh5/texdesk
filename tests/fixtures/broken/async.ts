import { snippets, s } from "texdesk";
export default snippets([
  // @ts-expect-error — snippets must be synchronous
  s("as", async () => "never", { auto: true }),
]);
