// The bar over the PDF pane: the shown document's folders (click one for its overview) and
// the documents next to it, so you can get around from the PDF side without links in the document.

import { For, Show } from "solid-js";
import { basename } from "../host/types";

export interface PdfNavProps {
  /** Its folders, outermost first (absolute paths). */
  folders: { label: string; dir: string }[];
  /** The documents in its folder, in overview order (absolute paths). */
  docs: string[];
  /** The document shown (absolute). */
  current: string;
  onOverview(dir: string): void;
  onOpen(path: string): void;
}

export function PdfNav(props: PdfNavProps) {
  const at = () => props.docs.indexOf(props.current);
  const go = (delta: number) => { const p = props.docs[at() + delta]; if (p) props.onOpen(p); };
  return (
    <div class="pdf-nav">
      <nav class="pdf-nav-crumbs">
        <For each={props.folders}>{(f, i) => (
          <>
            <Show when={i() > 0}><span class="pdf-nav-sep">›</span></Show>
            <button class="pdf-nav-crumb" title={`Overview of ${f.label}`} onClick={() => props.onOverview(f.dir)}>{f.label}</button>
          </>
        )}</For>
      </nav>
      <Show when={props.docs.length > 1}>
        <button class="tb-btn pdf-nav-prev" title="Previous document in this folder" disabled={at() <= 0} onClick={() => go(-1)}>‹</button>
        <select class="pdf-nav-docs" title="Documents in this folder" onChange={(e) => props.onOpen(e.currentTarget.value)}>
          <For each={props.docs}>{(p) => <option value={p} selected={p === props.current}>{basename(p).replace(/\.tex$/, "")}</option>}</For>
        </select>
        <button class="tb-btn pdf-nav-next" title="Next document in this folder" disabled={at() < 0 || at() >= props.docs.length - 1} onClick={() => go(1)}>›</button>
      </Show>
    </div>
  );
}
