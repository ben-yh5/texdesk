// TikZ pictures as objects the diagram editor can change: finds the tikzpicture around the
// cursor, splits its body into statements, and reads the parts that can be edited directly
// (where a node or coordinate is placed, a node's text, the literal points of a path). Anything
// else is kept exactly as written; it changes only through the code or the AI.

export interface Span {
  from: number;
  to: number;
}

/** A literal `(x,y)` point; the span covers the text between the parentheses. */
export interface Coord extends Span {
  x: number;
  y: number;
}

export type ItemKind = "node" | "coordinate" | "path" | "other";

/** One statement of the picture's body (offsets into the picture's text). */
export interface Item extends Span {
  /** "s0", "s1"… in order. */
  id: string;
  kind: ItemKind;
  /** The command, e.g. "\\draw". */
  command: string;
  /** A node's or coordinate's name. */
  name?: string;
  /** Where a name can be inserted (right after the command). */
  nameAt: number;
  /** A node's or coordinate's `at (x,y)`, when it's a literal point. */
  at?: Coord;
  /** The inside of a node's text braces. */
  text?: Span;
  /** A path's absolute literal points, in order. */
  coords: Coord[];
}

export interface Picture {
  /** The whole `\begin{tikzpicture}…\end{tikzpicture}`. */
  src: string;
  /** Where `\end{tikzpicture}` starts. */
  bodyEnd: number;
  items: Item[];
}

const BEGIN = "\\begin{tikzpicture}";
const END = "\\end{tikzpicture}";
/** Commands that end at a `;`. */
const PATH_COMMANDS = new Set(["path", "draw", "fill", "filldraw", "shade", "shadedraw", "clip", "pattern", "useasboundingbox", "node", "coordinate", "pic", "matrix", "graph"]);

/** Index after the comment at `i` (a `%` that isn't escaped), or `i`. */
function skipComment(s: string, i: number): number {
  if (s[i] !== "%" || s[i - 1] === "\\") return i;
  const nl = s.indexOf("\n", i);
  return nl < 0 ? s.length : nl + 1;
}

function skipSpace(s: string, i: number, end = s.length): number {
  for (;;) {
    while (i < end && /\s/.test(s[i])) i++;
    const j = skipComment(s, i);
    if (j === i) return i;
    i = j;
  }
}

