// Fuzzy path matching for ⌘K. Each space-separated token must appear as a subsequence
// of the path (in any order); matches at segment starts and contiguous runs score higher.

const BOUNDARY = new Set(["/", "-", "_", ".", " "]);

function tokenScore(tok: string, path: string, baseStart: number): number | null {
  let best: number | null = null;
  for (let start = path.indexOf(tok[0]); start >= 0; start = path.indexOf(tok[0], start + 1)) {
    let score = 0, prev = -2, j = start, ok = true;
    for (const ch of tok) {
      while (j < path.length && path[j] !== ch) j++;
      if (j >= path.length) { ok = false; break; }
      score += 1;
      if (j === prev + 1) score += 3;
      else if (prev >= 0) score -= Math.min(3, (j - prev - 1) * 0.1);
      if (j === 0 || BOUNDARY.has(path[j - 1])) score += 4;
      if (j >= baseStart) score += 1;
      prev = j;
      j++;
    }
    if (!ok) break; // later starts can't succeed if this one ran out of text
    if (best === null || score > best) best = score;
  }
  return best;
}

/** Higher is better; `null` if some token doesn't match. */
export function fuzzyScore(query: string, path: string): number | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const p = path.toLowerCase();
  const baseStart = p.lastIndexOf("/") + 1;
  let total = 0;
  for (const t of tokens) {
    const s = tokenScore(t, p, baseStart);
    if (s === null) return null;
    total += s;
  }
  return total - p.length * 0.01;
}

export function fuzzyFilter<T>(query: string, items: T[], key: (t: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, key(item));
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
