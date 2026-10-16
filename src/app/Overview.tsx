// A folder overview tab: the blocks of the folder's overview layout (Header, New buttons, Files,
// Subfolders), each showing what its rules pick. In Files, a subfolder with its own type (a
// class in a term) is a link to its own overview, with its New buttons. Drag a row (or ⌥↑/⌥↓)
// to reorder it within its folder; the order is saved in workspace.json. "Edit layout" turns the
// page into an editor for its blocks. Going to another folder's overview from here happens in
// this tab (⌘-click for a new one). The models come from workspace/overview.ts.

import { For, JSX, Show, createMemo, createSignal } from "solid-js";
import { DocItem, GroupItem, Item, SubfolderRow, filterOverview, moveName, placeName } from "../workspace/overview";
import type { Block, FilesBlock, SubfoldersBlock } from "../workspace/model";
import { fuzzyScore } from "../workspace/fuzzy";

/** Kinds of files an overview shows, toggled in its toolbar (on top of each Files block's own rules). */
export interface Kinds { docs: boolean; pdfs: boolean; other: boolean }
export const ALL_KINDS: Kinds = { docs: true, pdfs: true, other: true };

/** A "New …" button: a template, or a folder of a type. */
export interface NewAction { id: string; label: string; run(): void }

export type ResolvedBlock =
  | {
    type: "header"; name: string; path: string; typeLabel: string | null; fields: { label: string; value: string }[]; up: { name: string; path: string; label: string } | null;
    /** The block's links (relative paths), and whether each is a folder or missing. */
    links: HeaderLink[];
  }
  | { type: "templates"; actions: NewAction[] }
  | { type: "files"; title?: string; model: GroupItem; reorderable: boolean; show: { title: boolean; date: boolean; links: boolean; pdf: boolean } }
  | { type: "subfolders"; title?: string; display: "compact" | "full"; rows: (SubfolderRow & { label: string | null; actions: NewAction[] })[] };

export interface HeaderLink { name: string; path: string; folder: boolean; missing: boolean }

/** Choices the layout editor offers. */
export interface LayoutOptions {
  /** Folder types (key, label). */
  types: { key: string; label: string }[];
  /** Templates (key, label). */
  templates: { key: string; label: string }[];
  /** This folder type's fields (key, label). */
  fields: { key: string; label: string }[];
  /** Subfolders of this folder (names), for a Files block's source. */
  subfolders: string[];
  /** Asks for a file or folder in the workspace (relative path), for a Header's links; null if cancelled. */
  pickPath: () => Promise<string | null>;
}

export interface OverviewProps {
  /** Folder path (relative) this overview is of. */
  folder: () => string;
  /** The layout's blocks, resolved (null while loading). */
  blocks: () => ResolvedBlock[] | null;
  /** Blocks for another folder's overview (a Subfolders block showing them in full). */
  resolve: (path: string) => ResolvedBlock[];
  /** Problems with workspace.json. */
  errors: () => string[];
  /** Type label for a folder type key. */
  typeLabel: (kind: string) => string;
  /** New buttons for a typed folder shown inside a Files block. */
  actionsFor: (kind: string, folder: string) => NewAction[];
  /** \link counts for a document (relative path). */
  links: (path: string) => { in: number; out: number };
  visible: () => boolean;
  onOpen(path: string): void;
  /** Goes to a folder's overview (relative path), in this tab; `newTab` (⌘-click): in a tab of its own. */
  onOverview(path: string, newTab?: boolean): void;
  onReorder(folder: string, names: string[]): void;
  /** The raw layout and what editing it changes. */
  layout: () => { blocks: Block[]; key: string | null; usedBy: string[]; own: boolean; typeLabel: string | null };
  layoutOptions: () => LayoutOptions;
  /** Changes the layout's blocks (applied to the latest saved layout, so quick changes don't undo each other). */
  onLayoutChange(change: (blocks: Block[]) => Block[]): void;
  /** Gives this folder its own copy of the layout. */
  onCustomize(): void;
  /** Starting to edit the layout (the tab is then kept, not a preview). */
  onEditing?(): void;
  /** Whether this folder is pinned to the sidebar, and pinning it. */
  pinned?: () => boolean;
  onPin?(on: boolean): void;
  /** Back to the type's layout (for a folder with its own). */
  onUseTypeLayout(): void;
  /** The kinds of files shown, and changing them (remembered per folder). */
  kinds?: () => Kinds;
  onKinds?(k: Kinds): void;
}

