import { describe, expect, it } from "vitest";
import {
  DEFAULT_META, GroupItem, Item, buildOverview, docTitle, filesView, filterOverview, folderMetas, globMatch, moveName, orderNames, placeName, subfolderRows,
} from "../src/workspace/overview";
import { emptyWorkspace } from "../src/workspace/model";

const t = (created: number, modified = created) => ({ created, modified });

describe("ordering", () => {
  const times: Record<string, { created: number; modified: number }> = { a: t(3), b: t(1), c: t(2), "hw10.tex": t(5), "hw2.tex": t(5) };
  it("listed names first, in their order, then the rest oldest first", () => {
    expect(orderNames(["a", "b", "c", "d"], { ...DEFAULT_META, order: ["c", "gone", "a"] }, (n) => times[n])).toEqual(["c", "a", "b", "d"]);
  });
  it("ties and unknown times fall back to a natural name order; sort can be by name or modified", () => {
    expect(orderNames(["hw10.tex", "hw2.tex"], DEFAULT_META, (n) => times[n])).toEqual(["hw2.tex", "hw10.tex"]);
    expect(orderNames(["c", "a", "b"], { ...DEFAULT_META, sort: "name" }, (n) => times[n])).toEqual(["a", "b", "c"]);
    const mod = { x: t(1, 9), y: t(2, 3) };
    expect(orderNames(["x", "y"], { ...DEFAULT_META, sort: "modified" }, (n) => mod[n as "x" | "y"])).toEqual(["y", "x"]);
  });
  it("a folder's order and sort are its own, else its type's", () => {
    const ws = {
      ...emptyWorkspace(),
      folderTypes: { class: { label: "Class", order: ["notes", "hw"], sort: "name" as const } },
      folders: { "Fa30/CS101": { type: "class", fields: { course: "CS 101" } }, "Fa30/MATH": { type: "class", order: ["hw"] }, "x": {} },
    };
    const m = folderMetas(ws);
    expect(m.get("Fa30/CS101")).toEqual({ kind: "class", vars: { course: "CS 101" }, order: ["notes", "hw"], sort: "name" });
    expect(m.get("Fa30/MATH")).toMatchObject({ order: ["hw"], sort: "name" });
    expect(m.get("x")).toEqual({ ...DEFAULT_META, vars: undefined });
  });
  it("moving and placing names", () => {
    expect(moveName(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveName(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(placeName(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
    expect(placeName(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });
});

describe("titles", () => {
  it("\\title, else the first \\section, cleaned up; comments and unfilled templates ignored", () => {
    expect(docTitle("% \\title{Old}\n\\title{Graph \\textbf{Algorithms}\\\\ Part~2}")).toBe("Graph Algorithms Part 2");
    expect(docTitle("\\section*{Lecture 3: Max-Flow \\& Cuts}\n\\section{Later}")).toBe("Lecture 3: Max-Flow & Cuts");
    expect(docTitle("\\title{{{title}}}")).toBe(null);
    expect(docTitle("no title")).toBe(null);
  });
});

describe("the overview", () => {
  const entries = [
    "Fa30", "Fa30/1-CS101", "Fa30/1-CS101/.texdesk.toml", "Fa30/1-CS101/hw", "Fa30/1-CS101/hw/hw1.tex", "Fa30/1-CS101/hw/hw2.tex",
    "Fa30/1-CS101/hw/CS101_hw1.pdf", "Fa30/1-CS101/hw/handout.pdf", "Fa30/1-CS101/hw/.keep",
    "Fa30/1-CS101/notes", "Fa30/1-CS101/notes/intro.tex", "Fa30/1-CS101/notes/flows.tex", "Fa30/2-MATH210", "Fa30/2-MATH210/hw",
  ].map((p) => ({ path: p, isDir: !/\.\w+$/.test(p) }));
  const texts: Record<string, string> = { "Fa30/1-CS101/notes/flows.tex": "\\section*{Max Flow}", "Fa30/1-CS101/hw/hw1.tex": "" };
  const times = new Map(Object.entries({
    "Fa30/1-CS101": t(1), "Fa30/2-MATH210": t(2), "Fa30/1-CS101/notes": t(1), "Fa30/1-CS101/hw": t(2),
    "Fa30/1-CS101/notes/intro.tex": t(10), "Fa30/1-CS101/notes/flows.tex": t(20, 99),
  }));
  const shape = (g: GroupItem): unknown => g.items.map((i: Item) => (i.type === "group" ? { [i.name]: shape(i) } : i.name));
  const build = (folders = new Map()) => buildOverview({
    folder: "Fa30", entries, times, folders, text: (p) => texts[p],
    generated: new Map([["Fa30/1-CS101/hw/CS101_hw1.pdf", "Fa30/1-CS101/hw/hw1.tex"]]),
  });

  it("lists every folder's contents in order, hiding dotfiles and nesting generated PDFs", () => {
    const o = build();
    expect(shape(o)).toEqual([
      { "1-CS101": [{ notes: ["intro.tex", "flows.tex"] }, { hw: ["handout.pdf", "hw1.tex", "hw2.tex"] }] },
      { "2-MATH210": [{ hw: [] }] },
    ]);
    const cse = o.items[0] as GroupItem;
    const flows = (cse.items[0] as GroupItem).items[1];
    expect(flows).toEqual({ type: "doc", name: "flows.tex", path: "Fa30/1-CS101/notes/flows.tex", title: "Max Flow", modified: 99, created: 20, pdf: null });
    const hw1 = (cse.items[1] as GroupItem).items[1];
    expect(hw1).toMatchObject({ type: "doc", pdf: "Fa30/1-CS101/hw/CS101_hw1.pdf" });
    expect((cse.items[1] as GroupItem).items[0]).toMatchObject({ type: "file", name: "handout.pdf" });
  });

  it("each folder's own order applies, and kinds are shown", () => {
    const o = build(new Map([
      ["Fa30/1-CS101", { kind: "course", order: ["hw"], sort: "created" as const }],
      ["Fa30/1-CS101/notes", { kind: null, order: ["flows.tex"], sort: "created" as const }],
    ]));
    const cse = o.items[0] as GroupItem;
    expect(cse.kind).toBe("course");
    expect(shape(cse)).toEqual([{ hw: ["handout.pdf", "hw1.tex", "hw2.tex"] }, { notes: ["flows.tex", "intro.tex"] }]);
  });

  it("filtering keeps matching documents and the folders they're in", () => {
    expect(shape(filterOverview(build(), (d) => d.name.startsWith("hw")))).toEqual([{ "1-CS101": [{ hw: ["hw1.tex", "hw2.tex"] }] }]);
  });

  const typed = new Map([
    ["Fa30/1-CS101", { kind: "course", order: ["notes", "hw"], sort: "created" as const }],
    ["Fa30/2-MATH210", { kind: "course", order: [], sort: "created" as const }],
  ]);
  const input = { folder: "Fa30", entries, times, folders: typed, text: (p: string) => texts[p], generated: new Map([["Fa30/1-CS101/hw/CS101_hw1.pdf", "Fa30/1-CS101/hw/hw1.tex"]]) };

  it("a Files block with no rules is the plain overview", () => {
    expect(filesView(input, { type: "files" })).toEqual(buildOverview(input));
  });

  it("a Files block can show one subfolder, or the same subfolder in every folder of a type", () => {
    expect(shape(filesView({ ...input, folder: "Fa30/1-CS101" }, { type: "files", subfolder: "hw" }))).toEqual(["handout.pdf", "hw1.tex", "hw2.tex"]);
    const every = filesView(input, { type: "files", inType: "course", subfolder: "hw" });
    expect(shape(every)).toEqual([{ "1-CS101 / hw": ["handout.pdf", "hw1.tex", "hw2.tex"] }, { "2-MATH210 / hw": [] }]);
    expect((every.items[0] as GroupItem).kind).toBe(null); // shown in place, not as a link
  });

  it("filters by kind of file, name and date; groups and sorts", () => {
    const docsOnly = filesView({ ...input, folder: "Fa30/1-CS101" }, { type: "files", pdfs: false });
    expect(shape(docsOnly)).toEqual([{ notes: ["intro.tex", "flows.tex"] }, { hw: ["hw1.tex", "hw2.tex"] }]);
    expect(shape(filesView(input, { type: "files", inType: "course", name: "hw*.tex", groupBy: "none" }))).toEqual(["hw1.tex", "hw2.tex"]);
    const now = 100 + 2 * 86_400_000;
    const recent = filesView({ ...input, times: new Map([...times, ["Fa30/1-CS101/notes/flows.tex", t(20, now - 1000)]]) }, { type: "files", modifiedDays: 1, groupBy: "none" }, now);
    expect(shape(recent)).toEqual(["flows.tex"]);
    const byClass = filesView(input, { type: "files", docs: true, pdfs: false, groupBy: "typed", sort: "name", desc: true });
    expect(shape(byClass)).toEqual([{ "1-CS101": ["intro.tex", "hw2.tex", "hw1.tex", "flows.tex"] }]);
    expect(shape(filesView({ ...input, folder: "Fa30/1-CS101/notes" }, { type: "files", sort: "title" }))).toEqual(["intro.tex", "flows.tex"]);
    expect(shape(filesView({ ...input, folder: "Fa30/1-CS101/hw" }, { type: "files", limit: 2 }))).toEqual(["handout.pdf", "hw1.tex"]);
  });

  it("a Subfolders block lists the nearest typed folders with their fields and counts", () => {
    const ws = { ...emptyWorkspace(), folders: { "Fa30/1-CS101": { type: "course", fields: { course: "CS 101" } }, "Fa30/2-MATH210": { type: "course" } } };
    expect(subfolderRows(input, ws, { type: "subfolders", counts: ["notes", "hw"] })).toEqual([
      { name: "1-CS101", path: "Fa30/1-CS101", kind: "course", fields: [{ key: "course", value: "CS 101" }], counts: [{ name: "notes", count: 2 }, { name: "hw", count: 2 }] },
      { name: "2-MATH210", path: "Fa30/2-MATH210", kind: "course", fields: [], counts: [{ name: "notes", count: 0 }, { name: "hw", count: 0 }] },
    ]);
    expect(subfolderRows(input, ws, { type: "subfolders", folderType: "term" })).toEqual([]);
  });

  it("globs", () => {
    expect(globMatch("hw*.tex", "hw12.tex")).toBe(true);
    expect(globMatch("hw?.tex", "HW1.tex")).toBe(true);
    expect(globMatch("hw*.tex", "notes.tex")).toBe(false);
  });
});
