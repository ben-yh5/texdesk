// Search in files: plain-text matches across the workspace's .tex files. Case-insensitive
// unless the query has a capital letter (smart case).

export interface SearchFile {
  path: string;
  lines: string[];
}

export interface SearchHit {
  path: string;
  /** 1-based. */
  line: number;
  /** Column range of the match in the line. */
  from: number;
  to: number;
  text: string;
}

export const searchFile = (path: string, text: string): SearchFile => ({ path, lines: text.split(/\r?\n/) });

/** Every match, in file order then line order; at most `limit`. */
export function searchFiles(files: SearchFile[], query: string, limit = 500): SearchHit[] {
  if (!query) return [];
  const exact = query !== query.toLowerCase();
  const q = exact ? query : query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const f of files) {
    for (let i = 0; i < f.lines.length; i++) {
      const text = f.lines[i];
      const hay = exact ? text : text.toLowerCase();
      for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, at + q.length)) {
        hits.push({ path: f.path, line: i + 1, from: at, to: at + q.length, text });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

/** The line around a match, trimmed to about `width` characters; `from`/`to` shift with it. */
export function snippet(hit: SearchHit, width = 100): { text: string; from: number; to: number } {
  const indent = hit.text.length - hit.text.trimStart().length;
  let start = indent;
  let end = hit.text.trimEnd().length;
  if (end - start > width) {
    start = Math.max(start, Math.min(hit.from - Math.floor((width - (hit.to - hit.from)) / 3), end - width));
    end = Math.min(end, start + width);
  }
  const pre = start > indent ? "…" : "";
  const text = pre + hit.text.slice(start, end) + (end < hit.text.trimEnd().length ? "…" : "");
  return { text, from: hit.from - start + pre.length, to: Math.min(hit.to, end) - start + pre.length };
}
