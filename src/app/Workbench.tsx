// Editor groups side by side, each with a tab bar. Tabs (and files from the tree) can be
// dragged onto a tab bar to reorder/move, onto a group to move there, or onto a group's
// left/right edge to split it. The app owns the layout and the editors; this draws it.

import { For, JSX, Show, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { Layout, Tab, activeTab, groupById } from "./layout";
import { dragging, endDrag, startDrag } from "./dnd";

export type DropTarget = { group: string; index: number } | { group: string; side: "left" | "right" | "center" };

export interface TabLabel {
  name: string;
  /** Dimmed text after the name (e.g. the output's file name). */
  detail?: string;
  title: string;
  dirty?: boolean;
}

export interface WorkbenchProps {
  layout: Layout;
  label(tab: Tab): TabLabel;
  /** Draws a PDF/output tab's content (the tab is a getter: a rename gives it a new path). */
  renderPdf(tab: () => Tab | null, visible: () => boolean): JSX.Element;
  /** Each group has one text editor; the app attaches a CodeMirror view to this element. */
  mountEditor(group: string, el: HTMLElement): void;
  unmountEditor(group: string): void;
  onActivate(tab: string): void;
  onClose(tab: string): void;
  /** Makes a preview tab a normal one (double-click). */
  onKeep?(tab: string): void;
  onFocusGroup(group: string): void;
  onDrop(target: DropTarget): void;
  onTabMenu(tab: Tab, x: number, y: number): void;
  onResize(sizes: number[]): void;
  /** Buttons at the start / end of a group's tab bar. */
  leading?(group: string): JSX.Element;
  actions?(group: string): JSX.Element;
  /** Shown in a group with no tabs. */
  empty(): JSX.Element;
}

export function Workbench(props: WorkbenchProps) {
  let rootEl!: HTMLDivElement;
  const groupIds = createMemo(() => props.layout.groups.map((g) => g.id), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const [hint, setHint] = createSignal<DropTarget | null>(null);

  const clear = () => setHint(null);
  window.addEventListener("dragend", clear);
  onCleanup(() => window.removeEventListener("dragend", clear));

  function drop(e: DragEvent) {
    const h = hint();
    setHint(null);
    if (!h || !dragging()) return;
    e.preventDefault();
    e.stopPropagation();
    props.onDrop(h);
    endDrag();
  }

  function startResize(e: MouseEvent, i: number) {
    e.preventDefault();
    const groups = props.layout.groups;
    const sizes = groups.map((g) => g.size);
    const total = sizes.reduce((a, b) => a + b, 0);
    const width = rootEl.clientWidth || 1;
    const startX = e.clientX;
    const pair = sizes[i] + sizes[i + 1];
    const move = (ev: MouseEvent) => {
      const delta = ((ev.clientX - startX) / width) * total;
      const min = total * 0.1;
      const a = Math.min(Math.max(sizes[i] + delta, min), pair - min);
      const next = [...sizes];
      next[i] = a;
      next[i + 1] = pair - a;
      props.onResize(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const totalSize = () => props.layout.groups.reduce((a, g) => a + (g.size > 0 ? g.size : 0), 0) || 1;

  const GroupView = (p: { id: string }) => {
    const group = createMemo(() => groupById(props.layout, p.id));
    const tabIds = createMemo(() => group()?.tabs.map((t) => t.id) ?? [], undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
    const tab = (id: string) => group()?.tabs.find((t) => t.id === id) ?? null;
    const showsText = () => { const g = group(); const a = g && activeTab(g); return a?.kind === "text"; };
    let editorEl!: HTMLDivElement;
    let barEl!: HTMLDivElement;
    onMount(() => props.mountEditor(p.id, editorEl));
    onCleanup(() => props.unmountEditor(p.id));

    /** Where a drop over the tab bar would land: before the first tab whose middle is right of the pointer. */
    function barIndex(e: DragEvent): number {
      const tabs = [...barEl.querySelectorAll<HTMLElement>(".tab")];
      const i = tabs.findIndex((t) => { const r = t.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
      return i < 0 ? tabs.length : i;
    }
    function overBar(e: DragEvent, index?: number) {
      if (!dragging()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      setHint({ group: p.id, index: index ?? barIndex(e) });
    }
    function overBody(e: DragEvent, el: HTMLElement) {
      if (!dragging()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const r = el.getBoundingClientRect();
      const x = r.width ? (e.clientX - r.left) / r.width : 0.5;
      setHint({ group: p.id, side: x < 0.25 ? "left" : x > 0.75 ? "right" : "center" });
    }
    const zone = () => { const h = hint(); return h && h.group === p.id && "side" in h ? h.side : null; };
    const insertAt = () => { const h = hint(); return h && h.group === p.id && "index" in h ? h.index : null; };

    return (
      <Show when={group()}>
        {(g) => (
          <section
            class={`group ${props.layout.activeGroup === p.id ? "focused" : ""}`}
            // Grow by the group's share of the total: flex-grow values adding up to less
            // than 1 leave part of the row empty (a lone group of size 0.5 fills half).
            style={{ flex: `${(g().size / totalSize()) * props.layout.groups.length} 1 0` }}
            onMouseDown={() => props.onFocusGroup(p.id)}
            onFocusIn={() => props.onFocusGroup(p.id)}
          >
            <div class="tabbar" onDragOver={(e) => overBar(e)} onDrop={drop}>
              <Show when={props.leading}><div class="tabbar-actions leading">{props.leading!(p.id)}</div></Show>
              <div class="tabs" ref={barEl}>
              <For each={tabIds()}>
                {(id, i) => {
                  const t = () => tab(id);
                  const label = () => (t() ? props.label(t()!) : { name: "", title: "" });
                  return (
                    <Show when={t()}>
                      <div
                        class={`tab ${g().active === id ? "active" : ""} ${t()!.kind} ${t()!.preview ? "preview" : ""} ${insertAt() === i() ? "insert-before" : ""} ${insertAt() === tabIds().length && i() === tabIds().length - 1 ? "insert-after" : ""}`}
                        title={t()!.preview ? `${label().title} — a preview: double-click to keep it open` : label().title}
                        draggable={true}
                        onDragStart={(e) => startDrag({ kind: "tab", tabId: id }, e)}
                        onDragEnd={() => { endDrag(); clear(); }}
                        onClick={() => props.onActivate(id)}
                        onDblClick={() => props.onKeep?.(id)}
                        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); props.onClose(id); } }}
                        onContextMenu={(e) => { e.preventDefault(); props.onTabMenu(t()!, e.clientX, e.clientY); }}
                      >
                        <span class="tab-name">{label().name}</span>
                        <Show when={label().detail}><span class="tab-detail">{label().detail}</span></Show>
                        <button
                          class={`tab-close ${label().dirty ? "dirty" : ""}`}
                          title="Close (⌘W)"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); props.onClose(id); }}
                        >
                          <span class="tab-dot">●</span><span class="tab-x">×</span>
                        </button>
                      </div>
                    </Show>
                  );
                }}
              </For>
              </div>
              <div class="tabbar-rest" />
              <Show when={props.actions}><div class="tabbar-actions">{props.actions!(p.id)}</div></Show>
            </div>
            <div class="group-body" onDragOver={(e) => overBody(e, e.currentTarget)} onDrop={drop}>
              <div class="editor" ref={editorEl} style={{ display: showsText() ? "block" : "none" }} />
              <For each={tabIds()}>
                {(id) => (
                  <Show when={tab(id) && tab(id)!.kind !== "text"}>
                    {/* untrack: built once per tab; its props update it, a layout change mustn't rebuild it */}
                    {untrack(() => props.renderPdf(() => tab(id), () => g().active === id))}
                  </Show>
                )}
              </For>
              <Show when={!g().tabs.length}><div class="empty">{props.empty()}</div></Show>
              <Show when={zone()}>{(z) => <div class={`drop-zone drop-${z()}`} />}</Show>
            </div>
          </section>
        )}
      </Show>
    );
  };

  return (
    <div class="workbench" ref={rootEl}>
      <For each={groupIds()}>
        {(id, i) => (
          <>
            <Show when={i() > 0}><div class="group-splitter" onMouseDown={(e) => startResize(e, i() - 1)} /></Show>
            <GroupView id={id} />
          </>
        )}
      </For>
    </div>
  );
}

