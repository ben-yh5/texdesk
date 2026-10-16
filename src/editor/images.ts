// Paste image: save the clipboard image into the class figures folder and insert a figure.

import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { Host, basename, dirname, join } from "../host/types";

const pad = (n: number) => String(n).padStart(2, "0");

/** `hw3-20261006-142530.png` */
export function figureName(stem: string, now: Date, suffix = ""): string {
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stem}-${ts}${suffix}.png`;
}

export interface SavedFigure {
  /** Where the image was written. */
  path: string;
  /** What goes in \includegraphics{…}. */
  include: string;
}

/**
 * Writes `png` for the document `file`. Inside a class it goes to the class figures folder
 * (on the build's search path, so the bare name works); otherwise to `figures/` next to the file.
 */
export async function saveFigure(host: Host, file: string, figuresDir: string | null, png: ArrayBuffer, now = new Date()): Promise<SavedFigure> {
  const stem = basename(file).replace(/\.\w+$/, "");
  const dir = figuresDir ?? join(dirname(file), "figures");
  for (let i = 1; i < 100; i++) {
    const name = figureName(stem, now, i === 1 ? "" : `-${i}`);
    const path = join(dir, name);
    if (await host.exists(path)) continue;
    await host.createBinary(path, png);
    return { path, include: figuresDir ? name : `figures/${name}` };
  }
  throw new Error("couldn't find a free file name for the image");
}

export function insertFigure(view: EditorView, include: string) {
  const state = view.state;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const indent = /^\s*/.exec(line.text)![0];
  const before = state.sliceDoc(line.from, sel.from);
  const after = state.sliceDoc(sel.to, line.to);
  const lead = before.trim() ? "\n" + indent : "";
  const block = [
    "\\begin{figure}[H]",
    `${indent}  \\centering`,
    `${indent}  \\includegraphics[width=0.6\\linewidth]{${include}}`,
    `${indent}\\end{figure}`,
  ].join("\n");
  const tail = after.trim() ? "\n" + indent : "";
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: lead + block + tail },
    selection: EditorSelection.cursor(sel.from + lead.length + block.length),
    annotations: isolateHistory.of("full"),
    userEvent: "input.paste",
    scrollIntoView: true,
  });
}
