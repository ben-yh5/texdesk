// The diagram editor: a window over the editor for one tikzpicture. The picture is built on
// its own (see build.ts) and drawn with pdf.js; the boxes and handles on top come from where
// TikZ reported each node and point, so dragging and adding things edits the code directly.
// The side panel has the code and a chat with Claude, which can answer questions about the
// picture or change it (see ai.ts). Done puts the code back in the file.

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchPanelOpen } from "@codemirror/search";
import { bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { latexLanguage } from "../editor/codeblocks";
import { findReplace, openFind } from "../editor/search";
import { highlight, theme } from "../editor/setup";
import { snippetExtension } from "../snippets/cm";
import type { SnippetRuntime } from "../snippets/runtime";
import type { AiKeyStatus, Host } from "../host/types";
import { AI_MODELS, AiSettings } from "../workspace/config";
import { DiagramBuild, DiagramError, buildDiagram } from "./build";
import { Turn, Usage, askClaude } from "./ai";
import { Item, Picture, Point, addItem, deleteItem, fmt, freshName, moveItem, movable, nameItem, parsePicture, setPoint, setText, surroundings, toUnits } from "./tikz";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Grid for dragging and adding, in picture units; Shift gives the fine one. */
const GRID = 0.25;
const FINE_GRID = 0.05;
/** TeX points per PDF point. */
const PT_PER_BP = 72.27 / 72;
/** Widest image sent to Claude, in pixels. */
const AI_IMAGE_WIDTH = 800;
/** Lines of the document before and after the picture sent to Claude, unless changed in the window. */
const CONTEXT_LINES = 10;

export interface DiagramEditorProps {
  host: Host;
  picture: string;
  preamble: string;
  /** The document text before and after the picture (Claude gets some lines of it). */
  context: { before: string; after: string };
  docDir: string;
  searchPaths: string[];
  tectonic: string | null;
  ai: AiSettings;
  /** The snippets, for the Ask box. */
  runtime: SnippetRuntime;
  /** The code's editor once it's there (null when it goes), so Find can search it. */
  onCodeView?(view: EditorView | null): void;
  onDone(picture: string): void;
  onCancel(): void;
  onOpenAiSettings(): void;
}

type Tool = "select" | "node" | "line" | "arrow" | "rectangle" | "circle";
const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: "select", label: "Select", key: "v" },
  { id: "node", label: "Node", key: "n" },
  { id: "line", label: "Line", key: "l" },
  { id: "arrow", label: "Arrow", key: "a" },
  { id: "rectangle", label: "Rectangle", key: "r" },
  { id: "circle", label: "Circle", key: "c" },
];

/** Items in the same order and with the same names: positions from an older build still fit. */
const shapeOf = (p: Picture) => p.items.map((i) => `${i.kind}:${i.name ?? ""}`).join("|");

/** A build drawn on screen: page size in PDF points and the drawing scale (pixels per PDF point). */
interface Shown {
  build: DiagramBuild;
  shape: string;
  w: number;
  h: number;
  scale: number;
}

type Drag =
  | { kind: "item"; item: Item; start: Point; now: Point }
  | { kind: "point"; item: Item; index: number; start: Point; now: Point }
  | { kind: "create"; tool: Tool; start: Point; now: Point };

const snap = (v: number, step: number) => Math.round(v / step) * step;

/** A message in the chat; `changed`: Claude's reply changed the picture. */
interface ChatMessage extends Turn {
  changed?: boolean;
  error?: boolean;
  note?: string;
}

