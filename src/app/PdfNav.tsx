// The tab bar's end over the PDF pane: the shown document's folders (click one for its
// overview), so you can get around from the PDF side without links in the document.

import { For, Show } from "solid-js";

export interface PdfNavProps {
  /** Its folders, outermost first (absolute paths). */
  folders: { label: string; dir: string }[];
  onOverview(dir: string): void;
}

export function PdfNav(props: PdfNavProps) {
  return (
    <nav class="pdf-nav-crumbs">
      <For each={props.folders}>{(f, i) => (
        <>
          <Show when={i() > 0}><span class="pdf-nav-sep">›</span></Show>
          <button class="pdf-nav-crumb" title={`Overview of ${f.label}`} onClick={() => props.onOverview(f.dir)}>{f.label}</button>
        </>
      )}</For>
    </nav>
  );
}
