// Links between files: `\link{target}` (from the app-owned texdesk.sty) plus the paths in
// \input, \include, \lstinputlisting, \includegraphics and \href. Finding them in source,
// resolving them to files, and the reverse (which files link to this one).

import { dirname, extname, join } from "../host/types";

export const LINK_COMMANDS = ["link", "input", "include", "lstinputlisting", "includegraphics", "href", "url"] as const;
export type LinkCommand = (typeof LINK_COMMANDS)[number];

export interface LinkRef {
  command: LinkCommand;
  /** The target as written (inside the braces). */
  target: string;
  /** Offsets of the target text within the scanned string. */
  from: number;
  to: number;
}

const REF = new RegExp(`\\\\(${LINK_COMMANDS.join("|")})\\*?\\s*(?:\\[[^\\]\\n]*\\])?\\s*\\{([^{}\\n]*)\\}`, "g");

/** Link-like commands in `text`, skipping anything after an unescaped `%` on its line. */
export function findLinks(text: string): LinkRef[] {
  const out: LinkRef[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const code = line.slice(0, commentStart(line));
    for (const m of code.matchAll(REF)) {
      const target = m[2].trim();
      if (!target) continue;
      // The match ends with `{target}`; skip any spaces after the brace.
      const from = offset + m.index! + m[0].length - 1 - m[2].length + (m[2].length - m[2].trimStart().length);
      out.push({ command: m[1] as LinkCommand, target, from, to: from + target.length });
    }
    offset += line.length + 1;
  }
  return out;
}

function commentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (line[i] === "%") return i;
  }
  return line.length;
}

/** The link whose command or target contains `pos` (an offset into `lineText`), if any. */
export function linkAt(lineText: string, pos: number): LinkRef | null {
  const code = lineText.slice(0, commentStart(lineText));
  for (const m of code.matchAll(REF)) {
    if (pos < m.index! || pos > m.index! + m[0].length) continue;
    const ref = findLinks(m[0])[0];
    if (ref) return { ...ref, from: ref.from + m.index!, to: ref.to + m.index! };
  }
  return null;
}

export const isUrl = (target: string) => /^[a-z][a-z0-9+.-]*:/i.test(target) && !target.toLowerCase().startsWith("file:");

const EXTENSIONS: Record<LinkCommand, string[]> = {
  link: ["", ".tex"],
  input: ["", ".tex"],
  include: [".tex", ""],
  lstinputlisting: [""],
  includegraphics: ["", ".pdf", ".png", ".jpg", ".jpeg", ".eps"],
  href: [""],
  url: [""],
};

export interface ResolveContext {
  /** Absolute paths of every file in the workspace. */
  files: ReadonlySet<string>;
  root: string | null;
  /** Extra folders searched after the file's own folder (workspace root, class figures folder). */
  searchDirs?: string[];
  /** Absolute paths of the workspace's folders: \link can point at one (it opens its overview). */
  dirs?: ReadonlySet<string>;
}

export type Resolved = { kind: "file"; path: string } | { kind: "folder"; path: string } | { kind: "url"; url: string };

/** Normalizes `a/./b/../c` and duplicate slashes in an absolute path. */
export function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

