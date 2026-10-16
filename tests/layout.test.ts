import { describe, expect, it } from "vitest";
import { Layout, activeTab, deserialize, emptyLayout, findSpec, keepTab, openPreview, others, place, removeTab, renamePaths, reveal, serialize, split } from "../src/app/layout";

const text = (path: string) => ({ kind: "text" as const, path });
const names = (l: Layout) => l.groups.map((g) => g.tabs.map((t) => (t.path ?? "OUT") + (t.id === g.active ? "*" : "")));

function twoGroups() {
  let l = emptyLayout();
  l = place(l, text("a"), l.groups[0].id).layout;
  l = place(l, text("b"), l.groups[0].id).layout;
  const s = split(l, { kind: "output", path: null }, l.groups[0].id, "right");
  return s.layout;
}

describe("editor groups", () => {
  it("opens tabs after the active one and activates them", () => {
    let l = emptyLayout();
    const g = l.groups[0].id;
    l = place(l, text("a"), g).layout;
    l = place(l, text("c"), g).layout;
    l = reveal(l, text("a"), g).layout;
    l = place(l, text("b"), g).layout;
    expect(names(l)).toEqual([["a", "b*", "c"]]);
  });

  it("reveal activates an open tab wherever it is instead of duplicating it", () => {
    let l = twoGroups();
    l = reveal(l, text("a"), l.groups[1].id).layout;
    expect(names(l)).toEqual([["a*", "b"], ["OUT*"]]);
    expect(l.activeGroup).toBe(l.groups[0].id);
  });

  it("split gives the new group half the width", () => {
    const l = twoGroups();
    expect(names(l)).toEqual([["a", "b*"], ["OUT*"]]);
    expect(l.groups.map((g) => g.size)).toEqual([0.5, 0.5]);
  });

  it("dragging a tab to another group moves it; an emptied group goes away", () => {
    let l = twoGroups();
    const out = findSpec(l, { kind: "output", path: null })!.tab;
    l = place(l, out, l.groups[0].id, 0).layout;
    expect(names(l)).toEqual([["OUT*", "a", "b"]]);
    expect(l.groups[0].size).toBe(1);
  });

  it("reordering within a group accounts for the tab's own slot", () => {
    let l = emptyLayout();
    const g = l.groups[0].id;
    for (const p of ["a", "b", "c"]) l = place(l, text(p), g).layout;
    const a = findSpec(l, text("a"))!.tab;
    l = place(l, a, g, 2).layout; // dropped between b and c
    expect(names(l)).toEqual([["b", "a*", "c"]]);
  });

  it("closing the active tab shows its right neighbour, else the left", () => {
    let l = emptyLayout();
    const g = l.groups[0].id;
    for (const p of ["a", "b", "c"]) l = place(l, text(p), g).layout;
    l = reveal(l, text("b"), g).layout;
    l = removeTab(l, findSpec(l, text("b"))!.tab.id);
    expect(names(l)).toEqual([["a", "c*"]]);
    l = removeTab(l, findSpec(l, text("c"))!.tab.id);
    expect(activeTab(l.groups[0])?.path).toBe("a");
  });

  it("the last group stays even when empty", () => {
    let l = emptyLayout();
    l = place(l, text("a"), l.groups[0].id).layout;
    l = removeTab(l, findSpec(l, text("a"))!.tab.id);
    expect(l.groups.length).toBe(1);
    expect(l.groups[0].active).toBeNull();
  });

  it("splitting a group's only tab off does nothing", () => {
    let l = emptyLayout();
    l = place(l, text("a"), l.groups[0].id).layout;
    const tab = findSpec(l, text("a"))!.tab;
    expect(split(l, tab, l.groups[0].id, "right").layout).toBe(l);
  });

  it("close others / to the right", () => {
    let l = emptyLayout();
    const g = l.groups[0].id;
    for (const p of ["a", "b", "c"]) l = place(l, text(p), g).layout;
    const b = findSpec(l, text("b"))!.tab.id;
    expect(others(l, b, "others").map((t) => t.path)).toEqual(["a", "c"]);
    expect(others(l, b, "right").map((t) => t.path)).toEqual(["c"]);
  });

  it("renames follow a moved folder", () => {
    let l = twoGroups();
    l = renamePaths(l, (p) => (p === "a" ? "x/a" : null));
    expect(names(l)[0]).toEqual(["x/a", "b*"]);
  });

  it("saves and restores, dropping tabs whose files are gone", () => {
    const l = twoGroups();
    const saved = JSON.parse(JSON.stringify(serialize(l, (p) => p)));
    const back = deserialize(saved, (t) => (t.path === "a" ? false : `/W/${t.path}`));
    expect(names(back)).toEqual([["/W/b*"], ["OUT*"]]);
    expect(deserialize({ groups: [], activeGroup: 0 }, () => null).groups.length).toBe(1);
  });

  it("restoring shares the row out again when groups are dropped (a lone group of size 0.5 would fill half the window)", () => {
    const saved = { groups: [{ tabs: [{ kind: "text" as const, path: "a.tex" }], active: 0, size: 0.5 }, { tabs: [{ kind: "pdf" as const, path: "gone.pdf" }], active: 0, size: 0.5 }], activeGroup: 0 };
    const back = deserialize(saved, (t) => (t.path === "a.tex" ? "/W/a.tex" : null));
    expect(back.groups.map((g) => g.size)).toEqual([1]);
    const three = deserialize({ groups: [1, 2, 1].map((size, i) => ({ tabs: [{ kind: "text" as const, path: `${i}` }], active: 0, size })), activeGroup: 0 }, (t) => `/W/${t.path}`);
    expect(three.groups.map((g) => g.size)).toEqual([0.75, 1.5, 0.75]);
  });

  it("a preview tab is replaced by the next preview, kept by keepTab, and restored as it was", () => {
    let l = emptyLayout();
    const g = l.groups[0].id;
    l = place(l, { kind: "text", path: "/a.tex" }, g).layout;
    const a = openPreview(l, { kind: "overview", path: "/W/x" }, g);
    l = a.layout;
    expect(l.groups[0].tabs.map((t) => [t.path, !!t.preview])).toEqual([["/a.tex", false], ["/W/x", true]]);
    // The next preview takes its place; an open tab is just shown.
    l = openPreview(l, { kind: "overview", path: "/W/y" }, g).layout;
    expect(l.groups[0].tabs.map((t) => t.path)).toEqual(["/a.tex", "/W/y"]);
    expect(openPreview(l, { kind: "text", path: "/a.tex" }, g).layout.groups[0].tabs.map((t) => t.path)).toEqual(["/a.tex", "/W/y"]);
    const y = l.groups[0].tabs[1];
    expect(l.groups[0].active).toBe(y.id);
    // Kept: the next preview goes beside it.
    l = keepTab(l, y.id);
    expect(l.groups[0].tabs[1].preview).toBeUndefined();
    l = openPreview(l, { kind: "overview", path: "/W/z" }, g).layout;
    expect(l.groups[0].tabs.map((t) => [t.path, !!t.preview])).toEqual([["/a.tex", false], ["/W/y", false], ["/W/z", true]]);
    const back = deserialize(serialize(l, (p) => p), (t) => t.path);
    expect(back.groups[0].tabs.map((t) => [t.path, !!t.preview])).toEqual([["/a.tex", false], ["/W/y", false], ["/W/z", true]]);
    // Dragging the preview tab somewhere keeps it.
    const z = l.groups[0].tabs[2];
    expect(place(l, z, g, 0).layout.groups[0].tabs[0]).toEqual({ id: z.id, kind: "overview", path: "/W/z" });
  });
});
