// pdf.js-based viewer: pages stacked vertically at fit-width, rendered lazily as they
// scroll into view. Reloads render the visible pages offscreen first, then swap, so a
// rebuild never flashes blank and the scroll position is kept. Zoom (a multiple of fit-width):
// pinch or ⌃-scroll zooms around the pointer, ⌘+ / ⌘− / ⌘0 while the PDF is focused or under
// the pointer, or the − % + buttons in its corner.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { PdfLocation } from "./synctex";
import type { Anchor, Viewer } from "./viewer";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const GAP = 12;
const PAD = 12;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
/** As pdf.js's own viewer: bigger canvases are slow to draw (or come out blank), so they're drawn coarser and stretched. */
const MAX_CANVAS_PIXELS = 2 ** 25;

interface PageBox {
  el: HTMLDivElement;
  w: number; // PDF points
  h: number;
  rendered: boolean;
  task?: ReturnType<PDFPageProxy["render"]>;
}

export class PdfJsViewer implements Viewer {
  onSync: Viewer["onSync"] = null;
  onLink: Viewer["onLink"] = null;
  private scroller: HTMLDivElement;
  private pagesEl: HTMLDivElement | null = null;
  private doc: PDFDocumentProxy | null = null;
  private pages: PageBox[] = [];
  private scale = 1;
  /** Multiple of fit-width. */
  private zoom = 1;
  /** Zoom while a pinch is in progress (shown as a CSS transform until it's rendered). */
  private pending: { zoom: number; clientX: number; clientY: number } | null = null;
  /** Zoom the pages on screen were laid out at, and the pinch transform on them (origin 0 0). */
  private shownZoom = 1;
  private shift = { t: 1, x: 0, y: 0 };
  private pinchTimer: ReturnType<typeof setTimeout> | undefined;
  private hovered = false;
  private zoomLabel: HTMLButtonElement;
  private observer: IntersectionObserver | null = null;
  private resizeObs: ResizeObserver;
  private lastWidth = 0;
  private generation = 0;
  /** Where it was scrolled to while last shown: hidden (display: none), nothing can be measured. */
  private kept: Anchor | null = null;
  /** A PDF loaded while hidden, laid out once shown. */
  private waiting: { data: ArrayBuffer; anchor: Anchor | null } | null = null;

