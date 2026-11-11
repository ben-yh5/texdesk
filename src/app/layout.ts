// Editor groups and tabs, VS Code style: the window holds one or more groups side by side,
// each with its own tabs. A tab is a text file, a PDF or a folder overview (the open
// document's build has a pane of its own). Pure functions on an immutable layout, so the rules are testable.

export type TabKind = "text" | "pdf" | "overview";

export interface Tab {
  id: string;
  kind: TabKind;
  /** File path. */
  path: string | null;
  /**
   * A preview tab (shown in italics): opening something else the same way replaces it, like
   * VS Code's. Double-clicking it, or working in it, makes it a normal tab.
   */
  preview?: boolean;
  /** Pages this tab showed before (oldest first) and after (nearest first), like a browser tab's. */
  back?: TabSpec[];
  forward?: TabSpec[];
}

export interface Group {
  id: string;
  tabs: Tab[];
  /** Id of the visible tab. */
  active: string | null;
  /** Relative width (flex grow). */
  size: number;
}

export interface Layout {
  groups: Group[];
  /** The group that last had focus. */
  activeGroup: string;
}

export type TabSpec = Pick<Tab, "kind" | "path">;

let counter = 0;
export const newId = (prefix: string) => `${prefix}${++counter}`;

export function emptyLayout(): Layout {
  const g: Group = { id: newId("g"), tabs: [], active: null, size: 1 };
  return { groups: [g], activeGroup: g.id };
}

const same = (a: TabSpec, b: TabSpec) => a.kind === b.kind && a.path === b.path;

export function findTab(layout: Layout, pred: (t: Tab) => boolean): { group: Group; tab: Tab } | null {
  for (const group of layout.groups) {
    const tab = group.tabs.find(pred);
    if (tab) return { group, tab };
  }
  return null;
}

export const findSpec = (layout: Layout, spec: TabSpec) => findTab(layout, (t) => same(t, spec));
export const groupById = (layout: Layout, id: string) => layout.groups.find((g) => g.id === id) ?? null;
export const activeTab = (g: Group) => g.tabs.find((t) => t.id === g.active) ?? null;

function withGroup(layout: Layout, id: string, f: (g: Group) => Group): Layout {
  return { ...layout, groups: layout.groups.map((g) => (g.id === id ? f(g) : g)) };
}

/** Makes `tabId` visible in its group and that group the active one. */
export function activate(layout: Layout, tabId: string): Layout {
  const hit = findTab(layout, (t) => t.id === tabId);
  if (!hit) return layout;
  return { ...withGroup(layout, hit.group.id, (g) => ({ ...g, active: tabId })), activeGroup: hit.group.id };
}

/** Shows `spec` where it's already open; otherwise adds it to `groupId` (after its active tab). */
export function reveal(layout: Layout, spec: TabSpec, groupId: string): { layout: Layout; tab: Tab } {
  const hit = findSpec(layout, spec);
  if (hit) return { layout: activate(layout, hit.tab.id), tab: hit.tab };
  return place(layout, spec, groupId);
}

/**
 * Puts `spec` (or the existing tab for it) into `groupId` at `index` (default: after the
 * active tab) and makes it active. Moving a group's last tab out removes that group.
 */
export function place(layout: Layout, spec: TabSpec | Tab, groupId: string, index?: number): { layout: Layout; tab: Tab } {
  const existing = "id" in spec ? findTab(layout, (t) => t.id === spec.id) : findSpec(layout, spec);
  let tab: Tab = existing?.tab ?? { id: newId("t"), kind: spec.kind, path: spec.path };
  // Moving or dropping a tab somewhere on purpose keeps it.
  if (tab.preview && existing && "id" in spec) tab = { ...tab, preview: undefined };
  // A page opened in a tab of its own leaves other tabs' histories (a page is kept in one place).
  let next = existing ? layout : forget(layout, (s) => same(s, spec));
  let at = index;
  if (existing) {
    const from = existing.group;
    const fromIndex = from.tabs.findIndex((t) => t.id === tab.id);
    if (from.id === groupId && at !== undefined && fromIndex < at) at--; // removing it shifts the rest left
    next = removeTab(next, tab.id, from.id !== groupId);
  }
  const target = groupById(next, groupId);
  if (!target) return { layout, tab };
  next = withGroup(next, groupId, (g) => {
    const tabs = [...g.tabs];
    const pos = at ?? (g.active ? tabs.findIndex((t) => t.id === g.active) + 1 : tabs.length);
    tabs.splice(Math.max(0, Math.min(pos, tabs.length)), 0, tab);
    return { ...g, tabs, active: tab.id };
  });
  return { layout: { ...next, activeGroup: groupId }, tab };
}

/**
 * Opens `spec` as `groupId`'s preview tab: where it's already open it's just shown; otherwise
 * it takes the place of the group's current preview tab (or goes after the active tab).
 */
