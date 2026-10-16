// The folder overview: a folder's documents and files, grouped by subfolder, in the order
// you've set (a folder's `order`, or its type's) with the rest by creation date — and the
// rules an overview layout's blocks apply on top (which files, grouped and sorted how).
// Pure functions over the file list, so the rules are testable; the view is Overview.tsx.

import type { FileTimes, WalkEntry } from "../host/types";
import type { FilesBlock, SortKey, SubfoldersBlock, WorkspaceFile } from "./model";

export type { SortKey } from "./model";

/** What workspace.json says about a folder, for its overview. */
export interface FolderMeta {
  /** Its folder type, if any. */
  kind: string | null;
  /** Its field values (e.g. course), so ⌘K can find it by them. */
  vars?: Record<string, string>;
  /** Names (files and subfolders) in the order to show them; unlisted ones come after. */
  order: string[];
  /** How unlisted names are sorted. */
  sort: SortKey;
}

export const DEFAULT_META: FolderMeta = { kind: null, order: [], sort: "created" };

/** Each folder's overview settings (its own, else its type's), by relative path. */
export function folderMetas(ws: WorkspaceFile): Map<string, FolderMeta> {
  const out = new Map<string, FolderMeta>();
  for (const [p, f] of Object.entries(ws.folders)) {
    const t = f.type ? ws.folderTypes[f.type] : undefined;
    out.set(p, { kind: f.type ?? null, vars: f.fields, order: f.order ?? t?.order ?? [], sort: f.sort ?? t?.sort ?? "created" });
  }
  return out;
}

export interface DocItem {
  type: "doc" | "file";
  name: string;
  /** Workspace-relative path. */
  path: string;
  /** For .tex files: the title from \title{} or the first \section{}, if any. */
  title: string | null;
  modified: number | null;
  created: number | null;
  /** The document's exported PDF next to it (relative path), if it has one. */
  pdf: string | null;
}

export interface GroupItem {
  type: "group";
  name: string;
  path: string;
  kind: string | null;
  items: Item[];
}

export type Item = DocItem | GroupItem;

export interface OverviewInput {
  /** Workspace-relative folder to show. */
  folder: string;
  entries: WalkEntry[];
  /** Generated PDF (relative) → its source .tex (relative). */
  generated: Map<string, string>;
  /** Text of a .tex file (relative path), if known. */
  text: (path: string) => string | undefined;
  /** Folder (relative) → its overview settings; missing = defaults. */
  folders: Map<string, FolderMeta>;
  /** Relative path → times. */
  times: Map<string, FileTimes>;
}

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/**
 * `names` in display order: those in `meta.order` first, in that order, then the rest by
 * `meta.sort` (oldest first for dates; ties and unknown times by name).
 */
export function orderNames(names: string[], meta: FolderMeta, time: (name: string) => FileTimes | undefined): string[] {
  const rank = new Map(meta.order.map((n, i) => [n, i]));
  const listed = names.filter((n) => rank.has(n)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  const key = (n: string) => (meta.sort === "name" ? undefined : time(n)?.[meta.sort]);
  const rest = names.filter((n) => !rank.has(n)).sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka !== undefined && kb !== undefined && ka !== kb) return ka - kb;
    if (ka !== undefined && kb === undefined) return -1;
    if (ka === undefined && kb !== undefined) return 1;
    return natural(a, b);
  });
  return [...listed, ...rest];
}

/** Text of the first `{…}` group at or after `i` (balanced), or null. */
function braceArg(text: string, i: number): string | null {
  if (text[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "\\") { j++; continue; }
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return text.slice(i + 1, j);
  }
  return null;
}