/** ⌘-click (Ctrl-click off the Mac): open in a new tab. */
const mod = (e: MouseEvent | KeyboardEvent) => e.metaKey || e.ctrlKey;

function formatWhen(ms: number | null, now = new Date()): string {
  if (ms === null || ms <= 0) return "";
  const d = new Date(ms);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString("en-US", d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

const BLOCK_NAMES: Record<Block["type"], string> = {
  header: "Header",
  templates: "New buttons",
  files: "Files",
  subfolders: "Subfolders",
};
const BLOCK_HELP: Record<Block["type"], string> = {
  header: "The folder's name, type and fields, with a link up to the folder it's in",
  templates: "Buttons that make new files from templates, or new folders, right here",
  files: "The files in this folder, filtered, grouped and sorted the way you choose",
  subfolders: "The typed folders inside this one, as a list or each shown in full",
};

export function Overview(props: OverviewProps) {
  const [query, setQuery] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const [selected, setSelected] = createSignal<number | null>(null);
  const [drag, setDrag] = createSignal<{ group: string; name: string } | null>(null);
  const [dropBefore, setDropBefore] = createSignal<{ group: string; name: string | null } | null>(null);
  const kinds = () => props.kinds?.() ?? ALL_KINDS;
  const allKinds = () => kinds().docs && kinds().pdfs && kinds().other;
  const filtering = () => !!query().trim() || !allKinds();

  const filtered = (g: GroupItem) => {
    const q = query().trim();
    const k = kinds();
    if (!q && allKinds()) return g;
    return filterOverview(g, (d) => {
      if (!(d.type === "doc" ? k.docs : d.name.toLowerCase().endsWith(".pdf") ? k.pdfs : k.other)) return false;
      return !q || fuzzyScore(q, `${d.title ?? ""} ${d.path}`) !== null;
    });
  };
  const KIND_LABELS: [keyof Kinds, string, string][] = [["docs", "TeX", "Documents (.tex)"], ["pdfs", "PDF", "PDFs"], ["other", "Other", "Other files"]];

  /** Names in `group`'s folder, from a Files model. */
  const namesIn = (model: GroupItem, group: string): string[] => {
    const find = (g: GroupItem): GroupItem | null => {
      if (g.path === group) return g;
      for (const it of g.items) if (it.type === "group") { const hit = find(it); if (hit) return hit; }
      return null;
    };
    return find(model)?.items.map((i) => i.name) ?? [];
  };

  const FilesView = (p: { block: Extract<ResolvedBlock, { type: "files" }> }) => {
    const reorder = () => p.block.reorderable && !filtering();
    const shown = createMemo(() => filtered(p.block.model));

    function onKey(e: KeyboardEvent, group: string, item: Item) {
      if (e.key === "Enter" && item.type !== "group") { e.preventDefault(); props.onOpen(item.path); return; }
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && reorder()) {
        e.preventDefault();
        const names = namesIn(p.block.model, group);
        const next = moveName(names, item.name, e.key === "ArrowUp" ? -1 : 1);
        if (next.join("/") !== names.join("/")) props.onReorder(group, next);
      }
    }

    // Drag to reorder, within one folder.
    const dragProps = (group: string, item: Item) => ({
      draggable: reorder(),
      onDragStart: (e: DragEvent) => {
        e.stopPropagation();
        e.dataTransfer?.setData("text/plain", item.name);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        setDrag({ group, name: item.name });
      },
      onDragOver: (e: DragEvent) => {
        const d = drag();
        if (!d || d.group !== group) return;
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget as HTMLElement;
        const r = el.getBoundingClientRect();
        const after = r.height > 0 && e.clientY > r.top + r.height / 2;
        const names = namesIn(p.block.model, group);
        setDropBefore({ group, name: after ? names[names.indexOf(item.name) + 1] ?? null : item.name });
      },
      onDrop: (e: DragEvent) => {
        const d = drag();
        const at = dropBefore();
        if (!d || !at || d.group !== group) return;
        e.preventDefault();
        e.stopPropagation();
        const names = namesIn(p.block.model, group);
        const next = placeName(names, d.name, at.name);
        if (next.join("/") !== names.join("/")) props.onReorder(group, next);
        setDrag(null);
        setDropBefore(null);
      },
      onDragEnd: () => { setDrag(null); setDropBefore(null); },
    });
    const insertClass = (group: string, name: string) => {
      const at = dropBefore();
      return at && at.group === group && at.name === name && drag()?.name !== name ? "ov-insert" : "";
    };

    const DocRow = (r: { item: DocItem; group: string }) => {
      const links = () => (r.item.type === "doc" ? props.links(r.item.path) : { in: 0, out: 0 });
      const show = () => p.block.show;
      return (
        <div
          class={`ov-row ov-${r.item.type} ${insertClass(r.group, r.item.name)}`} tabindex={0} role="button"
          onClick={() => props.onOpen(r.item.path)} onKeyDown={(e) => onKey(e, r.group, r.item)}
          title={r.item.path} {...dragProps(r.group, r.item)}
        >
          <span class="ov-title">{(show().title && r.item.title) || r.item.name}</span>
          <Show when={show().title && r.item.title}><span class="ov-file">{r.item.name}</span></Show>
          <span class="ov-spacer" />
          <Show when={show().links && (links().in || links().out)}>
            <span class="ov-links" title={`${links().in} link${links().in === 1 ? "" : "s"} here, ${links().out} out`}>↙{links().in} ↗{links().out}</span>
          </Show>
          <Show when={show().date}><span class="ov-when">{formatWhen(r.item.modified)}</span></Show>
          <Show when={show().pdf && r.item.pdf}>
            <button class="ov-pdf" title={r.item.pdf!} onClick={(e) => { e.stopPropagation(); props.onOpen(r.item.pdf!); }}>PDF</button>
          </Show>
        </div>
      );
    };

    const GroupView = (g: { group: GroupItem; parent: string; depth: number }) => {
      const link = () => !!g.group.kind;
      return (
        <section class={`ov-group depth-${Math.min(g.depth, 3)} ${link() ? "ov-group-link" : ""}`}>
          <div
            class={`ov-group-head ${insertClass(g.parent, g.group.name)}`} tabindex={0}
            title={link() ? `Open the ${props.typeLabel(g.group.kind!)} overview` : undefined}
            onClick={(e) => { if (link()) props.onOverview(g.group.path, mod(e)); }}
            onKeyDown={(e) => {
              if (link() && e.key === "Enter") { e.preventDefault(); props.onOverview(g.group.path, mod(e)); return; }
              onKey(e, g.parent, g.group);
            }}
            {...dragProps(g.parent, g.group)}
          >
            <span class="ov-group-name">{g.group.name}</span>
            <Show when={g.group.kind}><span class="ov-kind">{props.typeLabel(g.group.kind!)}</span></Show>
            <Show when={g.group.kind}>
              <span onClick={(e) => e.stopPropagation()}><NewButtons actions={props.actionsFor(g.group.kind!, g.group.path)} /></span>
            </Show>
          </div>
          <Show when={!link()}><Items group={g.group} depth={g.depth} /></Show>
        </section>
      );
    };

    const Items = (g: { group: GroupItem; depth: number }) => (
      <div class="ov-items">
        <For each={g.group.items}>
          {(it) => (it.type === "group"
            ? <GroupView group={it} parent={g.group.path} depth={g.depth + 1} />
            : <DocRow item={it} group={g.group.path} />)}
        </For>
        <Show when={!g.group.items.length && !filtering()}><div class="ov-empty">Nothing here yet</div></Show>
      </div>
    );

    return (
      <section class="ov-block ov-block-files">
        <Show when={p.block.title}><h2 class="ov-block-title">{p.block.title}</h2></Show>
        <Items group={shown()} depth={0} />
        <Show when={filtering() && !shown().items.length}><div class="ov-empty">Nothing matches</div></Show>
      </section>
    );
  };

  const NewButtons = (p: { actions: NewAction[] }) => (
    <Show when={p.actions.length}>
      <span class="ov-new">
        <For each={p.actions}>{(a) => <button class="ov-new-btn" onClick={() => a.run()}>New {a.label}</button>}</For>
      </span>
    </Show>
  );

  const BlocksView = (p: { blocks: ResolvedBlock[]; depth: number }): JSX.Element => (
    <For each={p.blocks}>
      {(b) => {
        switch (b.type) {
          case "header":
            return (
              <header class={p.depth ? "ov-subhead" : "ov-titlebar"}>
                <Show when={!p.depth ? b.up : null}>
                  {(u) => <button class="ov-up" title={`Open the ${u().label} overview`} onClick={(e) => props.onOverview(u().path, mod(e))}>← {u().name}</button>}
                </Show>
                <Show when={p.depth} fallback={<h1 class="ov-h1">{b.name}</h1>}>
                  <h2 class="ov-h2 ov-link" onClick={(e) => props.onOverview(b.path, mod(e))}>{b.name}</h2>
                </Show>
                <Show when={b.typeLabel}><span class="ov-kind">{b.typeLabel}</span></Show>
                <For each={b.fields}>{(f) => <span class="ov-field" title={f.label}>{f.value}</span>}</For>
                <Show when={!p.depth && b.links.length}>
                  <span class="ov-hlinks">
                    <For each={b.links}>
                      {(l) => (
                        <button class={`ov-hlink ${l.missing ? "missing" : ""}`} disabled={l.missing}
                          title={l.missing ? `${l.path} isn't there` : l.folder ? `Open the ${l.name} overview` : `Open ${l.path}`}
                          onClick={(e) => (l.folder ? props.onOverview(l.path, mod(e)) : props.onOpen(l.path))}>{l.name}</button>
                      )}
                    </For>
                  </span>
                </Show>
              </header>
            );
          case "templates":
            return <Show when={b.actions.length}><div class="ov-block ov-block-new"><NewButtons actions={b.actions} /></div></Show>;
          case "files":
            return <FilesView block={b} />;
          case "subfolders":
            return (
              <section class="ov-block ov-block-subfolders">
                <Show when={b.title}><h2 class="ov-block-title">{b.title}</h2></Show>
                <Show when={!b.rows.length}><div class="ov-empty">No typed folders here yet</div></Show>
                <For each={b.rows}>
                  {(row) => (
                    <Show when={b.display === "full" && p.depth < 1} fallback={
                      <div class="ov-sub-row" tabindex={0} role="button" onClick={(e) => props.onOverview(row.path, mod(e))} onKeyDown={(e) => { if (e.key === "Enter") props.onOverview(row.path, mod(e)); }}>
                        <span class="ov-group-name">{row.name}</span>
                        <Show when={row.label}><span class="ov-kind">{row.label}</span></Show>
                        <For each={row.fields}>{(f) => <span class="ov-field">{f.value}</span>}</For>
                        <span class="ov-spacer" />
                        <span class="ov-counts">{row.counts.map((c) => `${c.name} ${c.count}`).join(" · ")}</span>
                        <span onClick={(e) => e.stopPropagation()}><NewButtons actions={row.actions} /></span>
                      </div>
                    }>
                      <div class="ov-embed"><BlocksView blocks={props.resolve(row.path)} depth={p.depth + 1} /></div>
                    </Show>
                  )}
                </For>
              </section>
            );
        }
      }}
    </For>
  );

  return (
    <div class="overview-pane" style={{ display: props.visible() ? "flex" : "none" }}>
      <div class="ov-toolbar">
        <Show when={props.layout().own}><span class="ov-note">This folder has its own layout</span></Show>
        <span class="ov-spacer" />
        <Show when={!editing() && props.onKinds}>
          <div class="ov-kinds" role="group" aria-label="Kinds of files shown">
            <For each={KIND_LABELS}>
              {([key, label, title]) => (
                <button class={`ov-kind ${kinds()[key] ? "on" : ""}`} aria-pressed={kinds()[key]} title={`${kinds()[key] ? "Hide" : "Show"} ${title.toLowerCase()} in this overview`}
                  onClick={() => props.onKinds!({ ...kinds(), [key]: !kinds()[key] })}>{label}</button>
              )}
            </For>
          </div>
        </Show>
        <Show when={!editing()}>
          <input class="ov-filter" placeholder="Filter" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} spellcheck={false} />
        </Show>
        <Show when={props.onPin && !editing()}>
          <button class={`ov-pin-btn ${props.pinned?.() ? "on" : ""}`} title={props.pinned?.() ? "Unpin from the sidebar" : "Pin to the sidebar, above the file tree"} onClick={() => props.onPin!(!props.pinned?.())}>
            {props.pinned?.() ? "Pinned" : "Pin"}
          </button>
        </Show>
        <button class={`ov-edit-btn ${editing() ? "on" : ""}`} onClick={() => { if (!editing()) props.onEditing?.(); setEditing(!editing()); setSelected(null); }}>
          {editing() ? "Done" : "Edit layout"}
        </button>
      </div>
      <Show when={props.errors().length}><div class="ov-errors">{props.errors().join("; ")}</div></Show>
      <Show when={editing()}>
        <LayoutEditor props={props} selected={selected} setSelected={setSelected} />
      </Show>
      <Show when={!editing()}>
        <Show when={props.blocks()} fallback={<div class="ov-empty">Loading…</div>}>
          {(blocks) => (
            <div class="ov-scroll">
              <BlocksView blocks={blocks()} depth={0} />
              <Show when={!blocks().length}><div class="ov-empty">This layout has no blocks — click Edit layout to add some</div></Show>
              <Show when={blocks().some((b) => b.type === "files" && b.reorderable)}>
                <div class="ov-hint">Drag to reorder (or ⌥↑ ⌥↓). Files you haven't placed follow, oldest first.</div>
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}

// ---- layout editor --------------------------------------------------------------------

function summary(b: Block, o: LayoutOptions): string {
  const label = (list: { key: string; label: string }[], k: string) => list.find((x) => x.key === k)?.label ?? k;
  switch (b.type) {
    case "header": return [
      b.fields ? (b.fields.length ? `fields: ${b.fields.map((f) => label(o.fields, f)).join(", ")}` : "no fields") : "all fields", b.up === false ? "no up link" : "",
      b.links?.length ? `${b.links.length} link${b.links.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" · ");
    case "templates": return [
      b.templates ? (b.templates.length ? b.templates.map((t) => label(o.templates, t)).join(", ") : "no templates") : "templates for this folder type",
      b.folders ? b.folders.map((t) => label(o.types, t)).join(", ") : "",
    ].filter(Boolean).join(" · ");
    case "files": return [
      b.inType ? `${b.subfolder ? `${b.subfolder} in ` : ""}every ${label(o.types, b.inType)}` : b.subfolder ? `only ${b.subfolder}/` : "everything in this folder",
      b.name ? `named ${b.name}` : "", b.modifiedDays ? `edited in the last ${b.modifiedDays} days` : "",
      b.groupBy === "none" ? "one list" : b.groupBy === "typed" ? "grouped by typed folder" : "",
      b.sort && b.sort !== "order" ? `by ${b.sort}${b.desc ? ", newest/last first" : ""}` : "", b.limit ? `at most ${b.limit}` : "",
    ].filter(Boolean).join(" · ");
    case "subfolders": return [b.folderType ? `${label(o.types, b.folderType)} folders` : "typed folders", b.display === "full" ? "shown in full" : "one row each"].join(" · ");
  }
}

function LayoutEditor(p: { props: OverviewProps; selected: () => number | null; setSelected: (n: number | null) => void }) {
  const props = p.props;
  const blocks = () => props.layout().blocks;
  const set = (change: (b: Block[]) => Block[]) => props.onLayoutChange(change);
  const update = (i: number, patch: Partial<Block>) => set((all) => all.map((b, j) => (j === i ? (Object.fromEntries(Object.entries({ ...b, ...patch }).filter(([, v]) => v !== undefined)) as unknown as Block) : b)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= blocks().length) return;
    set((all) => { const next = [...all]; [next[i], next[j]] = [next[j], next[i]]; return next; });
    p.setSelected(j);
  };
  const add = (type: Block["type"]) => {
    const at = blocks().length;
    set((all) => [...all, { type } as Block]);
    p.setSelected(at);
  };
  const info = () => props.layout();
  const usedBy = () => info().usedBy.filter((x) => x !== props.folder());

  return (
    <div class="ov-editor">
      <div class="ov-editor-list">
        <div class="ov-editor-note">
          <Show when={info().own} fallback={
            <Show when={info().key} fallback={info().typeLabel
              ? <>This is the default layout. Changing it changes it for every {info().typeLabel} folder.</>
              : <>This is the default layout. Changing it gives this folder its own.</>}>
              Changes apply to {usedBy().length ? `this folder and ${usedBy().length} other${usedBy().length === 1 ? "" : "s"} with the same type` : "every folder of this type"}.
              {" "}<button class="set-link" onClick={() => props.onCustomize()}>Customize for this folder only</button>
            </Show>
          }>
            Only this folder uses this layout. <button class="set-link" onClick={() => props.onUseTypeLayout()}>Use its type's layout again</button>
          </Show>
        </div>
        <For each={blocks()}>
          {(b, i) => (
            <div class={`ov-editor-block ${p.selected() === i() ? "selected" : ""}`} onClick={() => p.setSelected(i())}>
              <div class="ov-editor-block-head">
                <span class="ov-editor-block-name">{BLOCK_NAMES[b.type]}{"title" in b && b.title ? `: ${b.title}` : ""}</span>
                <span class="ov-spacer" />
                <button class="set-icon" title="Move up" disabled={i() === 0} onClick={(e) => { e.stopPropagation(); move(i(), -1); }}>↑</button>
                <button class="set-icon" title="Move down" disabled={i() === blocks().length - 1} onClick={(e) => { e.stopPropagation(); move(i(), 1); }}>↓</button>
                <button class="set-icon" title="Remove" onClick={(e) => { e.stopPropagation(); const at = i(); set((all) => all.filter((_, j) => j !== at)); p.setSelected(null); }}>✕</button>
              </div>
              <div class="ov-editor-block-sum">{summary(b, props.layoutOptions())}</div>
            </div>
          )}
        </For>
        <div class="ov-editor-add">
          <span class="ov-editor-add-label">Add a block:</span>
          <For each={["header", "templates", "files", "subfolders"] as Block["type"][]}>
            {(t) => <button class="ov-new-btn" title={BLOCK_HELP[t]} onClick={() => add(t)}>{BLOCK_NAMES[t]}</button>}
          </For>
        </div>
      </div>
      <div class="ov-editor-panel">
        {/* Keyed: the settings are rebuilt from each saved version of the block, so a second change builds on the first. */}
        <Show when={p.selected() !== null && blocks()[p.selected()!]} keyed fallback={<div class="ov-empty">Select a block to change what it shows.</div>}>
          {(b) => <BlockSettings block={b} options={props.layoutOptions()} onChange={(patch) => update(p.selected()!, patch)} />}
        </Show>
      </div>
    </div>
  );
}

/** A labeled control row in the block settings panel. */
const Row = (p: { label: string; desc?: string; children: JSX.Element }) => (
  <label class="ov-set-row">
    <span class="ov-set-label">{p.label}<Show when={p.desc}><span class="ov-set-desc">{p.desc}</span></Show></span>
    {p.children}
  </label>
);

/** Checkboxes for picking some of `items`; unset (`value` undefined) means `allLabel`. */
function Picker(p: { items: { key: string; label: string }[]; value: string[] | undefined; allLabel: string; onChange: (v: string[] | undefined) => void }) {
  return (
    <div class="ov-picker">
      <label class="ov-check"><input type="checkbox" checked={p.value === undefined} onChange={(e) => p.onChange(e.currentTarget.checked ? undefined : p.items.map((i) => i.key))} /> {p.allLabel}</label>
      <Show when={p.value !== undefined}>
        <For each={p.items}>
          {(it) => (
            <label class="ov-check">
              <input type="checkbox" checked={p.value!.includes(it.key)} onChange={(e) => p.onChange(e.currentTarget.checked ? [...p.value!, it.key] : p.value!.filter((x) => x !== it.key))} /> {it.label}
            </label>
          )}
        </For>
        <Show when={!p.items.length}><span class="ov-set-desc">None to choose from</span></Show>
      </Show>
    </div>
  );
}

/** A Header's links: a list to remove from; Choose… picks a file or folder, or a path is typed. */
function LinksSetting(p: { links: string[]; pick: () => Promise<string | null>; onChange: (v: string[]) => void }) {
  const addPath = (raw: string) => {
    const v = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (v && !p.links.includes(v)) p.onChange([...p.links, v]);
  };
  const add = (input: HTMLInputElement) => { addPath(input.value); input.value = ""; };
  return (
    <div class="ov-set-row">
      <span class="ov-set-label">Links<span class="ov-set-desc">Files or folders to link to, from the workspace's top folder (or ./… from this folder)</span></span>
      <div class="ov-picker">
        <For each={p.links}>
          {(l) => (
            <div class="ov-hlink-row">
              <span class="ov-hlink-path">{l}</span>
              <button class="set-icon" title="Remove" onClick={() => p.onChange(p.links.filter((x) => x !== l))}>✕</button>
            </div>
          )}
        </For>
        <div class="ov-hlink-row">
          <button class="set-button" onClick={(e) => { e.preventDefault(); void p.pick().then((v) => { if (v !== null) addPath(v); }); }}>Choose…</button>
          <input class="set-input" placeholder="or type a path" spellcheck={false}
            onChange={(e) => add(e.currentTarget)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(e.currentTarget); } }} />
        </div>
      </div>
    </div>
  );
}

function BlockSettings(p: { block: Block; options: LayoutOptions; onChange: (patch: Partial<Block>) => void }) {
  const b = p.block;
  const o = p.options;
  const num = (v: string) => { const n = Number(v); return v.trim() && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined; };
  const text = (v: string) => (v.trim() ? v.trim() : undefined);
  const check = (k: string, v: boolean | undefined, label: string) => (
    <label class="ov-check"><input type="checkbox" checked={v !== false} onChange={(e) => p.onChange({ [k]: e.currentTarget.checked ? undefined : false } as Partial<Block>)} /> {label}</label>
  );
  return (
    <div class="ov-set">
      <h3 class="ov-set-title">{BLOCK_NAMES[b.type]}</h3>
      <div class="ov-set-desc">{BLOCK_HELP[b.type]}</div>
      {(() => {
        switch (b.type) {
          case "header": return (
            <>
              <Row label="Fields to show"><Picker items={o.fields} value={b.fields} allLabel="All of them" onChange={(v) => p.onChange({ fields: v })} /></Row>
              <div class="ov-set-row">{check("up", b.up, "Link up to the folder it's in")}</div>
              <LinksSetting links={b.links ?? []} pick={o.pickPath} onChange={(v) => p.onChange({ links: v.length ? v : undefined })} />
            </>
          );
          case "templates": return (
            <>
              <Row label="Templates" desc="Each button makes a file in this folder"><Picker items={o.templates} value={b.templates} allLabel="Those for this folder type" onChange={(v) => p.onChange({ templates: v })} /></Row>
              <Row label="New folders" desc="Buttons that make a folder of a type here"><Picker items={o.types} value={b.folders} allLabel="The types allowed inside this one" onChange={(v) => p.onChange({ folders: v })} /></Row>
            </>
          );
          case "files": {
            const f = b as FilesBlock;
            return (
              <>
                <Row label="Title"><input class="set-input" value={f.title ?? ""} placeholder="(none)" onChange={(e) => p.onChange({ title: text(e.currentTarget.value) })} /></Row>
                <Row label="Show files from">
                  <select class="set-input" value={f.inType ?? ""} onChange={(e) => p.onChange({ inType: e.currentTarget.value || undefined })}>
                    <option value="">This folder</option>
                    <For each={o.types}>{(t) => <option value={t.key}>Every {t.label} inside it</option>}</For>
                  </select>
                </Row>
                <Row label="Only the subfolder" desc={f.inType ? "Inside each of those folders, e.g. hw" : "e.g. hw — leave empty for everything"}>
                  <input class="set-input" list="ov-subfolders" value={f.subfolder ?? ""} placeholder="(all)" onChange={(e) => p.onChange({ subfolder: text(e.currentTarget.value)?.replace(/^\/+|\/+$/g, "") })} />
                  <datalist id="ov-subfolders"><For each={o.subfolders}>{(s) => <option value={s} />}</For></datalist>
                </Row>
                <div class="ov-set-row ov-set-checks">
                  <span class="ov-set-label">Kinds of files</span>
                  {check("docs", f.docs, "Documents (.tex)")}{check("pdfs", f.pdfs, "PDFs")}{check("other", f.other, "Other files")}
                </div>
                <Row label="Name matches" desc="* is anything, e.g. hw*.tex"><input class="set-input" value={f.name ?? ""} placeholder="(any)" onChange={(e) => p.onChange({ name: text(e.currentTarget.value) })} /></Row>
                <Row label="Edited in the last … days"><input class="set-input set-number" type="number" min="1" value={f.modifiedDays ?? ""} placeholder="(any)" onChange={(e) => p.onChange({ modifiedDays: num(e.currentTarget.value) })} /></Row>
                <Row label="Group">
                  <select class="set-input" value={f.groupBy ?? "subfolder"} onChange={(e) => p.onChange({ groupBy: e.currentTarget.value === "subfolder" ? undefined : e.currentTarget.value as FilesBlock["groupBy"] })}>
                    <option value="subfolder">By subfolder</option>
                    <option value="typed">By typed folder (e.g. by class)</option>
                    <option value="none">One list</option>
                  </select>
                </Row>
                <Row label="Sort">
                  <select class="set-input" value={f.sort ?? "order"} onChange={(e) => p.onChange({ sort: e.currentTarget.value === "order" ? undefined : e.currentTarget.value as FilesBlock["sort"] })}>
                    <option value="order">Your order (drag to arrange)</option>
                    <option value="name">Name</option>
                    <option value="title">Title</option>
                    <option value="created">Date created</option>
                    <option value="modified">Date edited</option>
                  </select>
                </Row>
                <Show when={f.sort && f.sort !== "order"}>
                  <Row label="Direction">
                    <select class="set-input" value={f.desc ? "desc" : "asc"} onChange={(e) => p.onChange({ desc: e.currentTarget.value === "desc" ? true : undefined })}>
                      <option value="asc">A to Z, oldest first</option>
                      <option value="desc">Z to A, newest first</option>
                    </select>
                  </Row>
                </Show>
                <div class="ov-set-row ov-set-checks">
                  <span class="ov-set-label">Show</span>
                  {check("showTitle", f.showTitle, "Title")}{check("showDate", f.showDate, "Date")}{check("showLinks", f.showLinks, "Links")}{check("showPdf", f.showPdf, "PDF")}
                </div>
                <Row label="At most … files" desc="In each folder, or in the list"><input class="set-input set-number" type="number" min="1" value={f.limit ?? ""} placeholder="(all)" onChange={(e) => p.onChange({ limit: num(e.currentTarget.value) })} /></Row>
              </>
            );
          }
          case "subfolders": {
            const s = b as SubfoldersBlock;
            return (
              <>
                <Row label="Title"><input class="set-input" value={s.title ?? ""} placeholder="(none)" onChange={(e) => p.onChange({ title: text(e.currentTarget.value) })} /></Row>
                <Row label="Folders">
                  <select class="set-input" value={s.folderType ?? ""} onChange={(e) => p.onChange({ folderType: e.currentTarget.value || undefined })}>
                    <option value="">Any typed folder</option>
                    <For each={o.types}>{(t) => <option value={t.key}>{t.label} folders</option>}</For>
                  </select>
                </Row>
                <Row label="Show each">
                  <select class="set-input" value={s.display ?? "compact"} onChange={(e) => p.onChange({ display: e.currentTarget.value === "compact" ? undefined : "full" })}>
                    <option value="compact">As one row</option>
                    <option value="full">In full (its own overview)</option>
                  </select>
                </Row>
                <Show when={s.display !== "full"}>
                  <Row label="Count documents in" desc="Comma-separated subfolders, e.g. notes, hw — empty counts everything">
                    <input class="set-input" value={(s.counts ?? []).join(", ")} placeholder="(all)" onChange={(e) => { const v = e.currentTarget.value.split(",").map((x) => x.trim()).filter(Boolean); p.onChange({ counts: v.length ? v : undefined }); }} />
                  </Row>
                </Show>
              </>
            );
          }
        }
      })()}
    </div>
  );
}
