// The sidebar's search view, as in Obsidian: a query box over every match in the workspace's
// .tex files, grouped by file. Clicking a match opens it; a file's header folds its matches.
// ↑↓ in the box move through the matches, Enter opens one, Esc (or ×) closes the view.

import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { SearchHit, snippet } from "../workspace/search";

export interface SearchPanelProps {
  /** Matches for a query, at most `limit`; reruns when the files change. */
  search(query: string, limit: number): SearchHit[];
  /** Workspace-relative path for a hit's file. */
  rel(path: string): string;
  /** `focus`: move focus to the editor (on a click; Enter keeps it in the box to go on stepping). */
  onOpen(hit: SearchHit, focus: boolean): void;
  onClose(): void;
  ref?(api: SearchPanelApi): void;
}

export interface SearchPanelApi {
  focus(query?: string): void;
  hasFocus(): boolean;
}

const LIMIT = 1000;

export function SearchPanel(props: SearchPanelProps) {
  const [query, setQuery] = createSignal("");
  const [debounced, setDebounced] = createSignal("");
  const [folded, setFolded] = createSignal(new Set<string>());
  const [index, setIndex] = createSignal(-1);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;

  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on(query, (q) => {
    clearTimeout(timer);
    timer = setTimeout(() => setDebounced(q), q.length < 3 ? 200 : 80);
  }, { defer: true }));

  const hits = createMemo(() => (debounced() ? props.search(debounced(), LIMIT) : []));
  const groups = createMemo(() => {
    const out: { path: string; hits: SearchHit[] }[] = [];
    for (const h of hits()) {
      if (out.at(-1)?.path !== h.path) out.push({ path: h.path, hits: [] });
      out.at(-1)!.hits.push(h);
    }
    return out;
  });
  /** The hits you can step through: those in unfolded files. */
  const visible = createMemo(() => groups().flatMap((g) => (folded().has(g.path) ? [] : g.hits)));
  createEffect(on(debounced, () => { setIndex(-1); setFolded(new Set<string>()); }));

  props.ref?.({
    focus(q) {
      if (q) { setQuery(q); setDebounced(q); }
      input.focus();
      input.select();
    },
    hasFocus: () => document.activeElement === input,
  });

  const toggle = (path: string) => {
    const next = new Set(folded());
    if (next.has(path)) next.delete(path); else next.add(path);
    setFolded(next);
  };

  const move = (d: number) => {
    const n = visible().length;
    if (!n) return;
    setIndex((index() + d + n) % n);
    queueMicrotask(() => list.querySelector(".search-hit.selected")?.scrollIntoView({ block: "nearest" }));
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const h = visible()[Math.max(index(), 0)];
      if (h) props.onOpen(h, false);
    } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); props.onClose(); }
  };

  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const where = (p: string) => { const r = props.rel(p); return r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : ""; };

  return (
    <div class="search-panel">
      <div class="search-box">
        <input
          ref={input}
          class="search-input"
          type="search"
          placeholder="Search .tex files"
          title="Matches case only if you type a capital letter"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKey}
          spellcheck={false}
          autocomplete="off"
        />
        <button class="search-close" title="Close search (Esc)" onClick={() => props.onClose()}>×</button>
      </div>
      <Show when={debounced()}>
        <div class="search-count">
          {hits().length >= LIMIT ? `${LIMIT}+ results` : `${hits().length} result${hits().length === 1 ? "" : "s"}`}
          <Show when={groups().length}> in {groups().length} file{groups().length === 1 ? "" : "s"}</Show>
        </div>
      </Show>
      <div class="search-results" ref={list}>
        <For each={groups()}>
          {(g) => (
            <div class="search-file">
              <div class="search-file-head" title={props.rel(g.path)} onClick={() => toggle(g.path)}>
                <span class="tree-icon">{folded().has(g.path) ? "▸" : "▾"}</span>
                <span class="search-file-name">{name(g.path)}</span>
                <span class="search-file-where">{where(g.path)}</span>
                <span class="search-file-count">{g.hits.length}</span>
              </div>
              <Show when={!folded().has(g.path)}>
                <For each={g.hits}>
                  {(h) => {
                    const s = snippet(h, 160);
                    return (
                      <div
                        class={`search-hit ${visible()[index()] === h ? "selected" : ""}`}
                        title={`Line ${h.line}`}
                        onClick={() => { setIndex(visible().indexOf(h)); props.onOpen(h, true); }}
                      >
                        {s.text.slice(0, s.from)}<mark>{s.text.slice(s.from, s.to)}</mark>{s.text.slice(s.to)}
                      </div>
                    );
                  }}
                </For>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
