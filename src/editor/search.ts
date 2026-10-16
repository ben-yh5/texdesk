// Find and replace: CodeMirror's search panel at the top of the editor. ⌘F finds (the
// selection, if any, becomes the query), ⌥⌘F finds with the cursor in the replace field,
// ⌘G / ⇧⌘G go to the next / previous match, Esc closes.

import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { closeSearchPanel, findNext, findPrevious, openSearchPanel, search } from "@codemirror/search";

/** Opens the panel; with `replace`, puts the cursor in its replace field. */
export function openFind(view: EditorView, replace = false): boolean {
  openSearchPanel(view);
  if (replace) view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus();
  return true;
}

export const findReplace = [
  search({ top: true }),
  Prec.high(keymap.of([
    { key: "Mod-f", run: (v) => openFind(v), scope: "editor search-panel", preventDefault: true },
    { key: "Mod-Alt-f", run: (v) => openFind(v, true), scope: "editor search-panel", preventDefault: true },
    { key: "Mod-g", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
    { key: "Escape", run: closeSearchPanel, scope: "editor search-panel" },
  ])),
];
