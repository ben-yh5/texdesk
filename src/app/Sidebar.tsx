// Workspace file tree. Works like VS Code's explorer: new files and folders are named
// in place, F2/Enter renames, ⌘⌫ moves to the Trash, right-click for a menu, and
// dragging moves files between folders. Clicking a folder's name shows its overview (as a
// preview tab) and opens it in the tree; its arrow only opens or closes it. The workspace's
// name at the top is its home page (the root's overview); pinned folders sit above the tree.
// ↑↓ move, → / ← open and close folders, ⌘↓ or Space opens. The app does the file-system work.
// The buttons at the top switch between the files and searching them (SearchPanel).

import { For, JSX, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { WalkEntry } from "../host/types";
import { ContextItem, ContextMenu } from "./ContextMenu";
import { endDrag as endGlobalDrag, startDrag } from "./dnd";
import { SearchPanel, SearchPanelApi, SearchPanelProps } from "./SearchPanel";

interface Node {
  name: string;
  path: string;
  isDir: boolean;
  children: Node[];
  /** A PDF exported by a build (shown under its source). */
  generated?: boolean;
}

const folder = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function buildTree(entries: WalkEntry[], generated: Map<string, string>): Node[] {
  const root: Node = { name: "", path: "", isDir: true, children: [] };
  const dirs = new Map<string, Node>([["", root]]);
  const files = new Map<string, Node>();
  const sorted = [...entries].sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const present = new Set(entries.map((e) => e.path));
  const later: WalkEntry[] = [];
  for (const e of sorted) {
    const src = generated.get(e.path);
    const i = e.path.lastIndexOf("/");
    // Copies next to their source nest under it; ones saved elsewhere stay where they are.
    if (src && present.has(src) && folder(src) === folder(e.path)) { later.push(e); continue; }
    const parent = dirs.get(i < 0 ? "" : e.path.slice(0, i));
    if (!parent) continue;
    const node: Node = { name: e.path.slice(i + 1), path: e.path, isDir: e.isDir, children: [], generated: !!src };
    parent.children.push(node);
    if (e.isDir) dirs.set(e.path, node);
    else files.set(e.path, node);
  }
  for (const e of later) {
    const src = files.get(generated.get(e.path)!);
    src?.children.push({ name: e.path.slice(e.path.lastIndexOf("/") + 1), path: e.path, isDir: false, children: [], generated: true });
  }
  const sortRec = (n: Node) => {
    n.children.sort((a, b) => (a.isDir === b.isDir ? collator.compare(a.name, b.name) : a.isDir ? -1 : 1));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

/** An error message, or null on success. */
type Result = Promise<string | null>;

export interface SidebarApi {
  /** Starts naming a new file or folder in `dir` (default: the selected folder, or the selected file's folder). */
  newEntry(kind: "file" | "folder", dir?: string): void;
  rename(path: string): void;
  /** Shows the search view with its box focused (and `query` in it, if given). */
  search(query?: string): void;
  /** Whether the search box has focus. */
  searchFocused(): boolean;
  /** Back to the files view. */
  showFiles(): void;
}

export interface SidebarProps {
  /** Width in pixels (dragged with the handle on its right edge). */
  width: number;
  name: string;
  entries: WalkEntry[];
  /** Relative path of the open file. */
  active: string | null;
  expanded: Set<string>;
  /** Generated PDF path → source .tex path (both relative). */
  generated: Map<string, string>;
  /** Generated PDFs that are "Save PDF as…" copies (relative paths). */
  linked?: Set<string>;
  /** Files linking to the open file. */
  backlinks?: { file: string; rel: string; line: number; text: string }[];
  onOpenBacklink?(file: string, line: number): void;
  onToggle(path: string): void;
  onExpand(path: string): void;
  onOpen(path: string): void;
  /** Creates `name` (may contain `/`) in `dir`. */
  onCreate(dir: string, name: string, isDir: boolean): Result;
  /** "New file" in `dir`: the app asks for the name and template. */
  onNewFile(dir: string): void;
  onRename(path: string, name: string): Result;
  onMove(path: string, dir: string): void;
  onDelete(path: string): void;
  onReveal(path: string): void;
  /**
   * Extra right-click items for a folder ("" is the workspace root): `create` goes under New
   * Folder (e.g. New Class in a term), `manage` with the folder's own items (Set Folder Type…).
   */
  folderItems?(dir: string): { create: ContextItem[]; manage: ContextItem[] };
  /** Opens a folder's overview tab (`preview`: as the preview tab a next folder click replaces). */
  onOverview(dir: string, preview?: boolean): void;
  /** What clicking a folder's name does (the arrow always just opens/closes it). */
  folderClick?: "overview" | "expand";
  /** The workspace's own overview (its name at the top). */
  onHome?(): void;
  /** Folders pinned above the tree (relative paths). */
  pinned?: string[];
  onPin?(dir: string, pin: boolean): void;
  /** The plugin the open file belongs to: its files, shown above the tree (plugins live outside it). */
  plugin?: PluginPanel | null;
  /** The search view (without it, there's only the files). */
  search?: Omit<SearchPanelProps, "ref" | "onClose">;
  /** Esc or × in the search view (default: back to the files). */
  onCloseSearch?(): void;
  ref?(api: SidebarApi): void;
}

export interface PluginPanel {
  name: string;
  /** Where it lives, e.g. "Your plugins" or "This workspace". */
  where: string;
  enabled: boolean;
  files: { name: string; path: string; active: boolean; detail: string; error: boolean }[];
  onOpen(path: string): void;
  onNewFile(): void;
  onSettings(): void;
}

type Editing = { kind: "file" | "folder"; dir: string } | { kind: "rename"; path: string };

const FileIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 1.5h5l3 3v10H4z" /><path d="M9 1.5v3h3" /><path d="M8 8v4M6 10h4" /></svg>
);
const FolderIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 3.5h4l1.5 1.5h7.5v8.5h-13z" /><path d="M8 7v4.5M5.75 9.25h4.5" /></svg>
);

const FilesIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 3h4.5l1.5 1.5h7v9h-13z" /></svg>
);
const SearchIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5l3.5 3.5" /></svg>
);

