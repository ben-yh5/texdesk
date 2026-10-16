import { snippets, s } from "texdesk";
export default snippets([
  s("boom", () => { throw new Error("kaboom"); }, { auto: true }),
  s("om", "OK", { auto: true }),
]);
