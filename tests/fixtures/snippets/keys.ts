// Fixture: environment-scoped key handlers.
import { key } from "texdesk";

export const keys = [
  key("Tab", { env: /matrix|align|array|cases/ }, (ctx) => ctx.insert(" & ")),
  key("Enter", { env: /matrix|align|array|cases/, mode: "math" }, (ctx) => ctx.insert(" \\\\\n")),
];