/** A list-with-heading glyph for "Open overview". */
const OverviewIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
    <path d="M2.5 3.5h11M2.5 7h7M2.5 10h7M2.5 13h7" />
  </svg>
);

export function Sidebar(props: SidebarProps) {
  const tree = createMemo(() => buildTree(props.entries, props.generated));
  const isDir = createMemo(() => new Set(props.entries.filter((e) => e.isDir).map((e) => e.path)));
  const [selected, setSelected] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<Editing | null>(null);
  const [editError, setEditError] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<{ x: number; y: number; path: string | null } | null>(null);
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [dropDir, setDropDir] = createSignal<string | null>(null);
  const [view, setView] = createSignal<"files" | "search">("files");
  let searchApi: SearchPanelApi | undefined;
  let treeEl!: HTMLDivElement;
  let expandTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => { if (props.active) setSelected(props.active); });

  /** The folder new entries go in: the selected folder, or the selected file's folder. */
  const targetDir = (path: string | null) => (path === null ? "" : isDir().has(path) ? path : folder(path));

  function newEntry(kind: "file" | "folder", dir = targetDir(selected())) {
    setMenu(null);
    setView("files");
    if (kind === "file") return props.onNewFile(dir); // named in a modal, with the template step
    setEditError(null);
    if (dir) props.onExpand(dir);
    setEditing({ kind, dir });
  }
  function rename(path: string) {
    setMenu(null);
    setView("files");
    setEditError(null);
    setEditing({ kind: "rename", path });
  }
  function search(query?: string) {
    setView("search");
    queueMicrotask(() => searchApi?.focus(query));
  }
  props.ref?.({ newEntry, rename, search, searchFocused: () => view() === "search" && !!searchApi?.hasFocus(), showFiles: () => setView("files") });

  // ---- inline name input ----

  const NameInput = (p: { initial: string; depth: number; icon?: JSX.Element; inline?: boolean }) => {
    let done = false;
    const commit = async (input: HTMLInputElement) => {
      const value = input.value.trim();
      const e = editing();
      if (!e || done) return;
      if (!value || (e.kind === "rename" && value === p.initial)) { done = true; setEditing(null); return; }
      done = true;
      const err = e.kind === "rename" ? await props.onRename(e.path, value) : await props.onCreate(e.dir, value, e.kind === "folder");
      if (err) { done = false; setEditError(err); input.focus(); return; }
      setEditing(null);
      setEditError(null);
    };
    const input = (
      <input
        class="tree-input"
        value={p.initial}
        spellcheck={false}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); void commit(e.currentTarget); }
          if (e.key === "Escape") { e.preventDefault(); done = true; setEditing(null); setEditError(null); treeEl.focus(); }
        }}
        onInput={() => setEditError(null)}
        onBlur={(e) => void commit(e.currentTarget)}
      />
    ) as HTMLInputElement;
    queueMicrotask(() => {
      input.focus();
      // Select the name without its extension, like VS Code.
      const dot = p.initial.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : p.initial.length);
    });
    const body = (
      <>
        {input}
        <Show when={editError()}><div class="tree-input-error">{editError()}</div></Show>
      </>
    );
    return p.inline ? body : (
      <div class="tree-row editing" style={{ "padding-left": `${8 + p.depth * 14}px` }}>
        <span class="tree-icon tree-kind">{p.icon}</span>
        <div class="tree-input-wrap">{body}</div>
      </div>
    );
  };

  const NewRow = (p: { dir: string; depth: number }) => (
    <Show when={(() => { const e = editing(); return e && e.kind !== "rename" && e.dir === p.dir ? e : null; })()}>
      {(e) => <NameInput initial="" depth={p.depth} icon={e().kind === "folder" ? <FolderIcon /> : <FileIcon />} />}
    </Show>
  );

  // ---- drag and drop ----

  const canDrop = (from: string | null, dir: string) =>
    from !== null && dir !== folder(from) && dir !== from && !dir.startsWith(from + "/");

  function onDragOver(e: DragEvent, dir: string, expandPath?: string) {
    if (dragging() === null) return; // a tab, not a file: the tree isn't a drop target for it
    // Rows decide for themselves; a row that refuses mustn't fall through to the tree (= root).
    e.stopPropagation();
    if (!canDrop(dragging(), dir)) { setDropDir(null); return; }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (dropDir() !== dir) {
      setDropDir(dir);
      clearTimeout(expandTimer);
      // Hovering over a closed folder opens it, so you can drop deeper.
      if (expandPath && !props.expanded.has(expandPath)) expandTimer = setTimeout(() => props.onExpand(expandPath), 600);
    }
  }
  function onDrop(e: DragEvent) {
    const from = dragging();
    const dir = dropDir();
    endDrag();
    if (from === null || dir === null) return;
    e.preventDefault();
    e.stopPropagation();
    props.onMove(from, dir);
  }
  function endDrag() {
    endGlobalDrag();
    clearTimeout(expandTimer);
    setDragging(null);
    setDropDir(null);
  }

  // ---- context menu ----

  function openMenu(e: MouseEvent, path: string | null) {
    e.preventDefault();
    e.stopPropagation();
    if (path !== null) setSelected(path);
    setMenu({ x: e.clientX, y: e.clientY, path });
  }

  function menuItems(path: string | null): ContextItem[] {
    const dir = targetDir(path);
    const extra = props.folderItems?.(dir) ?? { create: [], manage: [] };
    return [
      { label: "New File…", run: () => newEntry("file", dir) },
      { label: "New Folder…", run: () => newEntry("folder", dir) },
      ...extra.create,
      ...(path === null ? [] : [
        "separator" as const,
        { label: "Rename…", hint: "↩", run: () => rename(path) },
        { label: "Move to Trash", hint: "⌘⌫", run: () => props.onDelete(path) },
        "separator" as const,
        ...(isDir().has(path) ? [
          { label: "Open Overview", run: () => props.onOverview(path) },
          ...(props.onPin ? [{ label: props.pinned?.includes(path) ? "Unpin from Sidebar" : "Pin to Sidebar", run: () => props.onPin!(path, !props.pinned?.includes(path)) }] : []),
          ...extra.manage,
        ] : []),
        { label: "Reveal in Finder", run: () => props.onReveal(path) },
      ]),
    ];
  }

  // ---- keyboard ----

  /** Rows on screen, in order (folders that are closed hide what's inside). */
  const visibleRows = createMemo(() => {
    const out: Node[] = [];
    const walk = (nodes: Node[]) => { for (const n of nodes) { out.push(n); if (props.expanded.has(n.path)) walk(n.children); } };
    walk(tree());
    return out;
  });
  const scrollToSelected = () => queueMicrotask(() => (treeEl.querySelector(".tree-row.selected") as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" }));

  /** What clicking a folder's name does: its overview (and open it in the tree), or just open/close it. */
  function clickFolder(path: string, preview: boolean) {
    if (props.folderClick === "expand") { props.onToggle(path); return; }
    if (!props.expanded.has(path)) props.onExpand(path);
    props.onOverview(path, preview);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (editing()) return;
    const rows = visibleRows();
    const sel = selected();
    const i = sel === null ? -1 : rows.findIndex((r) => r.path === sel);
    const node = i >= 0 ? rows[i] : null;
    const go = (n: Node | undefined) => { if (n) { e.preventDefault(); setSelected(n.path); scrollToSelected(); } };
    if (e.key === "ArrowDown" && !e.metaKey && !e.ctrlKey) return go(rows[i + 1] ?? (i < 0 ? rows[0] : undefined));
    if (e.key === "ArrowUp" && !e.metaKey && !e.ctrlKey) return go(i > 0 ? rows[i - 1] : rows[0]);
    if (!node || !sel) return;
    const expandable = node.isDir || node.children.length > 0;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (expandable && !props.expanded.has(sel)) props.onExpand(sel);
      else if (expandable) go(node.children[0]);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (expandable && props.expanded.has(sel)) props.onToggle(sel);
      else { const parent = folder(sel); if (parent) go(rows.find((r) => r.path === parent)); }
    } else if ((e.key === "ArrowDown" && (e.metaKey || e.ctrlKey)) || e.key === " ") {
      e.preventDefault();
      if (node.isDir) props.onOverview(sel); else props.onOpen(sel);
    }
    else if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "F2") { e.preventDefault(); rename(sel); }
    else if ((e.key === "Backspace" && (e.metaKey || e.ctrlKey)) || e.key === "Delete") { e.preventDefault(); props.onDelete(sel); }
  }

  // ---- rows ----

  const Row = (p: { node: Node; depth: number }) => {
    const open = () => props.expanded.has(p.node.path);
    const expandable = () => p.node.isDir || p.node.children.length > 0;
    const renaming = () => { const e = editing(); return e?.kind === "rename" && e.path === p.node.path; };
    const dropHere = () => p.node.isDir && dropDir() === p.node.path;
    return (
      <>
        <div
          class={`tree-row ${p.node.isDir ? "dir" : "file"} ${p.node.generated ? "generated" : ""} ${props.active === p.node.path ? "active" : ""} ${selected() === p.node.path ? "selected" : ""} ${dropHere() ? "drop-target" : ""} ${dragging() === p.node.path ? "dragging" : ""}`}
          style={{ "padding-left": `${8 + p.depth * 14}px` }}
          title={p.node.generated
            ? `${p.node.path} (${props.linked?.has(p.node.path) ? `saved from ${props.generated.get(p.node.path)}, updated on every build` : "exported by TeXdesk"})`
            : p.node.path}
          draggable={!renaming()}
          onDragStart={(e) => {
            setDragging(p.node.path);
            setSelected(p.node.path);
            // Also announced to the editor groups, which open a file dropped on them.
            startDrag({ kind: "file", path: p.node.path }, e);
          }}
          onDragEnd={endDrag}
          onDragOver={(e) => onDragOver(e, p.node.isDir ? p.node.path : folder(p.node.path), p.node.isDir ? p.node.path : undefined)}
          onDrop={onDrop}
          onContextMenu={(e) => openMenu(e, p.node.path)}
          onClick={() => {
            if (renaming()) return;
            setSelected(p.node.path);
            if (p.node.isDir) clickFolder(p.node.path, true);
            else props.onOpen(p.node.path);
          }}
          onDblClick={() => { if (p.node.isDir && !renaming() && props.folderClick !== "expand") props.onOverview(p.node.path, false); }}
        >
          <span
            class={`tree-icon ${expandable() ? "tree-chevron" : ""}`}
            title={p.node.isDir ? (open() ? "Close folder" : "Open folder") : undefined}
            onClick={(e) => { if (expandable()) { e.stopPropagation(); setSelected(p.node.path); props.onToggle(p.node.path); } }}
            onDblClick={(e) => e.stopPropagation()}
          >{expandable() ? (open() ? "▾" : "▸") : ""}</span>
          <Show when={renaming()} fallback={<span class="tree-name">{p.node.name}</span>}>
            <div class="tree-input-wrap"><NameInput initial={p.node.name} depth={p.depth} inline /></div>
          </Show>
          <Show when={p.node.generated && !renaming()}><span class="tree-badge">{props.linked?.has(p.node.path) ? "linked" : "generated"}</span></Show>
          <Show when={p.node.isDir && !renaming()}>
            <button class="tree-add tree-overview" title="Open overview" onClick={(e) => { e.stopPropagation(); props.onOverview(p.node.path); }}><OverviewIcon /></button>
            <button class="tree-add" title="New file here" onClick={(e) => { e.stopPropagation(); newEntry("file", p.node.path); }}>+</button>
          </Show>
        </div>
        <Show when={expandable() && open()}>
          <Show when={p.node.isDir}><NewRow dir={p.node.path} depth={p.depth + 1} /></Show>
          <For each={p.node.children}>{(c) => <Row node={c} depth={p.depth + 1} />}</For>
        </Show>
      </>
    );
  };

  return (
    <aside class="sidebar" style={{ width: `${props.width}px` }}>
      <Show when={props.search}>
        <div class="sidebar-tabs">
          <button class={`sidebar-tab ${view() === "files" ? "active" : ""}`} title="Files" onClick={() => setView("files")}><FilesIcon /></button>
          <button class={`sidebar-tab ${view() === "search" ? "active" : ""}`} title="Search" onClick={() => search()}><SearchIcon /></button>
        </div>
      </Show>
      <Show when={props.search}>
        {(sp) => (
          <div class="sidebar-view" style={{ display: view() === "search" ? "" : "none" }}>
            <SearchPanel search={(q, n) => sp().search(q, n)} rel={(p) => sp().rel(p)} onOpen={(h, f) => sp().onOpen(h, f)} onClose={() => (props.onCloseSearch ? props.onCloseSearch() : setView("files"))} ref={(api) => (searchApi = api)} />
          </div>
        )}
      </Show>
      <div class="sidebar-view" style={{ display: view() === "files" ? "" : "none" }}>
        <div class="sidebar-head">
          <button class="sidebar-name" title={props.onHome ? `${props.name} — open the workspace's home page` : props.name} onClick={() => props.onHome?.()}>{props.name}</button>
          <button class="tree-add always" title="New file" onClick={() => newEntry("file")}><FileIcon /></button>
          <button class="tree-add always" title="New folder" onClick={() => newEntry("folder")}><FolderIcon /></button>
        </div>
        <Show when={props.plugin}>
          {(pl) => (
            <div class="plugin-panel">
              <div class="plugin-head">
                <span class="plugin-title" title={`${pl().name} — ${pl().where}`}>Plugin · {pl().name}</span>
                <button class="tree-add always" title="New snippet file in this plugin" onClick={() => pl().onNewFile()}><FileIcon /></button>
                <button class="tree-add always plugin-settings" title="Plugin settings (on/off, duplicate, delete)" onClick={() => pl().onSettings()}>⚙</button>
              </div>
              <Show when={!pl().enabled}><div class="plugin-off">Off — its snippets aren't loaded. Turn it on in Settings → Plugins.</div></Show>
              <For each={pl().files}>
                {(f) => (
                  <div class={`tree-row file plugin-file ${f.active ? "active" : ""} ${f.error ? "has-error" : ""}`} title={f.path} onClick={() => pl().onOpen(f.path)}>
                    <span class="tree-icon" />
                    <span class="tree-name">{f.name}</span>
                    <span class="plugin-file-detail">{f.detail}</span>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
        <Show when={props.pinned?.length}>
          <div class="pinned">
            <div class="pinned-title">Pinned</div>
            <For each={props.pinned}>
              {(p) => (
                <div class="tree-row dir pinned-row" title={p} onClick={() => props.onOverview(p)} onContextMenu={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  setMenu({ x: e.clientX, y: e.clientY, path: p });
                }}>
                  <span class="tree-icon"><OverviewIcon /></span>
                  <span class="tree-name">{p.slice(p.lastIndexOf("/") + 1)}</span>
                  <span class="pinned-where">{folder(p)}</span>
                  <button class="tree-add" title="Unpin" onClick={(e) => { e.stopPropagation(); props.onPin?.(p, false); }}>×</button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div
          class={`tree ${dropDir() === "" ? "drop-target" : ""}`}
          ref={treeEl}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onDragOver={(e) => onDragOver(e, "")}
          onDrop={onDrop}
          onContextMenu={(e) => openMenu(e, null)}
        >
          <NewRow dir="" depth={0} />
          <For each={tree()}>{(n) => <Row node={n} depth={0} />}</For>
        </div>
        <Show when={props.backlinks?.length}>
          <div class="backlinks">
            <div class="backlinks-title">Linked from</div>
            <For each={props.backlinks}>
              {(b) => (
                <div class="backlink" title={`${b.rel}:${b.line}\n${b.text}`} onClick={() => props.onOpenBacklink?.(b.file, b.line)}>
                  <span class="backlink-name">{b.rel.slice(b.rel.lastIndexOf("/") + 1)}</span>
                  <span class="backlink-text">{b.text}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={menu()}>
        {(m) => <ContextMenu x={m().x} y={m().y} items={menuItems(m().path)} onClose={() => setMenu(null)} />}
      </Show>
    </aside>
  );
}