/** A document's title: `\title{…}`, else its first `\section{…}` (comments ignored), cleaned up for display. */
export function docTitle(text: string): string | null {
  const body = text.replace(/(^|[^\\])%.*$/gm, "$1");
  for (const re of [/\\title\s*(?:\[[^\]]*\])?\s*(?=\{)/, /\\section\*?\s*(?:\[[^\]]*\])?\s*(?=\{)/]) {
    const m = re.exec(body);
    const arg = m ? braceArg(body, m.index + m[0].length) : null;
    if (arg === null || arg.includes("{{")) continue;
    const clean = arg
      .replace(/\\\\(\[[^\]]*\])?/g, " ")
      .replace(/\\[a-zA-Z@]+\*?\s*(\[[^\]]*\])?/g, "")
      .replace(/\\([#$%&_{}])/g, "$1")
      .replace(/[{}]/g, "")
      .replace(/~/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (clean) return clean;
  }
  return null;
}

/** The overview of `input.folder`: its files and subfolders (recursively), each folder in its own order. */
export function buildOverview(input: OverviewInput): GroupItem {
  const children = new Map<string, WalkEntry[]>();
  const pdfFor = new Map<string, string>();
  for (const [pdf, src] of input.generated) if (parentOf(pdf) === parentOf(src)) pdfFor.set(src, pdf);
  for (const e of input.entries) {
    // Hidden: dotfiles (.keep, .build…), generated PDFs (shown with their source).
    if (e.path.split("/").some((part) => part.startsWith("."))) continue;
    if (!e.isDir && input.generated.has(e.path)) continue;
    const parent = parentOf(e.path);
    const list = children.get(parent) ?? [];
    list.push(e);
    children.set(parent, list);
  }
  const group = (path: string): GroupItem => {
    const meta = input.folders.get(path) ?? DEFAULT_META;
    const kids = children.get(path) ?? [];
    const byName = new Map(kids.map((e) => [nameOf(e.path), e]));
    const ordered = orderNames([...byName.keys()], meta, (n) => input.times.get(path ? `${path}/${n}` : n));
    const items: Item[] = ordered.map((n) => {
      const e = byName.get(n)!;
      if (e.isDir) return group(e.path);
      const tex = e.path.endsWith(".tex");
      const text = tex ? input.text(e.path) : undefined;
      return {
        type: tex ? "doc" : "file", name: n, path: e.path,
        title: text !== undefined ? docTitle(text) : null,
        modified: input.times.get(e.path)?.modified ?? null,
        created: input.times.get(e.path)?.created ?? null,
        pdf: pdfFor.get(e.path) ?? null,
      };
    });
    return { type: "group", name: nameOf(path), path, kind: meta.kind, items };
  };
  return group(input.folder);
}

/** `group` minus items that don't match `keep`; groups with nothing left are dropped. */
export function filterOverview(group: GroupItem, keep: (d: DocItem) => boolean): GroupItem {
  const items: Item[] = [];
  for (const it of group.items) {
    if (it.type === "group") {
      const g = filterOverview(it, keep);
      if (g.items.length) items.push(g);
    } else if (keep(it)) items.push(it);
  }
  return { ...group, items };
}

/** `names` with `name` moved by `delta` places (clamped). */
export function moveName(names: string[], name: string, delta: number): string[] {
  const i = names.indexOf(name);
  if (i < 0) return names;
  const j = Math.min(Math.max(i + delta, 0), names.length - 1);
  const out = names.filter((n) => n !== name);
  out.splice(j, 0, name);
  return out;
}

/** `names` with `name` placed just before `before` (or at the end if null). */
export function placeName(names: string[], name: string, before: string | null): string[] {
  const out = names.filter((n) => n !== name);
  const at = before === null ? out.length : out.indexOf(before);
  out.splice(at < 0 ? out.length : at, 0, name);
  return out;
}

// ---- layout blocks ------------------------------------------------------------------------

/** A glob on file names: `*` any run, `?` one character, case-insensitive. */
export function globMatch(glob: string, name: string): boolean {
  const re = glob.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${re}$`, "i").test(name);
}

const findGroup = (g: GroupItem, path: string): GroupItem | null => {
  if (g.path === path) return g;
  for (const it of g.items) if (it.type === "group") { const hit = findGroup(it, path); if (hit) return hit; }
  return null;
};

/** Every document and file under `g`, depth first. */
function allDocs(g: GroupItem): DocItem[] {
  return g.items.flatMap((it) => (it.type === "group" ? allDocs(it) : [it]));
}

/** Typed groups under `g`, not counting `g` itself, including ones inside other typed groups. */
function typedGroups(g: GroupItem, type?: string): GroupItem[] {
  return g.items.flatMap((it) => (it.type !== "group" ? [] : [...(it.kind && (!type || it.kind === type) ? [it] : []), ...typedGroups(it, type)]));
}

function compare(sort: FilesBlock["sort"], desc: boolean) {
  const sign = desc ? -1 : 1;
  const name = (i: Item) => i.name;
  return (a: Item, b: Item) => {
    let d = 0;
    if (sort === "title") d = natural((a.type === "group" ? a.name : a.title ?? a.name), (b.type === "group" ? b.name : b.title ?? b.name));
    else if (sort === "created" || sort === "modified") {
      const ta = a.type === "group" ? null : a[sort], tb = b.type === "group" ? null : b[sort];
      d = (ta ?? 0) - (tb ?? 0);
    }
    return sign * (d || natural(name(a), name(b)));
  };
}

const isFiltered = (b: FilesBlock) => b.docs === false || b.pdfs === false || b.other === false || !!b.name || !!b.modifiedDays;

/** What a Files block shows for `input.folder`: its rules applied to the folder's overview. */
export function filesView(input: OverviewInput, block: FilesBlock, now = Date.now()): GroupItem {
  const full = buildOverview(input);
  let base: GroupItem;
  if (block.inType) {
    const groups = typedGroups(full, block.inType).map((g) => {
      const inner = block.subfolder ? findGroup(g, `${g.path}/${block.subfolder}`) : g;
      return { ...(inner ?? { type: "group" as const, path: `${g.path}/${block.subfolder}`, items: [] }), kind: null, name: block.subfolder ? `${g.name} / ${block.subfolder}` : g.name };
    });
    base = { ...full, items: groups };
  } else if (block.subfolder) {
    const path = full.path ? `${full.path}/${block.subfolder}` : block.subfolder;
    base = findGroup(full, path) ?? { type: "group", name: block.subfolder, path, kind: null, items: [] };
  } else base = full;

  const keep = (d: DocItem) => {
    const pdf = d.name.toLowerCase().endsWith(".pdf");
    if (d.type === "doc" ? block.docs === false : pdf ? block.pdfs === false : block.other === false) return false;
    if (block.name && !globMatch(block.name, d.name)) return false;
    if (block.modifiedDays && (d.modified === null || now - d.modified > block.modifiedDays * 86_400_000)) return false;
    return true;
  };
  const sort = block.sort ?? "order";
  const cmp = compare(sort, !!block.desc);
  const groupBy = block.groupBy ?? "subfolder";

  if (groupBy === "subfolder") {
    let g = isFiltered(block) ? filterOverview(base, keep) : base;
    const reorder = (x: GroupItem): GroupItem => {
      let items = x.items.map((it) => (it.type === "group" ? reorder(it) : it));
      if (sort !== "order") items = [...items].sort(cmp);
      if (block.limit) {
        let n = 0;
        items = items.filter((it) => it.type === "group" || n++ < block.limit!);
      }
      return { ...x, items };
    };
    g = reorder(g);
    return g;
  }
  // Flat lists: every matching document (inside typed folders too).
  const docs = allDocs(base).filter(keep);
  const ordered = sort === "order" ? docs : [...docs].sort(cmp);
  if (groupBy === "none") return { ...base, items: block.limit ? ordered.slice(0, block.limit) : ordered };
  // Grouped by the nearest typed folder each document is in.
  const owners = typedGroups(base).map((g) => g.path).sort((a, b) => b.length - a.length);
  const byOwner = new Map<string, DocItem[]>();
  for (const d of ordered) {
    const owner = owners.find((o) => d.path.startsWith(o + "/")) ?? base.path;
    const list = byOwner.get(owner) ?? [];
    list.push(d);
    byOwner.set(owner, list);
  }
  const items: Item[] = [...byOwner].map(([owner, list]) => ({
    type: "group", path: owner, kind: null,
    name: owner === base.path ? base.name : owner.slice(owner.lastIndexOf("/") + 1),
    items: block.limit ? list.slice(0, block.limit) : list,
  }));
  return { ...base, items };
}

export interface SubfolderRow {
  name: string;
  /** Relative path. */
  path: string;
  kind: string | null;
  fields: { key: string; value: string }[];
  counts: { name: string; count: number }[];
}

/** The typed folders a Subfolders block lists: the nearest ones under `folder` (of `folderType`, if set). */
export function subfolderRows(input: OverviewInput, ws: WorkspaceFile, block: SubfoldersBlock): SubfolderRow[] {
  const full = buildOverview(input);
  // Nearest typed folders: not inside another typed folder under this one.
  const nearest = (g: GroupItem): GroupItem[] => g.items.flatMap((it) =>
    it.type !== "group" ? [] : it.kind && (!block.folderType || it.kind === block.folderType) ? [it] : nearest(it));
  return nearest(full).map((g) => {
    const entry = ws.folders[g.path];
    const values = entry?.fields ?? {};
    const keys = block.fields ?? Object.keys(values);
    const docs = (x: GroupItem) => allDocs(x).filter((d) => d.type === "doc").length;
    const counts = block.counts?.length
      ? block.counts.map((name) => { const sub = findGroup(g, `${g.path}/${name}`); return { name, count: sub ? docs(sub) : 0 }; })
      : [{ name: "documents", count: docs(g) }];
    return { name: g.name, path: g.path, kind: g.kind, fields: keys.filter((k) => values[k]).map((k) => ({ key: k, value: values[k] })), counts };
  });
}
