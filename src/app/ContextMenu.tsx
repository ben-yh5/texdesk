// Right-click menu used by the file tree, the editor and the PDF pane. Closes on a click
// elsewhere, Escape, scrolling or the window losing focus, and stays inside the window.

import { For, Show, onCleanup, onMount } from "solid-js";

export type ContextItem =
  | { label: string; hint?: string; disabled?: boolean; run: () => unknown }
  | "separator";

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextItem[];
  onClose(): void;
}

export function ContextMenu(props: ContextMenuProps) {
  let el!: HTMLDivElement;
  const close = (e?: Event) => {
    if (e?.target instanceof Element && el.contains(e.target)) return;
    props.onClose();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); props.onClose(); } };
  const onBlur = () => props.onClose();

  onMount(() => {
    // Keep it on screen: open up/left when there isn't room below/right.
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 4) el.style.left = `${Math.max(4, props.x - r.width)}px`;
    if (r.bottom > window.innerHeight - 4) el.style.top = `${Math.max(4, props.y - r.height)}px`;
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("wheel", onBlur, { passive: true });
  });
  onCleanup(() => {
    window.removeEventListener("mousedown", close, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("wheel", onBlur);
  });

  // Drop separators at the ends and doubled ones (items are often conditional).
  const items = () => {
    const out: ContextItem[] = [];
    for (const it of props.items) if (it !== "separator" || (out.length && out[out.length - 1] !== "separator")) out.push(it);
    if (out[out.length - 1] === "separator") out.pop();
    return out;
  };

  return (
    <div class="ctx-menu" ref={el} style={{ left: `${props.x}px`, top: `${props.y}px` }} onContextMenu={(e) => e.preventDefault()}>
      <For each={items()}>
        {(it) => it === "separator" ? <div class="ctx-menu-sep" /> : (
          <button
            class="ctx-menu-item"
            disabled={it.disabled}
            onClick={() => { props.onClose(); void it.run(); }}
          >
            <span>{it.label}</span>
            <Show when={it.hint}><span class="ctx-menu-hint">{it.hint}</span></Show>
          </button>
        )}
      </For>
    </div>
  );
}
