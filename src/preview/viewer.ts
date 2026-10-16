// Interface between the app and the PDF renderer, so the app (and its tests) don't
// depend on pdf.js directly.

import type { PdfLocation } from "./synctex";

/** Scroll position as a page and a fraction down that page, so it survives reloads. */
export interface Anchor {
  page: number;
  fraction: number;
  /** Zoom, as a multiple of fit-width (default: as it is). */
  zoom?: number;
}

export interface Viewer {
  /** Shows a PDF; keeps `anchor` (or the current position) in view and swaps without flicker. */
  load(data: ArrayBuffer, anchor?: Anchor | null): Promise<void>;
  anchor(): Anchor | null;
  /** Scrolls to and briefly highlights a location. */
  /** `quiet`: no highlight, and no scrolling if it's already in view (for following edits). */
  reveal(loc: PdfLocation, opts?: { quiet?: boolean }): void;
  /** Called on ⌘-click / double-click with a PDF position (points from the page's top-left). */
  onSync: ((page: number, x: number, y: number) => void) | null;
  /** Called when a link to something outside the PDF is clicked (a URL, or a path as written). */
  onLink: ((target: string) => void) | null;
  /** The PDF position under a screen point (points from the page's top-left), if it's on a page. */
  pointAt(clientX: number, clientY: number): { page: number; x: number; y: number } | null;
  destroy(): void;
}

export type ViewerFactory = (container: HTMLElement) => Promise<Viewer>;

/** The real pdf.js viewer, loaded on demand. */
export const pdfjsViewer: ViewerFactory = async (el) => {
  const { PdfJsViewer } = await import("./PdfJsViewer");
  return new PdfJsViewer(el);
};