export function openPreview(layout: Layout, spec: TabSpec, groupId: string): { layout: Layout; tab: Tab } {
  const hit = findSpec(layout, spec);
  if (hit) return { layout: activate(layout, hit.tab.id), tab: hit.tab };
  const g = groupById(layout, groupId);
  if (!g) return place(layout, spec, layout.activeGroup);
  const old = g.tabs.findIndex((t) => t.preview);
  const tab: Tab = { id: newId("t"), kind: spec.kind, path: spec.path, preview: true };
  layout = forget(layout, (s) => same(s, spec));
  if (old < 0) {
    const res = place(layout, spec, groupId);
    const tabbed = withGroup(res.layout, groupId, (x) => ({ ...x, tabs: x.tabs.map((t) => (t.id === res.tab.id ? { ...t, preview: true } : t)) }));
    return { layout: tabbed, tab: { ...res.tab, preview: true } };
  }
  const tabs = [...g.tabs];
  tabs[old] = tab;
  return { layout: { ...withGroup(layout, groupId, (x) => ({ ...x, tabs, active: tab.id })), activeGroup: groupId }, tab };
}

/** Removes the pages matching `drop` from every tab's back/forward history. */
export function forget(layout: Layout, drop: (s: TabSpec) => boolean): Layout {
  const keep = (list?: TabSpec[]) => list?.filter((s) => !drop(s));
  return {
    ...layout,
    groups: layout.groups.map((g) => ({ ...g, tabs: g.tabs.map((t) => (t.back?.some(drop) || t.forward?.some(drop) ? { ...t, back: keep(t.back), forward: keep(t.forward) } : t)) })),
  };
}

/** Is `spec` open in a tab, or in a tab's back/forward history? */
export const remembered = (layout: Layout, spec: TabSpec) =>
  layout.groups.some((g) => g.tabs.some((t) => same(t, spec) || t.back?.some((s) => same(s, spec)) || t.forward?.some((s) => same(s, spec))));

/** Tab `old` becomes a new tab (new id, so its pane remounts) showing `spec` with history `back`/`forward`. */
function swap(layout: Layout, old: Tab, groupId: string, spec: TabSpec, back: TabSpec[], forward: TabSpec[]): Layout {
  const tab: Tab = { id: newId("t"), kind: spec.kind, path: spec.path, ...(old.preview ? { preview: true } : {}), back, forward };
  return {
    ...withGroup(layout, groupId, (g) => ({ ...g, tabs: g.tabs.map((t) => (t.id === old.id ? tab : t)), active: tab.id })),
    activeGroup: groupId,
  };
}

/**
 * Shows `spec` in tab `tabId`'s place, like following a link in a browser tab: what the tab
 * showed goes on its back history and its forward history is cleared. A page is kept in one
 * place only, so `spec` leaves any other tab's history.
 */
export function retarget(layout: Layout, tabId: string, spec: TabSpec): Layout {
  const hit = findTab(layout, (t) => t.id === tabId);
  if (!hit || same(hit.tab, spec)) return layout;
  const was: TabSpec = { kind: hit.tab.kind, path: hit.tab.path };
  const back = [...(hit.tab.back ?? []).filter((s) => !same(s, spec)), was];
  return swap(forget(layout, (s) => same(s, spec)), hit.tab, hit.group.id, spec, back, []);
}

/** Goes back (or forward) a page in tab `tabId`'s history. Null when there's nothing that way. */
export function travel(layout: Layout, tabId: string, dir: "back" | "forward"): Layout | null {
  const hit = findTab(layout, (t) => t.id === tabId);
  const list = hit?.tab[dir];
  if (!hit || !list?.length) return null;
  const was: TabSpec = { kind: hit.tab.kind, path: hit.tab.path };
  const back = hit.tab.back ?? [];
  const forward = hit.tab.forward ?? [];
  return dir === "back"
    ? swap(layout, hit.tab, hit.group.id, back[back.length - 1], back.slice(0, -1), [was, ...forward])
    : swap(layout, hit.tab, hit.group.id, forward[0], [...back, was], forward.slice(1));
}

/** Makes a preview tab a normal one (it stays when something else is previewed). */
export function keepTab(layout: Layout, tabId: string): Layout {
  const hit = findTab(layout, (t) => t.id === tabId);
  if (!hit?.tab.preview) return layout;
  return withGroup(layout, hit.group.id, (g) => ({ ...g, tabs: g.tabs.map((t) => (t.id === tabId ? { ...t, preview: undefined } : t)) }));
}

/** Opens `spec` (or moves its tab) in a new group beside `groupId`, splitting that group's width. */
export function split(layout: Layout, spec: TabSpec | Tab, groupId: string, side: "left" | "right"): { layout: Layout; tab: Tab; group: string } {
  const beside = groupById(layout, groupId);
  if (!beside) return { ...place(layout, spec, layout.activeGroup), group: layout.activeGroup };
  // Splitting a group's only tab off to its own side would just leave an empty group.
  if ("id" in spec && beside.tabs.length === 1 && beside.tabs[0].id === spec.id) return { layout, tab: spec, group: groupId };
  const g: Group = { id: newId("g"), tabs: [], active: null, size: beside.size / 2 };
  let next: Layout = { ...layout, groups: layout.groups.flatMap((x) => (x.id === groupId ? (side === "left" ? [g, { ...x, size: x.size / 2 }] : [{ ...x, size: x.size / 2 }, g]) : [x])) };
  const res = place(next, spec, g.id);
  next = res.layout;
  return { layout: next, tab: res.tab, group: g.id };
}

