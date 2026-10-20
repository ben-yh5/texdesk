// Hovering a tikzpicture in the editor shows an "Edit diagram" button above it, so the
// diagram editor isn't only behind a shortcut.

import { Facet } from "@codemirror/state";
import { EditorView, hoverTooltip } from "@codemirror/view";
import { pictureAt } from "./tikz";

/** Called with a position in the picture to open. */
export const editDiagramAt = Facet.define<(pos: number) => void, ((pos: number) => void) | null>({
  combine: (v) => v[v.length - 1] ?? null,
});

export const diagramHover = [
  hoverTooltip((view, pos) => {
    const open = view.state.facet(editDiagramAt);
    const span = open && pictureAt(view.state.doc.toString(), pos);
    if (!open || !span) return null;
    return {
      pos: span.from, end: span.to, above: true,
      create: () => {
        const dom = document.createElement("button");
        dom.className = "cm-diagram-edit";
        dom.textContent = "Edit diagram";
        dom.title = "Open in the diagram editor (⇧⌘D)";
        dom.onmousedown = (e) => e.preventDefault(); // keep the editor's focus and selection
        dom.onclick = () => open(span.from);
        return { dom };
      },
    };
  }),
  EditorView.baseTheme({
    ".cm-diagram-edit": {
      font: "inherit", fontFamily: "var(--td-ui)", fontSize: "12px", padding: "3px 8px", cursor: "pointer",
      border: "none", background: "none", color: "var(--td-accent)",
    },
  }),
];