/** A reply's text, with its code blocks (other than the picture, which is taken out) set apart. */
function ChatText(props: { text: string }) {
  return <For each={props.text.split(/```[a-z]*\n?/)}>{(part, i) => (i() % 2 ? <pre class="dg-msg-code">{part.replace(/\n$/, "")}</pre> : <span>{part}</span>)}</For>;
}

export function DiagramEditor(props: DiagramEditorProps) {
  const [src, setSrc] = createSignal(props.picture);
  const undoStack: string[] = [];
  const redoStack: string[] = [];
  const pic = createMemo(() => parsePicture(src()));
  const [shown, setShown] = createSignal<Shown | null>(null);
  const [building, setBuilding] = createSignal(false);
  const [errors, setErrors] = createSignal<DiagramError[]>([]);
  const [tool, setTool] = createSignal<Tool>("select");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [drag, setDrag] = createSignal<Drag | null>(null);
  /** A node whose text is being typed (an existing one, or a new one at `at`, in picture units). */
  const [textEdit, setTextEdit] = createSignal<{ item?: Item; at?: Point; px: Point; value: string } | null>(null);
  const [request, setRequest] = createSignal("");
  const [tab, setTab] = createSignal<"chat" | "code">("chat");
  const [chat, setChat] = createSignal<ChatMessage[]>([]);
  const [aiStatus, setAiStatus] = createSignal<string | null>(null);
  const [aiBusy, setAiBusy] = createSignal(false);
  /** Null until checked; "denied": TeXdesk wasn't allowed to read the key, so Claude is off. */
  const [keyStatus, setKeyStatus] = createSignal<AiKeyStatus | null>(null);
  const [total, setTotal] = createSignal<Usage>({ input: 0, output: 0 });
  /** For this window only; Settings → AI has the default model. */
  const [model, setModel] = createSignal(props.ai.model);
  const [contextLines, setContextLines] = createSignal(CONTEXT_LINES);
  const models = AI_MODELS.some((m) => m.value === props.ai.model) ? AI_MODELS : [{ value: props.ai.model, label: props.ai.model }, ...AI_MODELS];
  let canvas!: HTMLCanvasElement;
  let stage!: HTMLDivElement;
  let pdfData: ArrayBuffer | null = null;

  // Checked again until there's a key, so one added or allowed in Settings meanwhile is picked up
  // (after a Deny this doesn't ask the Keychain again; only `retry` does).
  const checkKey = (retry = false) => props.host.aiKeyStatus(retry).then(setKeyStatus, () => setKeyStatus("none"));
  void checkKey();
  const keyTimer = setInterval(() => { if (keyStatus() !== "saved") void checkKey(); }, 1500);
  onCleanup(() => clearInterval(keyTimer));

  /** Changes the picture as one undo step. */
  function edit(next: string) {
    if (next === src()) return;
    undoStack.push(src());
    redoStack.length = 0;
    setSrc(next);
  }
  function undo() { const p = undoStack.pop(); if (p !== undefined) { redoStack.push(src()); setSrc(p); setSelected(null); } }
  function redo() { const n = redoStack.pop(); if (n !== undefined) { undoStack.push(src()); setSrc(n); setSelected(null); } }

  // ---- building and drawing ----

  const buildOpts = (picture: string) => ({ docDir: props.docDir, preamble: props.preamble, picture, searchPaths: props.searchPaths, tectonic: props.tectonic });
  /** The last build, by picture text (Claude's answer is built once to check it, then shown). */
  let cache: { picture: string; build: DiagramBuild } | null = null;
  async function build(picture: string): Promise<DiagramBuild> {
    if (cache?.picture === picture) return cache.build;
    const b = await buildDiagram(props.host, buildOpts(picture));
    if (!b.cancelled) cache = { picture, build: b };
    return b;
  }

  async function draw(b: DiagramBuild, shape: string) {
    if (!b.pdf) return;
    const data = await props.host.readBinary(b.pdf);
    pdfData = data;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const box = stage.parentElement!.getBoundingClientRect();
    const scale = Math.max(0.5, Math.min((box.width - 32) / base.width, (box.height - 32) / base.height, 4));
    const vp = page.getViewport({ scale: scale * devicePixelRatio });
    const off = document.createElement("canvas");
    off.width = Math.ceil(vp.width);
    off.height = Math.ceil(vp.height);
    await page.render({ canvas: off, canvasContext: off.getContext("2d")!, viewport: vp }).promise;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.style.width = `${base.width * scale}px`;
    canvas.style.height = `${base.height * scale}px`;
    canvas.getContext("2d")!.drawImage(off, 0, 0);
    setShown({ build: b, shape, w: base.width, h: base.height, scale });
    void doc.loadingTask.destroy();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  createEffect(() => {
    const picture = src();
    const shape = shapeOf(pic());
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const gen = ++generation;
      setBuilding(true);
      try {
        const b = await build(picture);
        if (gen !== generation || b.cancelled) return;
        setErrors(b.errors);
        if (b.ok) await draw(b, shape);
      } catch (err) {
        if (gen === generation) setErrors([{ line: null, message: String(err) }]);
      } finally {
        if (gen === generation) { setBuilding(false); setDrag(null); }
      }
    }, 250);
  });
  onCleanup(() => clearTimeout(timer));

  /** The drawing matches the code's structure, so its boxes can be used. */
  const live = () => { const s = shown(); return !!s && s.shape === shapeOf(pic()); };

  // ---- TeX points ↔ pixels on the stage ----

  function frame() {
    const s = shown()!;
    const p = s.build.probes;
    const sw = p.get("bb.sw") ?? { x: 0, y: 0 }, ne = p.get("bb.ne") ?? { x: 0, y: 0 };
    // The page is the bounding box plus an equal border all round (standalone's border).
    const mx = (s.w - (ne.x - sw.x) / PT_PER_BP) / 2;
    const my = (s.h - (ne.y - sw.y) / PT_PER_BP) / 2;
    return { s, sw, mx, my };
  }
  function toPx(pt: Point): Point {
    const { s, sw, mx, my } = frame();
    return { x: (mx + (pt.x - sw.x) / PT_PER_BP) * s.scale, y: (s.h - my - (pt.y - sw.y) / PT_PER_BP) * s.scale };
  }
  function toPt(px: Point): Point {
    const { s, sw, mx, my } = frame();
    return { x: (px.x / s.scale - mx) * PT_PER_BP + sw.x, y: (s.h - my - px.y / s.scale) * PT_PER_BP + sw.y };
  }
  /** A pixel position as a point of the picture (its top-level coordinates), snapped. */
  function toPicture(px: Point, fine: boolean): Point | null {
    const pt = toPt(px);
    const o = shown()!.build.probes.get("top.o");
    if (!o) return null;
    const u = toUnits(shown()!.build.probes, "top", pt.x - o.x, pt.y - o.y);
    const step = fine ? FINE_GRID : GRID;
    return u && { x: snap(u.x, step), y: snap(u.y, step) };
  }
  /** A drag (in pixels) as a distance in the item's own units. */
  function dragUnits(item: Item, d: Drag): Point | null {
    const ptPerPx = PT_PER_BP / shown()!.scale;
    return toUnits(shown()!.build.probes, item.id, (d.now.x - d.start.x) * ptPerPx, -(d.now.y - d.start.y) * ptPerPx);
  }

  interface Box { item: Item; x: number; y: number; w: number; h: number }
  /** Node boxes, coordinate markers and path points, in pixels. */
  const boxes = createMemo((): Box[] => {
    if (!live()) return [];
    const probes = shown()!.build.probes;
    const out: Box[] = [];
    for (const item of pic().items) {
      const sides = ["w", "e", "s", "n"].map((k) => probes.get(`${item.id}.${k}`));
      const c = probes.get(`${item.id}.c`);
      if (sides.every(Boolean)) {
        const px = sides.map((p) => toPx(p!));
        const xs = px.map((p) => p.x), ys = px.map((p) => p.y);
        const x = Math.min(...xs), y = Math.min(...ys);
        out.push({ item, x, y, w: Math.max(6, Math.max(...xs) - x), h: Math.max(6, Math.max(...ys) - y) });
      } else if (c) {
        const p = toPx(c);
        out.push({ item, x: p.x - 4, y: p.y - 4, w: 8, h: 8 });
      }
    }
    return out;
  });
  const points = (item: Item): Point[] => {
    if (!live()) return [];
    const probes = shown()!.build.probes;
    return item.coords.flatMap((_, k) => { const p = probes.get(`${item.id}.c${k}`); return p ? [toPx(p)] : []; });
  };
  const pathItems = () => (live() ? pic().items.filter((i) => i.kind === "path" && points(i).length) : []);
  const selectedItem = () => pic().items.find((i) => i.id === selected()) ?? null;

  /** The node box under a pixel position. */
  const nodeAt = (p: Point) => boxes().find((b) => b.item.kind !== "path" && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h)?.item ?? null;

  // ---- pointer input ----

  const pos = (e: PointerEvent | MouseEvent): Point => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /**
   * Follows the pointer on the window until it's released. (Not pointer capture: that sends the
   * click and double-click that follow to the stage, so a node's double-click never got to it.)
   */
  function follow() {
    const up = (e: PointerEvent) => { unfollow(); onUp(e); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    unfollow = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      unfollow = () => {};
    };
  }
  let unfollow = () => {};
  onCleanup(() => unfollow());

  function onStageDown(e: PointerEvent) {
    if (!live() || aiBusy() || e.button !== 0) return;
    const p = pos(e);
    if (tool() === "select") {
      setSelected(null);
      return;
    }
    if (tool() === "node") {
      const at = toPicture(p, e.shiftKey);
      if (at) setTextEdit({ at, px: p, value: "" });
      return;
    }
    setDrag({ kind: "create", tool: tool(), start: p, now: p });
    follow();
  }
  function onItemDown(e: PointerEvent, item: Item, index?: number) {
    if (tool() !== "select" || !live() || aiBusy() || e.button !== 0) return;
    e.stopPropagation();
    setSelected(item.id);
    if (!movable(item)) return;
    const p = pos(e);
    // ⌥-dragging one of a path's points moves the whole path.
    setDrag(index === undefined || e.altKey ? { kind: "item", item, start: p, now: p } : { kind: "point", item, index, start: p, now: p });
    follow();
  }
  function onMove(e: PointerEvent) {
    const d = drag();
    if (d) setDrag({ ...d, now: pos(e) });
  }
  function onUp(e: PointerEvent) {
    const d = drag();
    if (!d) return;
    const moved = Math.hypot(d.now.x - d.start.x, d.now.y - d.start.y) > 3;
    if (!moved) { setDrag(null); return; }
    if (d.kind === "create") {
      create(d, e.shiftKey);
      setDrag(null);
      return;
    }
    const step = e.shiftKey ? FINE_GRID : GRID;
    const u = dragUnits(d.item, d);
    let next = src();
    if (u && d.kind === "item") next = moveItem(pic(), d.item, snap(u.x, step), snap(u.y, step));
    else if (u && d.kind === "point") {
      const c = d.item.coords[d.index];
      next = setPoint(pic(), c, snap(c.x + u.x, step), snap(c.y + u.y, step));
    }
    // The drag stays drawn where it was dropped until the new build shows the change.
    if (next === src()) setDrag(null);
    else edit(next);
  }

  /** Adds a line, arrow, rectangle or circle for a drag. */
  function create(d: Drag & { kind: "create" }, fine: boolean) {
    const a = toPicture(d.start, fine), b = toPicture(d.now, fine);
    if (!a || !b) return;
    let p = pic();
    if (d.tool === "line" || d.tool === "arrow") {
      // Ends on a node connect to it (naming it if it has no name).
      const end = (px: Point, at: Point) => {
        const node = nodeAt(px);
        if (!node) return `(${fmt(at.x)},${fmt(at.y)})`;
        let name = node.name;
        if (!name) {
          name = freshName(p);
          p = parsePicture(nameItem(p, p.items.find((i) => i.id === node.id)!, name));
        }
        return `(${name})`;
      };
      const from = end(d.start, a), to = end(d.now, b);
      edit(addItem(p, `\\draw${d.tool === "arrow" ? "[->]" : ""} ${from} -- ${to};`));
    } else if (d.tool === "rectangle") {
      edit(addItem(p, `\\draw (${fmt(a.x)},${fmt(a.y)}) rectangle (${fmt(b.x)},${fmt(b.y)});`));
    } else if (d.tool === "circle") {
      const r = snap(Math.hypot(b.x - a.x, b.y - a.y), fine ? FINE_GRID : GRID) || GRID;
      edit(addItem(p, `\\draw (${fmt(a.x)},${fmt(a.y)}) circle (${fmt(r)});`));
    }
  }

  function commitText() {
    const t = textEdit();
    setTextEdit(null);
    if (!t) return;
    if (t.item) edit(setText(pic(), t.item, t.value));
    else if (t.at && t.value.trim()) {
      const name = freshName(pic());
      edit(addItem(pic(), `\\node (${name}) at (${fmt(t.at.x)},${fmt(t.at.y)}) {${t.value}};`));
    }
  }

  function editText(item: Item) {
    const box = boxes().find((b) => b.item.id === item.id);
    if (!item.text || !box) return;
    setTextEdit({ item, px: { x: box.x, y: box.y + box.h / 2 }, value: src().slice(item.text.from, item.text.to) });
  }

  // ---- keys ----

  const typing = (e: KeyboardEvent) =>
    e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || (e.target instanceof Element && !!e.target.closest(".cm-editor"));
  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "Enter") { e.preventDefault(); props.onDone(src()); return; }
    // ⌘F anywhere in the window searches the code (in the code itself, its own keymap already did).
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f" && !e.defaultPrevented && codeView) { e.preventDefault(); openFind(codeView); return; }
    if (typing(e)) return;
    if (e.shiftKey && e.key === "Enter") { e.preventDefault(); props.onDone(src()); return; }
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod) return;
    const item = selectedItem();
    if (e.key === "Escape") { e.preventDefault(); if (selected()) setSelected(null); else setTool("select"); return; }
    if (item && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); edit(deleteItem(pic(), item)); setSelected(null); return; }
    if (item && e.key === "Enter" && item.text) { e.preventDefault(); editText(item); return; }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (item && arrows[e.key] && movable(item)) {
      e.preventDefault();
      const step = e.shiftKey ? FINE_GRID : GRID;
      edit(moveItem(pic(), item, arrows[e.key][0] * step, arrows[e.key][1] * step));
      return;
    }
    const t = TOOLS.find((x) => x.key === e.key);
    if (t) { e.preventDefault(); setTool(t.id); }
  }
  let dialog!: HTMLDivElement;
  let code!: HTMLDivElement;
  let codeView: EditorView | undefined;
  /** ⇧Enter in the code or the Ask box: Done (elsewhere in the window, onKey takes it). */
  const doneKey = { key: "Shift-Enter", run: () => { props.onDone(src()); return true; } };
  let askView: EditorView | undefined;
  onMount(() => {
    // Take the focus from the text editor (it keeps it when a snippet or its hover button opens
    // this): to the Ask box, or else the window, which takes the tools' keys.
    (askView ?? dialog).focus();
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));

    // The code, highlighted like the main editor. Typing there is one undo step for the picture
    // (taken when it gets focus); its own history only undoes typing, not the canvas's changes.
    const view = new EditorView({
      parent: code,
      state: EditorState.create({
        doc: src(),
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), bracketMatching(), latexLanguage, syntaxHighlighting(highlight), theme, findReplace,
          EditorView.theme({ ".cm-scroller": { fontSize: "11.5px", lineHeight: "1.5" }, ".cm-content": { padding: "8px 0" } }),
          EditorView.contentAttributes.of({ "aria-label": "TikZ code", spellcheck: "false" }),
          keymap.of([doneKey, ...defaultKeymap, ...historyKeymap]),
          EditorView.domEventHandlers({
            focus: () => { undoStack.push(src()); },
            blur: () => { if (undoStack[undoStack.length - 1] === src()) undoStack.pop(); },
          }),
          EditorView.updateListener.of((u) => {
            if (searchPanelOpen(u.state) && !searchPanelOpen(u.startState)) setTab("code");
            const text = u.state.doc.toString();
            if (u.docChanged && text !== src()) { redoStack.length = 0; setSrc(text); }
          }),
        ],
      }),
    });
    createEffect(() => {
      const s = src();
      if (s !== view.state.doc.toString()) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s }, annotations: Transaction.addToHistory.of(false) });
      }
    });
    // Hidden while the chat shows, so it measures itself again when it comes back.
    createEffect(() => { if (tab() === "code") view.requestMeasure(); });
    codeView = view;
    props.onCodeView?.(view);
    onCleanup(() => { props.onCodeView?.(null); codeView = undefined; view.destroy(); });
  });

  /**
   * The chat's message box: LaTeX like the main editor (highlighting and snippets). Enter sends,
   * ⇧Enter is Done, Esc goes back to the tools' keys.
   */
  function mountAsk(parent: HTMLDivElement) {
    const editable = new Compartment();
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: request(),
        extensions: [
          history(), drawSelection(), bracketMatching(), EditorView.lineWrapping, latexLanguage, syntaxHighlighting(highlight), theme,
          snippetExtension(props.runtime),
          editable.of(EditorView.editable.of(true)),
          placeholder("Ask about the picture, or to change it, e.g. “add a node C below B and connect it to A”"),
          EditorView.theme({
            "&": { height: "auto" },
            ".cm-scroller": { fontFamily: "var(--td-ui)", fontSize: "12.5px", lineHeight: "1.45", maxHeight: "6em" },
            ".cm-content": { padding: "4px 0", maxWidth: "none" },
          }),
          EditorView.contentAttributes.of({ "aria-label": "Ask Claude", spellcheck: "false" }),
          keymap.of([
            doneKey,
            { key: "Enter", run: () => { void ask(); return true; } },
            { key: "Escape", run: () => { dialog.focus(); return true; } },
            ...defaultKeymap, ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => { if (u.docChanged) setRequest(u.state.doc.toString()); }),
        ],
      }),
    });
    createEffect(() => view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!aiBusy())) }));
    askView = view;
    onCleanup(() => { askView = undefined; view.destroy(); });
  }

  // ---- Claude ----

  /** The current drawing as a base64 PNG at most AI_IMAGE_WIDTH wide, for Claude to look at. */
  async function snapshot(): Promise<string | null> {
    if (!pdfData || !shown()) return null;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfData.slice(0)) }).promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(3, AI_IMAGE_WIDTH / base.width) });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
      return c.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
    } finally {
      void doc.loadingTask.destroy();
    }
  }

  let messages!: HTMLDivElement;
  const scrollChat = () => queueMicrotask(() => messages && (messages.scrollTop = messages.scrollHeight));
  const say = (m: ChatMessage) => { setChat((c) => [...c, m]); scrollChat(); };

  async function ask() {
    const text = request().trim();
    if (!text || aiBusy()) return;
    // Earlier messages Claude answered (a failed one goes without its answer).
    const history: Turn[] = [];
    const c = chat();
    for (let i = 0; i + 1 < c.length; i++) {
      if (c[i].role === "user" && c[i + 1].role === "assistant" && !c[i + 1].error) history.push({ role: "user", text: c[i].text }, { role: "assistant", text: c[i + 1].text || "(Changed the picture.)" });
    }
    setAiBusy(true);
    setSelected(null);
    say({ role: "user", text });
    askView?.dispatch({ changes: { from: 0, to: askView.state.doc.length } });
    try {
      const res = await askClaude(props.host, {
        settings: { ...props.ai, model: model() },
        picture: src(),
        preamble: props.preamble,
        context: surroundings(props.context, contextLines()),
        request: text,
        history,
        image: errors().length ? null : await snapshot().catch(() => null),
        check: async (candidate) => { const b = await build(candidate); return b.cancelled ? [{ line: null, message: "the build was interrupted" }] : b.errors; },
        onStatus: setAiStatus,
      });
      setTotal((t) => ({ input: t.input + res.usage.input, output: t.output + res.usage.output }));
      const tokens = `${res.usage.input.toLocaleString()} tokens in, ${res.usage.output.toLocaleString()} out`;
      if (res.error) {
        say({ role: "assistant", text: res.error, error: true, note: res.usage.input ? tokens : undefined });
        if (/API key/i.test(res.error)) void checkKey();
      } else {
        if (res.picture) edit(res.picture);
        say({ role: "assistant", text: res.reply ?? "", changed: !!res.picture, note: tokens });
      }
    } finally {
      setAiBusy(false);
      setAiStatus(null);
      scrollChat();
    }
  }

  // ---- view ----

  const ghost = (item: Item): Point => {
    const d = drag();
    return d && d.kind === "item" && d.item.id === item.id ? { x: d.now.x - d.start.x, y: d.now.y - d.start.y } : { x: 0, y: 0 };
  };
  const pointAt = (item: Item, k: number, p: Point): Point => {
    const d = drag();
    const g = ghost(item);
    if (d && d.kind === "point" && d.item.id === item.id && d.index === k) return { x: p.x + d.now.x - d.start.x, y: p.y + d.now.y - d.start.y };
    return { x: p.x + g.x, y: p.y + g.y };
  };
  const lineNote = (e: DiagramError) => (e.line ? `Line ${e.line}: ` : "");

  return (
    <div class="dg-backdrop">
      <div class="dg" role="dialog" aria-label="Diagram editor" tabIndex={-1} ref={dialog}>
        <div class="dg-bar">
          <span class="dg-title">Diagram</span>
          <div class="dg-tools" role="toolbar" aria-label="Tools">
            <For each={TOOLS}>
              {(t) => (
                <button class={`dg-tool ${tool() === t.id ? "active" : ""}`} title={`${t.label} (${t.key.toUpperCase()})`} onClick={() => setTool(t.id)}>{t.label}</button>
              )}
            </For>
          </div>
          <span class="dg-status">{building() ? "Building…" : !live() && shown() ? "Updating…" : ""}</span>
          <span class="ov-spacer" />
          <button class="tb-btn" onClick={undo} title="Undo (⌘Z)" aria-label="Undo">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5 2.5 6.5l3 3" /><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7" /></svg>
          </button>
          <button class="tb-btn" onClick={redo} title="Redo (⇧⌘Z)" aria-label="Redo">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m10.5 3.5 3 3-3 3" /><path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9" /></svg>
          </button>
          <span class="dg-sep" />
          <button class="dg-btn" onClick={props.onCancel}>Cancel</button>
          <button class="dg-btn primary" onClick={() => props.onDone(src())} title="Put the picture in the file (⇧↩ or ⌘↩)">Done</button>
        </div>
        <div class="dg-main">
          <div class="dg-canvas-wrap">
            <div
              ref={stage} class={`dg-stage tool-${tool()}`}
              onPointerDown={onStageDown}
            >
              <canvas ref={canvas} class="dg-canvas" />
              <For each={boxes()}>
                {(b) => (
                  <div
                    class={`dg-box ${b.item.kind} ${selected() === b.item.id ? "selected" : ""} ${movable(b.item) ? "movable" : "fixed"}`}
                    style={{ left: `${b.x + ghost(b.item).x}px`, top: `${b.y + ghost(b.item).y}px`, width: `${b.w}px`, height: `${b.h}px` }}
                    title={movable(b.item) ? undefined : "Placed by TikZ (relative position): change it in the code"}
                    onPointerDown={(e) => onItemDown(e, b.item)}
                    onDblClick={() => editText(b.item)}
                  />
                )}
              </For>
              <For each={pathItems()}>
                {(item) => (
                  <For each={points(item)}>
                    {(p, k) => (
                      <div
                        class={`dg-point ${selected() === item.id ? "selected" : ""}`}
                        style={{ left: `${pointAt(item, k(), p).x - 5}px`, top: `${pointAt(item, k(), p).y - 5}px` }}
                        title="Drag to move this point; ⌥-drag or the arrow keys move the whole path"
                        onPointerDown={(e) => onItemDown(e, item, k())}
                      />
                    )}
                  </For>
                )}
              </For>
              <Show when={drag()?.kind === "create" ? (drag() as Drag & { kind: "create" }) : null}>
                {(d) => (
                  <svg class="dg-preview">
                    <Show when={d().tool === "rectangle"}>
                      <rect x={Math.min(d().start.x, d().now.x)} y={Math.min(d().start.y, d().now.y)} width={Math.abs(d().now.x - d().start.x)} height={Math.abs(d().now.y - d().start.y)} />
                    </Show>
                    <Show when={d().tool === "circle"}>
                      <circle cx={d().start.x} cy={d().start.y} r={Math.hypot(d().now.x - d().start.x, d().now.y - d().start.y)} />
                    </Show>
                    <Show when={d().tool === "line" || d().tool === "arrow"}>
                      <line x1={d().start.x} y1={d().start.y} x2={d().now.x} y2={d().now.y} />
                    </Show>
                  </svg>
                )}
              </Show>
              <Show when={textEdit()}>
                {(t) => (
                  <input
                    class="dg-text" value={t().value} placeholder="Text (LaTeX, e.g. $x_1$)" spellcheck={false}
                    style={{ left: `${t().px.x}px`, top: `${t().px.y - 14}px` }}
                    ref={(el) => setTimeout(() => { el.focus(); el.select(); })}
                    onInput={(e) => setTextEdit({ ...t(), value: e.currentTarget.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitText(); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setTextEdit(null); } }}
                    onBlur={commitText}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                )}
              </Show>
            </div>
            <Show when={!shown() && !errors().length}>
              <div class="dg-empty">{building() ? "Building the picture…" : ""}</div>
            </Show>
          </div>
          <div class="dg-side">
            <div class="dg-tabs" role="tablist" aria-label="Side panel">
              <button class={`dg-tab ${tab() === "chat" ? "active" : ""}`} role="tab" aria-selected={tab() === "chat"} onClick={() => { setTab("chat"); askView?.focus(); }}>Chat</button>
              <button class={`dg-tab ${tab() === "code" ? "active" : ""}`} role="tab" aria-selected={tab() === "code"} onClick={() => { setTab("code"); codeView?.focus(); }}>Code</button>
            </div>
            <div class="dg-chat" hidden={tab() !== "chat"}>
              <Show
                when={keyStatus() !== "none" && keyStatus() !== "denied"}
                fallback={
                  <Show
                    when={keyStatus() === "denied"}
                    fallback={<div class="dg-ai-key">To ask Claude, add your Anthropic API key in Settings → AI. <button class="set-link" onClick={props.onOpenAiSettings}>Open Settings</button></div>}
                  >
                    <div class="dg-ai-key">Claude is off: TeXdesk wasn't allowed to read your API key from the Keychain. <button class="set-link" onClick={() => void checkKey(true)}>Allow Keychain access</button></div>
                  </Show>
                }
              >
                <div class="dg-messages" ref={messages}>
                  <Show when={!chat().length && !aiBusy()}>
                    <div class="dg-chat-empty">Ask Claude about the picture, or ask it to change something. Claude sees the code, how the picture looks and the text around it.</div>
                  </Show>
                  <For each={chat()}>
                    {(m) => (
                      <div class={`dg-msg ${m.role} ${m.error ? "error" : ""}`}>
                        <Show when={m.text}><div class="dg-msg-text"><ChatText text={m.text} /></div></Show>
                        <Show when={m.changed}><div class="dg-msg-changed">Changed the picture</div></Show>
                        <Show when={m.note}><div class="dg-msg-note">{m.note}</div></Show>
                      </div>
                    )}
                  </For>
                  <Show when={aiBusy()}><div class="dg-msg assistant pending">{aiStatus() ?? "Asking Claude…"}</div></Show>
                </div>
                <div class="dg-ai">
                  <div class={`dg-ask ${aiBusy() ? "busy" : ""}`} ref={mountAsk} />
                  <div class="dg-ai-foot">
                    <label class="dg-ai-opt" title="Lines of the document before and after the picture that Claude sees">
                      Context
                      <input
                        class="dg-context" type="number" min="0" max="500" value={contextLines()}
                        onInput={(e) => setContextLines(Math.max(0, Math.floor(Number(e.currentTarget.value)) || 0))}
                      />
                      lines
                    </label>
                    <select class="dg-model" aria-label="Model" onChange={(e) => setModel(e.currentTarget.value)}>
                      <For each={models}>{(m) => <option value={m.value} selected={m.value === model()}>{m.label}</option>}</For>
                    </select>
                    <span class="ov-spacer" />
                    <button class="dg-btn primary" disabled={aiBusy() || !request().trim()} onClick={() => void ask()}>{aiBusy() ? "Working…" : "Send"}</button>
                  </div>
                  <Show when={total().input}>
                    <div class="dg-ai-total">This session: {total().input.toLocaleString()} in, {total().output.toLocaleString()} out</div>
                  </Show>
                </div>
              </Show>
            </div>
            <div class="dg-code" ref={code} hidden={tab() !== "code"} />
            <Show when={errors().length}>
              <div class="dg-errors">
                <For each={errors().slice(0, 4)}>{(e) => <div class="dg-error">{lineNote(e)}{e.message}</div>}</For>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
