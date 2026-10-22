import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { forwardSearch, forwardSearchAll, inverseSearch, parseSynctex } from "../src/preview/synctex";

// Real Tectonic output for tests/fixtures/doc.tex (Input:1 path rewritten to /W/hw/doc.tex).
const sync = parseSynctex(fs.readFileSync(path.join(__dirname, "fixtures", "doc.synctex"), "utf8"));
const FILE = "/W/hw/doc.tex";
const DIR = "/W/hw/.build";

describe("synctex parsing", () => {
  it("reads inputs and pages, converting scaled points to PDF points", () => {
    expect(sync.inputs.get(1)).toBe(FILE);
    expect([...sync.pages.keys()]).toEqual([1, 2]);
    const first = sync.pages.get(1)!.find((r) => r.line === 4 && r.kind === "leaf")!;
    expect(first.y).toBeCloseTo(83.95, 1); // 1in margin + first baseline
    expect(sync.pages.get(1)!.find((r) => r.kind === "box")!.x).toBeCloseTo(72, 1); // 1in left margin
  });
});

describe("forward search (source → PDF)", () => {
  it("finds the page and row of a line", () => {
    const l4 = forwardSearch(sync, FILE, 4, DIR)!;
    expect(l4.page).toBe(1);
    expect(l4.y).toBeLessThan(84);
    expect(l4.y).toBeGreaterThan(70);
    expect(forwardSearch(sync, FILE, 6, DIR)!.y).toBeGreaterThan(l4.y);
    expect(forwardSearch(sync, FILE, 11, DIR)!.page).toBe(2);
  });
  it("lines without output map to the nearest line above", () => {
    expect(forwardSearch(sync, FILE, 5, DIR)!.y).toBeCloseTo(forwardSearch(sync, FILE, 4, DIR)!.y, 1); // blank line
    expect(forwardSearch(sync, FILE, 10, DIR)!.page).toBe(1); // \newpage → last output line before it
  });
  it("tolerates macOS /private paths", () => {
    const s2 = parseSynctex(fs.readFileSync(path.join(__dirname, "fixtures", "doc.synctex"), "utf8").replace(FILE, "/private" + FILE));
    expect(forwardSearch(s2, FILE, 4, DIR)?.page).toBe(1);
  });
  it("finds every page a line is on, with the line it matched", () => {
    const pages = new Map(sync.pages);
    pages.set(2, [...pages.get(2)!, ...pages.get(1)!.filter((r) => r.line === 4)]); // e.g. a running header
    const all = forwardSearchAll({ ...sync, pages }, FILE, 4, DIR);
    expect(all.map((l) => l.page)).toEqual([1, 2]);
    expect(all[0].line).toBe(4);
  });
  it("skips the page TeX was finishing when it read the line (its header and footer carry that line too)", () => {
    // Real Tectonic output for tests/fixtures/pagebreak.tex: a list running over three pages.
    const pb = parseSynctex(fs.readFileSync(path.join(__dirname, "fixtures", "pagebreak.synctex"), "utf8"));
    const FILE2 = "/W/hw/pagebreak.tex";
    expect(forwardSearchAll(pb, FILE2, 36, DIR).map((l) => l.page)).toEqual([2]); // TeX had read on to item 32 when page 1 went out
    expect(forwardSearchAll(pb, FILE2, 64, DIR).map((l) => l.page)).toEqual([3]);
    expect(forwardSearchAll(pb, FILE2, 31, DIR).map((l) => l.page)).toEqual([1]);
  });
  it("returns null for files not in the document", () => {
    expect(forwardSearch(sync, "/W/hw/other.tex", 4, DIR)).toBe(null);
  });
});

describe("inverse search (PDF → source)", () => {
  it("maps clicks on text rows to their source lines", () => {
    expect(inverseSearch(sync, 1, 150, 82)).toEqual({ file: FILE, line: 4 });
    expect(inverseSearch(sync, 1, 250, 96)).toEqual({ file: FILE, line: 6 });
    expect(inverseSearch(sync, 2, 120, 82)).toEqual({ file: FILE, line: 11 });
  });
  it("finds the display math", () => {
    const l = inverseSearch(sync, 1, 300, 129)!;
    expect(l.line).toBeGreaterThanOrEqual(7);
    expect(l.line).toBeLessThanOrEqual(9);
  });
  it("returns null for a page with no records", () => {
    expect(inverseSearch(sync, 9, 0, 0)).toBe(null);
  });
});