  constructor(container: HTMLElement) {
    this.scroller = document.createElement("div");
    this.scroller.className = "pdf-scroller";
    container.append(this.scroller);
    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(this.scroller);
    this.scroller.addEventListener("scroll", () => { if (this.shown()) this.kept = this.anchor(); });
    this.scroller.addEventListener("dblclick", (e) => this.sync(e));
    this.scroller.addEventListener("click", (e) => { if (e.metaKey || e.ctrlKey) this.sync(e); });
    this.scroller.tabIndex = -1;
    this.scroller.addEventListener("mousedown", () => this.scroller.focus({ preventScroll: true }));
    this.scroller.addEventListener("mouseenter", () => (this.hovered = true));
    this.scroller.addEventListener("mouseleave", () => (this.hovered = false));
    // Trackpad pinches arrive as wheel events with ctrlKey set.
    this.scroller.addEventListener("wheel", (e) => {
      if (!e.ctrlKey || !this.doc) return;
      e.preventDefault();
      const from = this.pending?.zoom ?? this.zoom;
      this.pinch(clampZoom(from * Math.exp(-e.deltaY / 100)), e.clientX, e.clientY);
    }, { passive: false });
    window.addEventListener("keydown", this.onKey, true);

    const bar = document.createElement("div");
    bar.className = "pdf-zoom";
    const btn = (text: string, title: string, run: () => void) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      b.addEventListener("click", (e) => { e.stopPropagation(); run(); });
      b.addEventListener("dblclick", (e) => e.stopPropagation());
      bar.append(b);
      return b;
    };
    btn("−", "Zoom out (⌘−)", () => this.step(-1));
    this.zoomLabel = btn("100%", "Fit width (⌘0)", () => void this.setZoom(1));
    btn("+", "Zoom in (⌘+)", () => this.step(1));
    container.append(bar);
  }

  private onKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || !this.doc || !this.scroller.offsetParent) return;
    if (!this.hovered && !this.scroller.contains(document.activeElement)) return;
    const d = e.key === "=" || e.key === "+" ? 1 : e.key === "-" || e.key === "_" ? -1 : e.key === "0" ? 0 : null;
    if (d === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (d === 0) void this.setZoom(1); else this.step(d);
  };

  private step(d: number) {
    const z = this.pending?.zoom ?? this.zoom;
    const next = d > 0 ? STEPS.find((s) => s > z + 0.001) : [...STEPS].reverse().find((s) => s < z - 0.001);
    void this.setZoom(next ?? z);
  }

  getZoom() { return this.zoom; }

  /** Zooms to `z` (a multiple of fit-width), keeping the point under `at` (else the top of the view) in place. */
  async setZoom(z: number, at?: { clientX: number; clientY: number }) {
    z = clampZoom(z);
    this.pending = null;
    if (!this.doc) { this.zoom = z; this.showZoom(); return; }
    const r = this.scroller.getBoundingClientRect();
    const focus = at ?? { clientX: r.left + this.scroller.clientWidth / 2, clientY: r.top };
    const point = this.pointAt(focus.clientX, focus.clientY);
    const keep = this.anchor();
    this.zoom = z;
    this.showZoom();
    if (!(await this.layout(this.doc, keep, ++this.generation))) return;
    if (point) {
      const box = this.pages[point.page - 1];
      this.scroller.scrollTop = box.el.offsetTop + point.y * this.scale - (focus.clientY - r.top);
      this.scroller.scrollLeft = box.el.offsetLeft + point.x * this.scale - (focus.clientX - r.left);
    } else this.scroller.scrollLeft = (this.scroller.scrollWidth - this.scroller.clientWidth) / 2;
    // The pinch went on while this was laid out: carry on from the new layout.
    const p = this.pending as PdfJsViewer["pending"]; // (TS assumes it's still null from above)
    if (p) this.pinch(p.zoom, p.clientX, p.clientY);
  }

  /** During a pinch: scale what's rendered at once, render properly once it pauses. */
  private pinch(z: number, clientX: number, clientY: number) {
    this.pending = { zoom: z, clientX, clientY };
    this.showZoom();
    const el = this.pagesEl;
    if (el) {
      // Scale about the pointer, so what's under it stays there.
      const r = el.getBoundingClientRect();
      const t = z / this.shownZoom;
      const k = 1 - t / this.shift.t;
      // But keep them where the layout will put them, so they don't jump once rendered: no gap
      // before or after them (unless they're shorter than the view), centred while narrower.
      const s = this.scroller;
      const fit = (v: number, scroll: number, view: number, size: number) => Math.min(scroll, Math.max(v, scroll + view - t * size));
      const x = z <= 1
        ? s.scrollLeft + (s.clientWidth - t * el.offsetWidth) / 2
        : fit(this.shift.x + (clientX - r.left) * k, s.scrollLeft, s.clientWidth, el.offsetWidth);
      const y = fit(this.shift.y + (clientY - r.top) * k, s.scrollTop, s.clientHeight, el.offsetHeight);
      this.shift = { t, x, y };
      el.style.transform = `translate(${x}px, ${y}px) scale(${t})`;
    }
    clearTimeout(this.pinchTimer);
    this.pinchTimer = setTimeout(() => {
      const p = this.pending;
      if (p) void this.setZoom(p.zoom, p);
    }, 150);
  }

  private showZoom() {
    this.zoomLabel.textContent = `${Math.round((this.pending?.zoom ?? this.zoom) * 100)}%`;
  }

  private shown() { return this.scroller.clientWidth > 0; }

  anchor(): Anchor | null {
    if (!this.shown()) return this.waiting?.anchor ?? this.kept;
    if (!this.pages.length) return null;
    const top = this.scroller.scrollTop;
    for (let i = 0; i < this.pages.length; i++) {
      const el = this.pages[i].el;
      if (el.offsetTop + el.offsetHeight > top) {
        return { page: i + 1, fraction: Math.max(0, (top - el.offsetTop) / el.offsetHeight), zoom: this.zoom };
      }
    }
    return { page: this.pages.length, fraction: 0, zoom: this.zoom };
  }

  async load(data: ArrayBuffer, anchor?: Anchor | null): Promise<void> {
    const gen = ++this.generation;
    const keep = anchor ?? this.anchor();
    if (!this.shown()) { this.waiting = { data, anchor: keep }; return; }
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
    if (gen !== this.generation) { void doc.loadingTask.destroy(); return; }
    if (anchor?.zoom) { this.zoom = clampZoom(anchor.zoom); this.showZoom(); }
    await this.layout(doc, keep, gen);
  }

  /** True if it finished (wasn't overtaken by a newer layout). */
  private async layout(doc: PDFDocumentProxy, keep: Anchor | null, gen: number): Promise<boolean> {
    const sizes = doc === this.doc ? this.pages.map(({ w, h }) => ({ w, h })) : [];
    for (let i = sizes.length + 1; i <= doc.numPages; i++) {
      const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
      sizes.push({ w: vp.width, h: vp.height });
    }
    if (gen !== this.generation) return false;
    const width = this.scroller.clientWidth || 600;
    this.lastWidth = width;
    const zoom = this.zoom;
    const scale = ((width - PAD * 2) / Math.max(...sizes.map((s) => s.w))) * zoom;

    const pagesEl = document.createElement("div");
    pagesEl.className = "pdf-pages";
    const pages: PageBox[] = sizes.map((s, i) => {
      const el = document.createElement("div");
      el.className = "pdf-page";
      el.dataset.page = String(i + 1);
      el.style.width = `${s.w * scale}px`;
      el.style.height = `${s.h * scale}px`;
      el.style.marginBottom = `${GAP}px`;
      pagesEl.append(el);
      return { el, w: s.w, h: s.h, rendered: false };
    });

    // A new document: render the pages that will be visible before showing anything. The same one
    // (zoom, resize): show it at once, the old canvases stretched until the pages re-render.
    const first = Math.min(Math.max((keep?.page ?? 1) - 1, 0), pages.length - 1);
    const old = this.doc;
    if (doc !== old) {
      await Promise.all([first, first + 1].filter((i) => i < pages.length).map((i) => this.renderPage(doc, pages[i], i + 1, scale)));
      if (gen !== this.generation) return false;
    } else {
      pages.forEach((p, i) => {
        const canvas = this.pages[i]?.el.querySelector("canvas");
        if (canvas) p.el.prepend(canvas);
      });
    }

    this.pages.forEach((p) => p.task?.cancel());
    this.observer?.disconnect();
    this.pagesEl?.remove();
    this.scroller.append(pagesEl);
    this.pagesEl = pagesEl;
    this.pages = pages;
    this.doc = doc;
    this.scale = scale;
    this.shownZoom = zoom;
    this.shift = { t: 1, x: 0, y: 0 };
    const target = pages[first].el;
    this.scroller.scrollTop = target.offsetTop + (keep?.fraction ?? 0) * target.offsetHeight;
    this.kept = this.anchor();
    if (old && old !== doc) void old.loadingTask.destroy();

    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const i = +(e.target as HTMLElement).dataset.page! - 1;
        if (!this.pages[i].rendered) void this.renderPage(this.doc!, this.pages[i], i + 1, this.scale);
      }
    }, { root: this.scroller, rootMargin: "100% 0px" });
    pages.forEach((p) => this.observer!.observe(p.el));
    return true;
  }

  private async renderPage(doc: PDFDocumentProxy, box: PageBox, n: number, scale: number) {
    box.rendered = true;
    const page = await doc.getPage(n);
    const dpr = window.devicePixelRatio || 1;
    const pixels = box.w * box.h * (scale * dpr) ** 2;
    const vp = page.getViewport({ scale: scale * dpr * Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / pixels)) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    // Fills the page box, so it can stand in (stretched) after the next zoom.
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    box.task = page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: vp });
    try {
      await box.task.promise;
    } catch (e) {
      if (e instanceof pdfjs.RenderingCancelledException) return; // zoomed or reloaded meanwhile
      throw e;
    }
    box.task = undefined;
    box.el.querySelector("canvas")?.remove();
    box.el.prepend(canvas);
    await this.addLinks(doc, page, box, scale);
  }

  /** Clickable areas over the page's link annotations (the canvas has none). */
  private async addLinks(doc: PDFDocumentProxy, page: PDFPageProxy, box: PageBox, scale: number) {
    let annots: { subtype: string; rect: number[]; url?: string; unsafeUrl?: string; dest?: unknown }[];
    try { annots = await page.getAnnotations(); } catch { return; }
    box.el.querySelectorAll(".pdf-link").forEach((e) => e.remove());
    for (const a of annots) {
      if (a.subtype !== "Link" || (!a.dest && !a.unsafeUrl && !a.url)) continue;
      const [x1, y1, x2, y2] = a.rect;
      const el = document.createElement("a");
      el.className = "pdf-link";
      el.style.left = `${Math.min(x1, x2) * scale}px`;
      el.style.top = `${(box.h - Math.max(y1, y2)) * scale}px`;
      el.style.width = `${Math.abs(x2 - x1) * scale}px`;
      el.style.height = `${Math.abs(y2 - y1) * scale}px`;
      const target = a.unsafeUrl ?? a.url;
      el.title = target ?? "";
      el.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey) return; // ⌘-click is SyncTeX
        e.preventDefault();
        e.stopPropagation();
        if (a.dest) void this.goToDest(doc, a.dest);
        else if (target) this.onLink?.(target);
      });
      box.el.append(el);
    }
  }

  /** Scrolls to an internal destination (\ref, \cite, table of contents…). */
  private async goToDest(doc: PDFDocumentProxy, dest: unknown) {
    try {
      const explicit = (typeof dest === "string" ? await doc.getDestination(dest) : dest) as unknown[] | null;
      if (!explicit || doc !== this.doc) return;
      const ref = explicit[0];
      const index = typeof ref === "number" ? ref : await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
      const box = this.pages[index];
      if (!box) return;
      const y = (explicit[1] as { name?: string })?.name === "XYZ" && typeof explicit[3] === "number" ? box.h - explicit[3] : 0;
      this.scroller.scrollTo({ top: Math.max(0, box.el.offsetTop + y * this.scale - 24), behavior: "smooth" });
    } catch { /* broken destination */ }
  }

  reveal(loc: PdfLocation, opts: { quiet?: boolean } = {}) {
    const box = this.pages[loc.page - 1];
    if (!box) return;
    const top = box.el.offsetTop + loc.y * this.scale;
    if (opts.quiet) {
      // Following edits: leave the view alone if the line is already on screen; no flash.
      const view = this.scroller.scrollTop;
      const bottom = view + this.scroller.clientHeight;
      if (top >= view + 16 && top + loc.h * this.scale <= bottom - 16) return;
      this.scroller.scrollTo({ top: Math.max(0, top - this.scroller.clientHeight / 3), behavior: "smooth" });
      return;
    }
    // Centered on the line (and, zoomed in, on its middle).
    const wide = this.scroller.scrollWidth > this.scroller.clientWidth;
    const mid = box.el.offsetLeft + (loc.x + (loc.w || box.w - loc.x * 2) / 2) * this.scale;
    this.scroller.scrollTo({
      top: Math.max(0, top + (loc.h * this.scale - this.scroller.clientHeight) / 2),
      ...(wide ? { left: Math.max(0, mid - this.scroller.clientWidth / 2) } : {}),
      behavior: "smooth",
    });
    const mark = document.createElement("div");
    mark.className = "pdf-highlight";
    mark.style.left = `${loc.x * this.scale}px`;
    mark.style.top = `${loc.y * this.scale}px`;
    mark.style.width = `${(loc.w || box.w - loc.x * 2) * this.scale}px`;
    mark.style.height = `${loc.h * this.scale}px`;
    box.el.append(mark);
    setTimeout(() => mark.remove(), 1600);
  }

  pointAt(clientX: number, clientY: number) {
    for (let i = 0; i < this.pages.length; i++) {
      const r = this.pages[i].el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        const scale = r.width / this.pages[i].w; // not this.scale: mid-pinch the pages are scaled
        return { page: i + 1, x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
      }
    }
    return null;
  }

  private sync(e: MouseEvent) {
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>(".pdf-page");
    if (!pageEl || !this.onSync) return;
    const r = pageEl.getBoundingClientRect();
    e.preventDefault();
    this.onSync(+pageEl.dataset.page!, (e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale);
  }

  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private onResize() {
    const w = this.scroller.clientWidth;
    if (!w) return;
    if (this.waiting) {
      const { data, anchor } = this.waiting;
      this.waiting = null;
      void this.load(data, anchor);
      return;
    }
    if (!this.doc || Math.abs(w - this.lastWidth) < 4) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => { if (this.shown()) void this.layout(this.doc!, this.anchor(), ++this.generation); }, 120);
  }

  destroy() {
    this.generation++;
    clearTimeout(this.pinchTimer);
    window.removeEventListener("keydown", this.onKey, true);
    this.observer?.disconnect();
    this.resizeObs.disconnect();
    void this.doc?.loadingTask.destroy();
    this.scroller.remove();
  }
}
