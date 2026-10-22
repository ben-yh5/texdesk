import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pdf.js stand-in: three letter-size pages that "render" at once.
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  RenderingCancelledException: class extends Error {},
  getDocument: () => {
    const doc = {
      numPages: 3,
      loadingTask: { destroy: async () => {} },
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
        render: () => ({ promise: Promise.resolve(), cancel() {} }),
        getAnnotations: async () => [],
      }),
    };
    return { promise: Promise.resolve(doc) };
  },
}));

const { PdfJsViewer } = await import("../src/preview/PdfJsViewer");

// jsdom has no layout: pages stacked by their set heights, and nothing measures (or scrolls)
// while the panel is hidden, as with display: none.
let hidden = false;
const scrollTops = new WeakMap<Element, number>();
let resized: () => void = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  hidden = false;
  const px = (el: HTMLElement) => parseFloat(el.style.height) || 0;
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: { configurable: true, get() { return hidden ? 0 : this.classList.contains("pdf-scroller") ? 300 : 0; } },
    clientHeight: { configurable: true, get() { return hidden ? 0 : this.classList.contains("pdf-scroller") ? 400 : 0; } },
    offsetHeight: { configurable: true, get() { return hidden ? 0 : px(this); } },
    offsetTop: {
      configurable: true,
      get() {
        if (hidden) return 0;
        let top = 0;
        for (let e = this.previousElementSibling; e; e = e.previousElementSibling) top += px(e as HTMLElement) + 12;
        return top;
      },
    },
    scrollTop: {
      configurable: true,
      get() { return hidden ? 0 : scrollTops.get(this) ?? 0; },
      set(v: number) { if (!hidden) scrollTops.set(this, v); },
    },
  });
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { resized = cb; } observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
let viewer: InstanceType<typeof PdfJsViewer> | null = null;
afterEach(() => {
  viewer?.destroy();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const setHidden = async (h: boolean) => { hidden = h; resized(); await sleep(200); };

describe("PDF viewer scroll position", () => {
  it("is kept when the panel is hidden and shown again", async () => {
    const v = (viewer = new PdfJsViewer(document.body));
    await v.load(new ArrayBuffer(8));
    const scroller = document.querySelector(".pdf-scroller")!;
    scroller.scrollTop = 500; // on page 2
    scroller.dispatchEvent(new Event("scroll"));
    const before = v.anchor();
    await setHidden(true);
    await setHidden(false);
    expect(scroller.scrollTop).toBeCloseTo(500, 0);
    expect(v.anchor()).toEqual(before);
  });

  it("is kept when the PDF is rebuilt while the panel is hidden", async () => {
    const v = (viewer = new PdfJsViewer(document.body));
    await v.load(new ArrayBuffer(8));
    const scroller = document.querySelector(".pdf-scroller")!;
    scroller.scrollTop = 500;
    scroller.dispatchEvent(new Event("scroll"));
    const before = v.anchor();
    await setHidden(true);
    await v.load(new ArrayBuffer(8));
    await setHidden(false);
    expect(scroller.scrollTop).toBeCloseTo(500, 0);
    expect(v.anchor()).toEqual(before);
  });
});
