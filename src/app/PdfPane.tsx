// One PDF tab's viewer: a PDF file, or the build output (reloaded on every build without
// losing the scroll position). Scroll positions are kept per PDF in `anchors`, so a tab
// dragged to another group comes back where it was.

import { Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { Host, basename } from "../host/types";
import type { PdfLocation } from "../preview/synctex";
import type { Anchor, Viewer, ViewerFactory } from "../preview/viewer";

export interface PdfPaneApi {
  /**
   * Scrolls to `loc`; given several (a line that's on more than one page), the one nearest
   * what's showing. `afterLoad`: wait for a reload in progress first (a fresh build's PDF).
   */
  reveal(loc: PdfLocation | PdfLocation[], opts?: { quiet?: boolean; afterLoad?: boolean }): void;
}

export interface PdfPaneProps {
  host: Host;
  factory: ViewerFactory;
  /** PDF to show; null shows `emptyMessage`. */
  pdf: string | null;
  /** Bumped on every rebuild, to reload the same file. */
  version?: number;
  visible: boolean;
  anchors: Map<string, Anchor>;
  emptyMessage: string;
  onSync?(page: number, x: number, y: number): void;
  onLink(target: string, pdf: string): void;
  onContextMenu(point: { page: number; x: number; y: number } | null, x: number, y: number): void;
  /** Receives the pane's API. (Not `ref`: Solid treats that name specially.) */
  api?(api: PdfPaneApi): void;
  /** The "Follow editor" switch in the corner (the build output only). */
  follow?: { on: boolean; toggle(): void };
}

export function PdfPane(props: PdfPaneProps) {
  let el!: HTMLDivElement;
  let viewer: Viewer | null = null;
  let shown: string | null = null;
  const [ready, setReady] = createSignal(false);
  const [message, setMessage] = createSignal<string | null>(null);

  onMount(async () => {
    viewer = await props.factory(el);
    viewer.onSync = (p, x, y) => props.onSync?.(p, x, y);
    viewer.onLink = (t) => shown && props.onLink(t, shown);
    setReady(true);
  });
  onCleanup(() => {
    const a = viewer?.anchor();
    if (shown && a) props.anchors.set(shown, a);
    viewer?.destroy();
  });
  /** The reload in progress, if any. */
  let loading: Promise<unknown> = Promise.resolve();
  const nearest = (locs: PdfLocation[]) => {
    const at = viewer?.anchor()?.page ?? 1;
    return locs.reduce((a, b) => (Math.abs(b.page - at) < Math.abs(a.page - at) ? b : a));
  };
  props.api?.({
    reveal: (loc, opts = {}) => void (opts.afterLoad ? loading : Promise.resolve()).then(() => {
      const locs = Array.isArray(loc) ? loc : [loc];
      if (locs.length) viewer?.reveal(nearest(locs), { quiet: opts.quiet });
    }),
  });

  createEffect(on([ready, () => props.pdf, () => props.version], ([ok, pdf]) => { loading = show(ok, pdf); }));

  async function show(ok: boolean, pdf: string | null) {
    if (!ok || !viewer) return;
    if (!pdf) { setMessage(props.emptyMessage); return; }
    const previous = shown;
    if (previous && previous !== pdf) {
      const a = viewer.anchor();
      if (a) props.anchors.set(previous, a);
    }
    shown = pdf;
    let data: ArrayBuffer;
    try {
      data = await props.host.readBinary(pdf);
    } catch {
      if (previous !== pdf) setMessage(props.emptyMessage);
      return;
    }
    try {
      await viewer.load(data, previous === pdf ? null : props.anchors.get(pdf) ?? { page: 1, fraction: 0, zoom: 1 });
      setMessage(null);
    } catch (err) {
      setMessage(`Couldn't show ${basename(pdf)}: ${String(err)}`);
    }
  }

  return (
    <div
      class="pdf-pane"
      style={{ display: props.visible ? "block" : "none" }}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onContextMenu(viewer?.pointAt(e.clientX, e.clientY) ?? null, e.clientX, e.clientY);
      }}
    >
      <div class="preview-viewer" ref={el} />
      <Show when={props.follow}>
        {(f) => (
          <button
            class={`pdf-follow ${f().on ? "on" : ""}`}
            title={f().on
              ? "Following the editor: double-clicking a line, and each build after an edit, scroll the PDF there. Click to stop."
              : "Not following the editor — the PDF stays where you leave it (⌘⇧J still shows the cursor's line). Click to follow."}
            onClick={() => f().toggle()}
            onDblClick={(e) => e.stopPropagation()}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 8h9M8 4.5 11.5 8 8 11.5M14 3v10" /></svg>
            {f().on ? "Following editor" : "Not following"}
          </button>
        )}
      </Show>
      <Show when={message()}>{(m) => <div class="preview-msg">{m()}</div>}</Show>
    </div>
  );
}
