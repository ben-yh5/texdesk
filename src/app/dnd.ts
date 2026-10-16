// What's being dragged right now, shared by the file tree and the editor groups. (The
// HTML drag data isn't readable during dragover, and jsdom has none at all.)

export type Dragged = { kind: "tab"; tabId: string } | { kind: "file"; path: string };

let current: Dragged | null = null;

export const dragging = () => current;
export function startDrag(d: Dragged, e?: DragEvent) {
  current = d;
  e?.dataTransfer?.setData("text/plain", d.kind === "file" ? d.path : d.tabId);
  if (e?.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
export const endDrag = () => { current = null; };
