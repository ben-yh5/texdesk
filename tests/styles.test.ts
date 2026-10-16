import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Tests run without the stylesheet, so a rule that blocks input would go unnoticed.
describe("styles", () => {
  it("nothing turns off mouse input on PDFs or editors, except while resizing", () => {
    const css = fs.readFileSync(path.join(__dirname, "../src/app/styles.css"), "utf8");
    const blocking = [...css.matchAll(/([^{}]+)\{[^}]*pointer-events:\s*none[^}]*\}/g)]
      .flatMap((m) => m[1].split(",").map((sel) => sel.trim()))
      .filter((sel) => /preview-viewer|pdf-pane|pdf-scroller|editor\b/.test(sel) && !sel.startsWith("body.resizing"));
    expect(blocking).toEqual([]);
  });

  it("no rule styles a tab kind's class on its own (a tab carries its kind, e.g. .overview, as a class)", () => {
    const css = fs.readFileSync(path.join(__dirname, "../src/app/styles.css"), "utf8").replace(/\/\*[^]*?\*\//g, "");
    const kinds = ["text", "pdf", "output", "overview"];
    const clashes = [...css.matchAll(/([^{}]+)\{/g)]
      .flatMap((m) => m[1].split(",").map((sel) => sel.trim()))
      .filter((sel) => kinds.some((k) => new RegExp(`(^|[^\\w-])\\.${k}(?![\\w-])`).test(sel.replace(new RegExp(`\\.tab\\.(${kinds.join("|")})(?![\\w-])`, "g"), ""))));
    expect(clashes).toEqual([]);
  });
});