/**
 * Removes a tab. The group shows the tab next to it (the one to the right, else the
 * left, like VS Code). An emptied group is removed unless it's the last one or
 * `dropEmptyGroup` is false.
 */
export function removeTab(layout: Layout, tabId: string, dropEmptyGroup = true): Layout {
  const hit = findTab(layout, (t) => t.id === tabId);
  if (!hit) return layout;
  const g = hit.group;
  const i = g.tabs.findIndex((t) => t.id === tabId);
  const tabs = g.tabs.filter((t) => t.id !== tabId);
  if (!tabs.length && dropEmptyGroup && layout.groups.length > 1) {
    const gi = layout.groups.findIndex((x) => x.id === g.id);
    const groups = layout.groups.filter((x) => x.id !== g.id);
    // Give its width to a neighbour.
    const n = groups[Math.min(gi, groups.length - 1)];
    const sized = groups.map((x) => (x.id === n.id ? { ...x, size: x.size + g.size } : x));
    return { groups: sized, activeGroup: layout.activeGroup === g.id ? n.id : layout.activeGroup };
  }
  const active = g.active === tabId ? (tabs[i] ?? tabs[i - 1] ?? null)?.id ?? null : g.active;
  return withGroup(layout, g.id, (x) => ({ ...x, tabs, active }));
}

/** Tabs of a group other than `keep` (for "Close Others"), or to the right of it. */
export function others(layout: Layout, tabId: string, which: "others" | "right"): Tab[] {
  const hit = findTab(layout, (t) => t.id === tabId);
  if (!hit) return [];
  const i = hit.group.tabs.findIndex((t) => t.id === tabId);
  return which === "others" ? hit.group.tabs.filter((t) => t.id !== tabId) : hit.group.tabs.slice(i + 1);
}

export function resize(layout: Layout, sizes: number[]): Layout {
  return { ...layout, groups: layout.groups.map((g, i) => ({ ...g, size: sizes[i] ?? g.size })) };
}

/** Points tabs for files under `from` at their new place under `to`. */
export function renamePaths(layout: Layout, moved: (p: string) => string | null): Layout {
  return {
    ...layout,
    groups: layout.groups.map((g) => ({
      ...g,
      tabs: g.tabs.map((t) => {
        const at = <T extends TabSpec>(s: T): T => (s.path && moved(s.path) ? { ...s, path: moved(s.path) } : s);
        return { ...at(t), ...(t.back ? { back: t.back.map(at) } : {}), ...(t.forward ? { forward: t.forward.map(at) } : {}) };
      }),
    })),
  };
}

// ---- saving and restoring ------------------------------------------------------------

export interface SavedLayout {
  groups: { tabs: { kind: TabKind; path: string | null; preview?: boolean }[]; active: number; size: number }[];
  activeGroup: number;
}

/** A plain-data copy for prefs; paths are made relative with `rel`. */
export function serialize(layout: Layout, rel: (p: string) => string): SavedLayout {
  return {
    groups: layout.groups.map((g) => ({
      tabs: g.tabs.map((t) => ({ kind: t.kind, path: t.path === null ? null : rel(t.path), ...(t.preview ? { preview: true } : {}) })),
      active: Math.max(0, g.tabs.findIndex((t) => t.id === g.active)),
      size: g.size,
    })),
    activeGroup: Math.max(0, layout.groups.findIndex((g) => g.id === layout.activeGroup)),
  };
}

/** Rebuilds a saved layout, dropping tabs whose files no longer exist (`keep` returns the absolute path or null). */
export function deserialize(saved: SavedLayout, keep: (t: { kind: TabKind; path: string | null }) => string | null | false): Layout {
  const groups: Group[] = [];
  for (const sg of saved.groups ?? []) {
    const tabs: Tab[] = [];
    let active: string | null = null;
    sg.tabs.forEach((st, i) => {
      // The build's PDF had an "output" tab before it had its own pane.
      if ((st.kind as string) === "output") return;
      const p = keep(st);
      if (!p) return;
      const tab: Tab = { id: newId("t"), kind: st.kind, path: p || null, ...(st.preview ? { preview: true } : {}) };
      tabs.push(tab);
      if (i === sg.active || !active) active = tab.id;
    });
    if (tabs.length) groups.push({ id: newId("g"), tabs, active, size: sg.size > 0 ? sg.size : 1 });
  }
  if (!groups.length) return emptyLayout();
  // Groups dropped above leave the rest with less than the whole row: share it out again.
  const total = groups.reduce((a, g) => a + g.size, 0);
  for (const g of groups) g.size = (g.size / total) * groups.length;
  return { groups, activeGroup: (groups[saved.activeGroup] ?? groups[0]).id };
}
