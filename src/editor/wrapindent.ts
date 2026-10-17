// With line wrapping on, a wrapped line's continuation rows start at the line's own
// indentation instead of the left edge (a hanging indent).

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

/** How many columns `text`'s leading whitespace takes up. */
export function indentColumns(text: string, tabSize: number): number {
  let col = 0;
  for (const ch of text) {
    if (ch === " ") col++;
    else if (ch === "\t") col += tabSize - (col % tabSize);
    else break;
  }
  return col;
}

const cache = new Map<number, Decoration>();
function hanging(cols: number): Decoration {
  let d = cache.get(cols);
  // The line's own padding (6px from CM's base theme) plus the indent, minus it again for the first row.
  if (!d) cache.set(cols, (d = Decoration.line({ attributes: { style: `padding-left: calc(6px + ${cols}ch); text-indent: -${cols}ch` } })));
  return d;
}

function decorate(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const { doc, tabSize } = view.state;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      const cols = indentColumns(line.text, tabSize);
      if (cols && /\S/.test(line.text)) b.add(line.from, line.from, hanging(cols));
      pos = line.to + 1;
    }
  }
  return b.finish();
}

export const wrapIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = decorate(view); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = decorate(u.view); }
  },
  { decorations: (v) => v.decorations },
);
