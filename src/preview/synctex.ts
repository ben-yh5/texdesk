// SyncTeX: parse the (gunzipped) `.synctex` file and map source lines ↔ PDF positions.
// Positions are in PDF points from the page's top-left corner (what pdf.js uses).

export interface SyncRecord {
  /** `box` for hboxes (`(…)` and void `h`), `leaf` for glyph-ish records (`x k g $`). */
  kind: "box" | "leaf";
  input: number;
  line: number;
  page: number;
  /** Left edge and baseline. */
  x: number;
  y: number;
  w: number;
  h: number;
  d: number;
}

export interface SyncTex {
  inputs: Map<number, string>;
  /** Records per page (1-based page → records in file order). */
  pages: Map<number, SyncRecord[]>;
}

const SP_PER_BP = 65781.76;
const RECORD = /^([(hvxkg$[])(\d+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

export function parseSynctex(text: string): SyncTex {
  const inputs = new Map<number, string>();
  const pages = new Map<number, SyncRecord[]>();
  let unit = 1, mag = 1000, xOff = 0, yOff = 0;
  let page = 0;
  let content = false;

  for (const line of text.split("\n")) {
    if (!content) {
      let m: RegExpExecArray | null;
      if ((m = /^Input:(\d+):(.+)$/.exec(line))) inputs.set(+m[1], m[2]);
      else if ((m = /^Unit:(\d+)/.exec(line))) unit = +m[1];
      else if ((m = /^Magnification:(\d+)/.exec(line))) mag = +m[1];
      else if ((m = /^X Offset:(-?\d+)/.exec(line))) xOff = +m[1];
      else if ((m = /^Y Offset:(-?\d+)/.exec(line))) yOff = +m[1];
      else if (line.startsWith("Content:")) content = true;
      continue;
    }
    const c = line[0];
    if (c === "{") { page = parseInt(line.slice(1), 10); if (!pages.has(page)) pages.set(page, []); continue; }
    if (c === "}") { page = 0; continue; }
    if (line.startsWith("Input:")) {
      const m = /^Input:(\d+):(.+)$/.exec(line);
      if (m) inputs.set(+m[1], m[2]);
      continue;
    }
    if (line.startsWith("Postamble:")) break;
    if (!page) continue;
    const m = RECORD.exec(line);
    if (!m) continue;
    const k = m[1];
    if (k === "[" || k === "v") continue; // vertical boxes span whole regions; not useful for lookup
    const scale = (unit * mag) / 1000 / SP_PER_BP;
    pages.get(page)!.push({
      kind: k === "(" || k === "h" ? "box" : "leaf",
      input: +m[2],
      line: +m[3],
      page,
      x: (+m[4] + xOff) * scale,
      y: (+m[5] + yOff) * scale,
      w: m[6] !== undefined ? +m[6] * scale : 0,
      h: m[7] !== undefined ? +m[7] * scale : 0,
      d: m[8] !== undefined ? +m[8] * scale : 0,
    });
  }
  return { inputs, pages };
}

/** Compare paths, tolerating macOS's /private prefix and `./` relative inputs. */
function norm(p: string, baseDir: string): string {
  let s = p.startsWith("./") ? `${baseDir}/${p.slice(2)}` : p.startsWith("/") ? p : `${baseDir}/${p}`;
  s = s.replace(/\/\.\//g, "/").replace(/\/+/g, "/");
  return s.startsWith("/private/") ? s.slice(8) : s;
}

function inputIds(sync: SyncTex, file: string, baseDir: string): Set<number> {
  const want = norm(file, baseDir);
  const ids = new Set<number>();
  for (const [id, p] of sync.inputs) if (norm(p, baseDir) === want) ids.add(id);
  return ids;
}

export interface PdfLocation {
  page: number;
  x: number;
  /** Top of the line's box. */
  y: number;
  w: number;
  h: number;
  /** The source line it's for (the nearest line with output, if the asked-for one has none). */
  line?: number;
}

/** Source line → where it appears in the PDF (the first occurrence). */
export function forwardSearch(sync: SyncTex, file: string, line: number, baseDir: string): PdfLocation | null {
  return forwardSearchAll(sync, file, line, baseDir)[0] ?? null;
}

/** Source line → where it appears in the PDF: one place per page it's on, in page order. */
export function forwardSearchAll(sync: SyncTex, file: string, line: number, baseDir: string): PdfLocation[] {
  const ids = inputIds(sync, file, baseDir);
  if (!ids.size) return [];
  let bestLine = -1;
  let below = Infinity;
  for (const recs of sync.pages.values()) {
    for (const r of recs) {
      if (!ids.has(r.input)) continue;
      if (r.line <= line && r.line > bestLine) bestLine = r.line;
      if (r.line > line && r.line < below) below = r.line;
    }
  }
  const target = bestLine >= 0 ? bestLine : below;
  if (!Number.isFinite(target)) return [];

  const out: PdfLocation[] = [];
  const pages = [...sync.pages.keys()].sort((a, b) => a - b);
  for (const p of pages) {
    const recs = sync.pages.get(p)!.filter((r) => ids.has(r.input) && r.line === target);
    if (!recs.length) continue;
    // Prefer the leaf records (actual content on that line); use their row's box for size.
    const leaves = recs.filter((r) => r.kind === "leaf");
    const anchor = leaves[0] ?? recs[0];
    const row = sync.pages.get(p)!.find((r) => r.kind === "box" && r.w > 0 && Math.abs(r.y - anchor.y) < 0.5 && r.x <= anchor.x + 0.5 && anchor.x <= r.x + r.w + 0.5);
    const h = row ? row.h + row.d : 12;
    out.push({ page: p, x: row?.x ?? anchor.x, y: anchor.y - (row ? row.h : 10), w: row?.w ?? 0, h: Math.max(h, 8), line: target });
  }
  return out;
}

/** PDF position → source file and line. */
export function inverseSearch(sync: SyncTex, page: number, x: number, y: number): { file: string; line: number } | null {
  const recs = sync.pages.get(page);
  if (!recs?.length) return null;
  const named = (r: SyncRecord) => !!sync.inputs.get(r.input);

  // The smallest hbox containing the point.
  let box: SyncRecord | null = null;
  for (const r of recs) {
    if (r.kind !== "box" || !named(r) || r.w <= 0) continue;
    if (x >= r.x && x <= r.x + r.w && y >= r.y - r.h - 1 && y <= r.y + r.d + 1) {
      if (!box || r.w * (r.h + r.d) < box.w * (box.h + box.d)) box = r;
    }
  }

  // Within that box's row (or the whole page), the nearest leaf record.
  const pool = recs.filter((r) => r.kind === "leaf" && named(r) && (!box || (Math.abs(r.y - box.y) < 0.5 && r.x >= box.x - 0.5 && r.x <= box.x + box.w + 0.5)));
  let best: SyncRecord | null = null;
  let bestD = Infinity;
  for (const r of pool) {
    // Prefer records to the left of the click on the same row.
    const dy = Math.abs(r.y - y) * 3;
    const dx = r.x <= x ? x - r.x : (r.x - x) * 2;
    const dist = dy + dx;
    if (dist < bestD) { bestD = dist; best = r; }
  }
  const hit = best ?? box;
  if (!hit) return null;
  return { file: sync.inputs.get(hit.input)!, line: hit.line };
}