/** Where a link in `fromFile` points: an existing file, a URL, or null if nothing matches. */
export function resolveLink(ref: Pick<LinkRef, "command" | "target">, fromFile: string, ctx: ResolveContext): Resolved | null {
  let target = ref.target;
  if (isUrl(target)) return { kind: "url", url: target };
  target = target.replace(/^file:(\/\/)?/i, "").replace(/#.*$/, "").replace(/\\([%#&_ ])/g, "$1");
  if (target.startsWith("~/") || !target) return null;
  const exts = EXTENSIONS[ref.command];
  // `../x` is relative to the file only. Other relative paths can also be found the way
  // TeX finds them: from the workspace root, and (for \input etc.) the build's search folders.
  const searched = ref.command === "link" ? [] : ctx.searchDirs ?? [];
  const dirs = target.startsWith("/") ? [""]
    : target.startsWith("../") ? [dirname(fromFile)]
    : [dirname(fromFile), ...(ctx.root ? [ctx.root] : []), ...searched];
  for (const d of dirs) {
    for (const ext of exts) {
      if (ext && extname(target) === ext.slice(1)) continue;
      const p = normalize(d ? join(d, target + ext) : target + ext);
      if (ctx.files.has(p)) return { kind: "file", path: p };
    }
  }
  // Obsidian-style: \link{lecture3} finds lecture3.tex anywhere in the workspace, preferring
  // the file that shares the longest folder prefix with the linking file.
  if (ref.command === "link" && ctx.root) {
    const names = new Set(exts.map((e) => "/" + target.replace(/^\.\//, "") + e));
    let best: string | null = null;
    let bestScore = -1;
    for (const f of ctx.files) {
      if (![...names].some((n) => f.endsWith(n))) continue;
      const score = sharedPrefix(f, fromFile);
      if (score > bestScore) { best = f; bestScore = score; }
    }
    if (best) return { kind: "file", path: best };
  }
  // A folder: \link[CS 101]{CS101} (by name, anywhere; nearest wins) or by relative path.
  if (ref.command === "link" && ctx.dirs) {
    for (const d of dirs) {
      const p = normalize(d ? join(d, target) : target);
      if (ctx.dirs.has(p)) return { kind: "folder", path: p };
    }
    if (!target.includes("/")) {
      let best: string | null = null;
      let bestScore = -1;
      for (const f of ctx.dirs) {
        if (!f.endsWith("/" + target)) continue;
        const score = sharedPrefix(f, fromFile);
        if (score > bestScore) { best = f; bestScore = score; }
      }
      if (best) return { kind: "folder", path: best };
    }
  }
  return null;
}

function sharedPrefix(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

export interface Backlink {
  /** File containing the link. */
  file: string;
  /** 1-based line of the link. */
  line: number;
  /** The line's text, trimmed (for display). */
  text: string;
}

/** Links in a file whose targets are other files (for the backlinks index). */
export function outgoingLinks(text: string, fromFile: string, ctx: ResolveContext): { path: string; line: number; text: string }[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let i = 0, o = 0; i < lines.length; o += lines[i].length + 1, i++) starts.push(o);
  const out: { path: string; line: number; text: string }[] = [];
  for (const ref of findLinks(text)) {
    if (ref.command === "href" || ref.command === "url") continue;
    const r = resolveLink(ref, fromFile, ctx);
    if (r?.kind !== "file" || r.path === fromFile) continue;
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= ref.from) line++;
    out.push({ path: r.path, line: line + 1, text: lines[line].trim() });
  }
  return out;
}

/** The target text for a new `\link` from `fromFile` to `target`: relative, and without `.tex`. */
export function linkTargetFor(fromFile: string, target: string): string {
  const from = dirname(fromFile).split("/").filter(Boolean);
  const to = target.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const rel = [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
  return rel.replace(/\.tex$/, "");
}

/** App-owned package providing `\link`; written to `.texdesk/tex/` and put on the build's search path. */
export const TEXDESK_STY = String.raw`\NeedsTeXFormat{LaTeX2e}
\ProvidesPackage{texdesk}[2026/10/06 TeXdesk links]
% Written by TeXdesk (refreshed automatically; don't edit). TeXdesk adds this folder to
% every build's search path, so \usepackage{texdesk} works in any document.
%
% \link[label]{target}: a link to another file, e.g. \link{lecture3} or
% \link[Problem set 2]{../hw/hw2.tex}. Cmd-click it in the editor, or click it in the
% PDF preview, to open the target. A bare name finds that .tex file anywhere in the
% workspace. Without a label it shows the file name (minus .tex); a URL shows as-is.
%
% hyperref is loaded at the end of the preamble unless the document loads it itself, so
% your own hyperref options never clash.
\AddToHook{begindocument/before}{%
  \@ifpackageloaded{hyperref}{}{%
    \RequirePackage{hyperref}%
    \hypersetup{colorlinks=true, allcolors=[rgb]{0.16,0.32,0.66}}}}
\ExplSyntaxOn
\str_new:N \l__texdesk_label_str
\str_new:N \l__texdesk_target_str
\seq_new:N \l__texdesk_parts_seq
\cs_new_protected:Npn \__texdesk_stem:n #1
  {
    \str_set:Nn \l__texdesk_label_str {#1}
    \str_if_in:NnF \l__texdesk_label_str { : }
      {
        \seq_set_split:NnV \l__texdesk_parts_seq { / } \l__texdesk_label_str
        \str_set:Nx \l__texdesk_label_str { \seq_item:Nn \l__texdesk_parts_seq { -1 } }
        \str_if_eq:eeT { \str_range:Nnn \l__texdesk_label_str { -4 } { -1 } } { .tex }
          { \str_set:Nx \l__texdesk_label_str { \str_range:Nnn \l__texdesk_label_str { 1 } { -5 } } }
      }
    \str_use:N \l__texdesk_label_str
  }
% Always a URI link (never hyperref's "other PDF" link), so viewers see the target as written.
\NewDocumentCommand \link { o m }
  {
    \str_set:Nn \l__texdesk_target_str {#2}
    \exp_args:NnV \hyper@linkurl
      { \IfNoValueTF {#1} { \__texdesk_stem:n {#2} } {#1} }
      \l__texdesk_target_str
  }
\ExplSyntaxOff
\endinput
`;

export interface MovedFileContext {
  /** Where the file was before the move, and where it is now (the same if it didn't move). */
  oldFile: string;
  newFile: string;
  /** Workspace files before and after the move (with search folders for `oldFile` / `newFile`). */
  before: ResolveContext;
  after: ResolveContext;
  /** New location of a path that moved, or null if it didn't. */
  moved(path: string): string | null;
}

/**
 * Rewrites links in `text` that a move broke: links to files that moved, and relative links
 * in a file that moved. A link that still points at the same file afterwards (a bare
 * `\link{name}`, or a path inside a folder that moved as a whole) is left exactly as written.
 */
export function rewriteLinks(text: string, m: MovedFileContext): { text: string; count: number } {
  const edits: { from: number; to: number; insert: string }[] = [];
  for (const ref of findLinks(text)) {
    if (ref.command === "href" || ref.command === "url" || isUrl(ref.target)) continue;
    const old = resolveLink(ref, m.oldFile, m.before);
    if (old?.kind !== "file") continue;
    const target = m.moved(old.path) ?? old.path;
    if (target === old.path && m.oldFile === m.newFile) continue;
    const now = resolveLink(ref, m.newFile, m.after);
    if (now?.kind === "file" && now.path === target) continue;
    edits.push({ from: ref.from, to: ref.to, insert: newTarget(ref, m.newFile, target) });
  }
  let out = text;
  for (const e of edits.reverse()) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return { text: out, count: edits.length };
}

/** The target text for `ref` after a move: relative to `fromFile`, keeping `.tex` and `#anchor` if they were written. */
function newTarget(ref: LinkRef, fromFile: string, target: string): string {
  const anchor = /#.*$/.exec(ref.target)?.[0] ?? "";
  let rel = linkTargetFor(fromFile, target);
  if (target.endsWith(".tex") && /\.tex(#|$)/.test(ref.target)) rel += ".tex";
  if (ref.command === "link") rel = rel.replace(/([%#])/g, "\\$1");
  return rel + anchor;
}
