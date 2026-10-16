// Following links in the editor: ⌘-click on `\link{…}`, `\input{…}`, `\includegraphics{…}`
// etc. opens the target (resolution is the app's job). `\link` targets are styled as links,
// and every link target gets a pointer cursor while ⌘ is held.

import { Facet, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { LinkRef, findLinks, linkAt } from "../workspace/links";

/** Called with the link to open. */
export const openLink = Facet.define<(ref: LinkRef) => void, ((ref: LinkRef) => void) | null>({
  combine: (v) => v[v.length - 1] ?? null,
});

const linkMark = Decoration.mark({ class: "cm-texlink" });
const pathMark = Decoration.mark({ class: "cm-texpath" });

function decorations(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    const start = view.state.doc.lineAt(from).from;
    const text = view.state.sliceDoc(start, view.state.doc.lineAt(to).to);
    for (const ref of findLinks(text)) {
      if (start + ref.from < last) continue; // two visible ranges on one line
      b.add(start + ref.from, start + ref.to, ref.command === "link" ? linkMark : pathMark);
      last = start + ref.to;
    }
  }
  return b.finish();
}

const marks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = decorations(view); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = decorations(u.view); }
  },
  { decorations: (v) => v.decorations },
);

/** The link at a document position, with offsets in document coordinates. */
export function linkAtPos(view: EditorView, pos: number): LinkRef | null {
  const line = view.state.doc.lineAt(pos);
  const ref = linkAt(line.text, pos - line.from);
  return ref && { ...ref, from: ref.from + line.from, to: ref.to + line.from };
}

/** Opens the link under the main cursor; false if there isn't one. */
export function followLinkAtCursor(view: EditorView): boolean {
  const ref = linkAtPos(view, view.state.selection.main.head);
  const open = view.state.facet(openLink);
  if (!ref || !open) return false;
  open(ref);
  return true;
}

const modClass = (on: boolean) => (view: EditorView) => { view.dom.classList.toggle("cm-mod-held", on); };

const handlers = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const ref = pos === null ? null : linkAtPos(view, pos);
    const open = view.state.facet(openLink);
    if (!ref || !open) return false;
    e.preventDefault();
    open(ref);
    return true;
  },
  keydown(e, view) { if (e.key === "Meta" || e.key === "Control") modClass(true)(view); return false; },
  keyup(e, view) { if (e.key === "Meta" || e.key === "Control") modClass(false)(view); return false; },
  blur(_e, view) { modClass(false)(view); return false; },
});

const theme = EditorView.baseTheme({
  ".cm-texlink": { color: "var(--td-accent)", textDecoration: "underline", textDecorationColor: "color-mix(in srgb, var(--td-accent) 40%, transparent)", textUnderlineOffset: "2px" },
  "&.cm-mod-held .cm-texlink, &.cm-mod-held .cm-texpath": { cursor: "pointer", textDecoration: "underline" },
});

export const links = [marks, handlers, theme];