/** Index after the group opening at `i` (`{…}`, `[…]` or `(…)`), skipping nested braces and comments. */
function skipGroup(s: string, i: number, end = s.length): number {
  const open = s[i];
  const close = open === "{" ? "}" : open === "[" ? "]" : ")";
  let depth = 0, braces = 0;
  for (let j = i; j < end; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "%") { j = skipComment(s, j) - 1; continue; }
    if (open !== "{") {
      if (c === "{") braces++;
      else if (c === "}") braces--;
      if (braces > 0) continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return end;
}

/** Index after the `;` that ends the statement starting at `i` (outside braces and brackets). */
function statementEnd(s: string, i: number, end: number): number {
  for (let j = i; j < end; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "%") { j = skipComment(s, j) - 1; continue; }
    if (c === "{" || c === "[") { j = skipGroup(s, j, end) - 1; continue; }
    if (c === ";") return j + 1;
  }
  return end;
}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)`;
const POINT = new RegExp(String.raw`^\s*(${NUM})\s*,\s*(${NUM})\s*$`);

/** The point in the parentheses at `open` (an index of `(`), if it's a literal `x,y`. */
function literalPoint(s: string, open: number, close: number): Coord | null {
  const m = POINT.exec(s.slice(open + 1, close - 1));
  return m ? { from: open + 1, to: close - 1, x: Number(m[1]), y: Number(m[2]) } : null;
}

/** Reads a `\node`/`\coordinate` header: options, name, `at (…)` and (for a node) its text. */
function readNode(s: string, item: Item, end: number) {
  let i = item.nameAt, afterAt = false;
  while (i < end) {
    i = skipSpace(s, i, end);
    const c = s[i];
    if (c === "[") { i = skipGroup(s, i, end); continue; }
    if (c === "(") {
      const close = skipGroup(s, i, end);
      if (afterAt) {
        item.at = literalPoint(s, i, close) ?? undefined;
        afterAt = false;
      } else if (item.name === undefined) {
        item.name = s.slice(i + 1, close - 1).trim();
      }
      i = close;
      continue;
    }
    if (/^at\b/.test(s.slice(i, i + 3))) { afterAt = true; i += 2; continue; }
    if (c === "{" && item.kind === "node") {
      const close = skipGroup(s, i, end);
      item.text = { from: i + 1, to: close - 1 };
    }
    return;
  }
}

/** A path's absolute literal points (not the ones after `+`/`++`, in braces, or in options). */
function readPathPoints(s: string, from: number, to: number): Coord[] {
  const out: Coord[] = [];
  for (let i = from; i < to; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "%") { i = skipComment(s, i) - 1; continue; }
    if (c === "{" || c === "[") { i = skipGroup(s, i, to) - 1; continue; }
    if (c !== "(") continue;
    const close = skipGroup(s, i, to);
    const relative = /\+\s*$/.test(s.slice(Math.max(from, i - 3), i));
    const p = literalPoint(s, i, close);
    if (p && !relative) out.push(p);
    i = close - 1;
  }
  return out;
}

/** Parses a picture's text (from `\begin{tikzpicture}` to `\end{tikzpicture}`). */
export function parsePicture(src: string): Picture {
  let i = src.indexOf(BEGIN);
  i = i < 0 ? 0 : i + BEGIN.length;
  const opts = skipSpace(src, i);
  if (src[opts] === "[") i = skipGroup(src, opts);
  const endAt = src.lastIndexOf(END);
  const bodyEnd = endAt < 0 ? src.length : endAt;
  const items: Item[] = [];

  while (i < bodyEnd) {
    i = skipSpace(src, i, bodyEnd);
    if (i >= bodyEnd) break;
    if (src[i] !== "\\") { i++; continue; }
    const m = /^\\([a-zA-Z@]+|.)/s.exec(src.slice(i, i + 40));
    if (!m) { i++; continue; }
    const name = m[1];
    const from = i;
    let to: number;
    let kind: ItemKind = "other";
    if (name === "foreach") {
      // \foreach \x in {…} {body} or \foreach \x in {…} \draw …;
      const inAt = src.indexOf("in", i);
      let j = inAt < 0 ? bodyEnd : skipSpace(src, inAt + 2, bodyEnd);
      if (src[j] === "{") j = skipSpace(src, skipGroup(src, j, bodyEnd), bodyEnd);
      to = src[j] === "{" ? skipGroup(src, j, bodyEnd) : statementEnd(src, j, bodyEnd);
    } else if (PATH_COMMANDS.has(name)) {
      to = statementEnd(src, i + m[0].length, bodyEnd);
      if (name === "node") kind = "node";
      else if (name === "coordinate") kind = "coordinate";
      else if (name !== "matrix" && name !== "graph") kind = "path";
    } else {
      // Any other command: it and the groups right after it.
      to = i + m[0].length;
      while (to < bodyEnd && (src[to] === "{" || src[to] === "[")) to = skipGroup(src, to, bodyEnd);
    }
    const item: Item = { id: `s${items.length}`, kind, command: `\\${name}`, from, to, nameAt: from + m[0].length, coords: [] };
    if (kind === "node" || kind === "coordinate") readNode(src, item, to);
    if (kind === "path") item.coords = readPathPoints(src, item.nameAt, to);
    items.push(item);
    i = to;
  }
  return { src, bodyEnd, items };
}

/** Whether dragging can move the item. */
export const movable = (item: Item) => !!item.at || item.coords.length > 0;

/** The tikzpicture containing `pos` in `doc`, as offsets into `doc`. */
export function pictureAt(doc: string, pos: number): Span | null {
  let from = -1;
  for (let i = doc.indexOf(BEGIN); i >= 0; i = doc.indexOf(BEGIN, i + 1)) {
    const lineStart = doc.lastIndexOf("\n", i) + 1;
    if (/(^|[^\\])%/.test(doc.slice(lineStart, i))) continue; // commented out
    if (i > pos) break;
    from = i;
  }
  if (from < 0) return null;
  const end = doc.indexOf(END, from);
  if (end < 0) return null;
  const to = end + END.length;
  return pos <= to ? { from, to } : null;
}

/** Up to `lines` lines of the document text before and after the picture (plus the rest of the picture's own lines). */
export function surroundings(text: { before: string; after: string }, lines: number): { before: string; after: string } {
  const before = text.before.split("\n");
  const after = text.after.split("\n");
  return { before: before.slice(-lines - 1).join("\n"), after: after.slice(0, lines + 1).join("\n") };
}

/**
 * The picture without `indent` (the indentation of the line it starts on) at the start of its
 * other lines, so it reads as if it started its line. `reindent` puts it back.
 */
export function outdent(picture: string, indent: string): string {
  return picture.split("\n").map((l, i) => (i && l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n");
}

/** `indent` added to each of the picture's lines after the first (empty ones stay empty). */
export function reindent(picture: string, indent: string): string {
  return picture.split("\n").map((l, i) => (i && l ? indent + l : l)).join("\n");
}

/** A number as TikZ code: at most 3 decimals, no trailing zeros. */
export function fmt(n: number): string {
  const s = (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

interface Change extends Span {
  insert: string;
}

function apply(src: string, changes: Change[]): string {
  let out = src;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

function pointText(src: string, c: Coord, x: number, y: number): Change {
  const sep = /,\s/.test(src.slice(c.from, c.to)) ? ", " : ",";
  return { from: c.from, to: c.to, insert: `${fmt(x)}${sep}${fmt(y)}` };
}

/** The item's literal points moved by (dx, dy). */
export function moveItem(pic: Picture, item: Item, dx: number, dy: number): string {
  const points = item.at ? [item.at] : item.coords;
  return apply(pic.src, points.map((c) => pointText(pic.src, c, c.x + dx, c.y + dy)));
}

/** One literal point set to (x, y). */
export function setPoint(pic: Picture, c: Coord, x: number, y: number): string {
  return apply(pic.src, [pointText(pic.src, c, x, y)]);
}

export function setText(pic: Picture, item: Item, text: string): string {
  return item.text ? apply(pic.src, [{ ...item.text, insert: text }]) : pic.src;
}

/** Removes the item, and its line when nothing else (but a comment) is on it. */
export function deleteItem(pic: Picture, item: Item): string {
  const s = pic.src;
  const lineStart = s.lastIndexOf("\n", item.from - 1) + 1;
  const nl = s.indexOf("\n", item.to);
  const lineEnd = nl < 0 ? s.length : nl;
  if (!s.slice(lineStart, item.from).trim() && /^\s*(%.*)?$/.test(s.slice(item.to, lineEnd))) {
    return apply(s, [{ from: lineStart, to: Math.min(s.length, lineEnd + 1), insert: "" }]);
  }
  return apply(s, [{ from: item.from, to: item.to, insert: "" }]);
}

/** Adds a statement on its own line before `\end{tikzpicture}`, indented like the last one. */
export function addItem(pic: Picture, statement: string): string {
  const s = pic.src;
  const last = pic.items[pic.items.length - 1];
  const indent = last ? /^[ \t]*/.exec(s.slice(s.lastIndexOf("\n", last.from - 1) + 1))![0] : "  ";
  const lineStart = s.lastIndexOf("\n", pic.bodyEnd - 1) + 1;
  const before = s.slice(lineStart, pic.bodyEnd);
  if (!before.trim()) return apply(s, [{ from: lineStart, to: lineStart, insert: `${indent}${statement}\n` }]);
  return apply(s, [{ from: pic.bodyEnd, to: pic.bodyEnd, insert: `\n${indent}${statement}\n` }]);
}

/** A name not used by any item: n1, n2… */
export function freshName(pic: Picture, prefix = "n"): string {
  const used = new Set(pic.items.map((it) => it.name));
  let k = 1;
  while (used.has(`${prefix}${k}`)) k++;
  return `${prefix}${k}`;
}

/** Gives the item a name (when it has none), so a new line can connect to it. */
export function nameItem(pic: Picture, item: Item, name: string): string {
  return apply(pic.src, [{ from: item.nameAt, to: item.nameAt, insert: ` (${name})` }]);
}

// ---- Instrumented build ----------------------------------------------------------------------
// The editor's build of a picture reports where things landed: after each statement it logs
// the points it uses, the extent of each node, and the statement's unit vectors (so dragging
// works under scale=, x=/y= and scopes), all in TeX points, with the bounding box left alone.

export const PROBE_MACROS = String.raw`\makeatletter
\def\texdeskout#1#2{\begin{pgfinterruptboundingbox}\path #2;\pgfgetlastxy{\texdesk@x}{\texdesk@y}\typeout{TXD #1 \texdesk@x\space\texdesk@y}\end{pgfinterruptboundingbox}}
\def\texdeskunits#1{\texdeskout{#1.o}{(0,0)}\texdeskout{#1.x}{(1,0)}\texdeskout{#1.y}{(0,1)}}
% A node's extent: its west/east/south/north anchors (corner anchors sit inside a circle).
\def\texdeskbox#1#2{\texdeskout{#1.w}{(#2.west)}\texdeskout{#1.e}{(#2.east)}\texdeskout{#1.s}{(#2.south)}\texdeskout{#1.n}{(#2.north)}}
% The bounding box's own corners (a path to them doesn't change it). An empty picture gets
% a canvas around the origin to draw on.
\def\texdeskbb{\ifdim\pgf@picmaxx<\pgf@picminx\path (-3,-2) rectangle (3,2);\fi\path (current bounding box.south west);\pgfgetlastxy{\texdesk@x}{\texdesk@y}\typeout{TXD bb.sw \texdesk@x\space\texdesk@y}\path (current bounding box.north east);\pgfgetlastxy{\texdesk@x}{\texdesk@y}\typeout{TXD bb.ne \texdesk@x\space\texdesk@y}}
\makeatother`;

/** The name a node without one gets in the editor's build. */
const probeName = (item: Item) => item.name || `texdesk-${item.id}`;

/** The picture with the probes added (and names for nodes without one). */
export function instrument(pic: Picture): string {
  const changes: Change[] = [];
  for (const item of pic.items) {
    if (item.kind === "other") continue;
    let probes = `\\texdeskunits{${item.id}}`;
    if (item.kind === "node" || item.kind === "coordinate") {
      if (!item.name) changes.push({ from: item.nameAt, to: item.nameAt, insert: ` (${probeName(item)})` });
      probes += item.kind === "node" ? `\\texdeskbox{${item.id}}{${probeName(item)}}` : `\\texdeskout{${item.id}.c}{(${probeName(item)})}`;
    }
    item.coords.forEach((c, k) => { probes += `\\texdeskout{${item.id}.c${k}}{(${pic.src.slice(c.from, c.to)})}`; });
    changes.push({ from: item.to, to: item.to, insert: probes });
  }
  changes.push({
    from: pic.bodyEnd, to: pic.bodyEnd,
    insert: "\\texdeskunits{top}\\texdeskbb\n",
  });
  return apply(pic.src, changes);
}

/** A standalone document for the picture, with the document's preamble (minus its class). */
export function diagramDocument(preamble: string, picture: string): string {
  const cls = /\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]*\}/;
  const rest = cls.test(preamble) ? preamble.replace(cls, "") : preamble || "\\usepackage{tikz}";
  return `\\documentclass[tikz,border=4pt]{standalone}\n${rest.trim()}\n${PROBE_MACROS}\n\\begin{document}\n${picture}\n\\end{document}\n`;
}

/** The text before `\begin{document}` (the whole text if there's none). */
export function preambleOf(doc: string): string {
  const i = doc.search(/^[^%\n]*\\begin\{document\}/m);
  return i < 0 ? "" : doc.slice(0, i + doc.slice(i).indexOf("\\begin{document}"));
}

export interface Point {
  x: number;
  y: number;
}

/** What the probes logged: id → point in TeX points. */
export function readProbes(log: string): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const m of log.matchAll(/TXD (\S+) (-?[\d.]+)pt (-?[\d.]+)pt/g)) out.set(m[1], { x: Number(m[2]), y: Number(m[3]) });
  return out;
}

/** Converts a distance in TeX points to picture units, from an item's unit vectors (o, x, y). */
export function toUnits(probes: Map<string, Point>, id: string, dx: number, dy: number): Point | null {
  const o = probes.get(`${id}.o`), ex = probes.get(`${id}.x`), ey = probes.get(`${id}.y`);
  if (!o || !ex || !ey) return null;
  const a = ex.x - o.x, b = ey.x - o.x, c = ex.y - o.y, d = ey.y - o.y;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (d * dx - b * dy) / det, y: (a * dy - c * dx) / det };
}
