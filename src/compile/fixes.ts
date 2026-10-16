// Exact fixes for common LaTeX errors, read straight off the error message, with no guessing.

/** A one-line fix; it only applies while the line is still as it was. */
export interface Fix {
  line: number;
  /** The line as it was when the fix was made. */
  original: string;
  replacement: string;
}

export interface RuleFix extends Fix {
  /** What was wrong, in plain words. */
  explanation: string;
}

/** Edit distance where swapping two neighbouring letters (alhpa → alpha) counts as one edit. */
const lev = (a: string, b: string): number => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
};

/** Where an unclosed argument most likely ends, in `rest` (the text after its {): before any trailing spaces. */
const argumentEnd = (rest: string) => {
  let end = rest.search(/\$|\\\)|\\\]|&|\\\\|\s+(and|or|where|so|with)\s|[,.;]\s|[,.;]?\s*$/);
  if (end < 0) end = rest.length;
  while (end > 0 && rest[end - 1] === " ") end--;
  return end;
};

/** Ranges of the line that are inside $…$ or \(…\) (math started on an earlier line isn't seen). */
function mathSpans(line: string): [number, number][] {
  const spans: [number, number][] = [];
  let open = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && (line[i + 1] === "(" || line[i + 1] === ")")) {
      if (line[i + 1] === "(") open = i; else if (open >= 0) { spans.push([open, i + 2]); open = -1; }
      i++;
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (c === "%") break;
    if (c === "$") { if (open < 0) open = i; else { spans.push([open, i + 1]); open = -1; } }
  }
  return spans;
}
const inMath = (spans: [number, number][], i: number) => spans.some(([a, b]) => a < i && i < b);

/** `\cmd` plus its {…} arguments, starting at `at` (the backslash). */
function commandWithArgs(line: string, at: number): number {
  let i = at + 1;
  while (i < line.length && /[A-Za-z]/.test(line[i])) i++;
  while (line[i] === "{") {
    let depth = 0;
    for (; i < line.length; i++) {
      if (line[i] === "{") depth++;
      else if (line[i] === "}" && --depth === 0) { i++; break; }
    }
  }
  return i;
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

/** Positions of the { on a line that aren't closed on it. */
function unclosedOpens(t: string): number[] {
  const open: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\") { i++; continue; }
    if (t[i] === "%") break;
    if (t[i] === "{") open.push(i);
    else if (t[i] === "}") open.pop();
  }
  return open;
}

/** Position of the first } on a line with no { before it, or -1. */
function unmatchedClose(t: string): number {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\") { i++; continue; }
    if (t[i] === "%") break;
    if (t[i] === "{") depth++;
    else if (t[i] === "}") { if (depth === 0) return i; depth--; }
  }
  return -1;
}

/** Positions of single $ on a line (not \$, not $$). */
function singleDollars(t: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\") { i++; continue; }
    if (t[i] === "%") break;
    if (t[i] === "$") { if (t[i + 1] === "$") { i++; continue; } out.push(i); }
  }
  return out;
}

const fix = (line: number, original: string, replacement: string, explanation: string): RuleFix | null =>
  replacement !== original ? { line, original, replacement, explanation } : null;

/**
 * A fix for the error `message` on line `n` (1-based) of `lines`, if it's one of the common
 * ones. `known` lists command names that exist (without backslashes); `hint` is the
 * diagnostic's hint (the undefined command, or the runaway text of a missing }).
 */
export function ruleFix(message: string, n: number, lines: string[], known: ReadonlySet<string>, hint?: string): RuleFix | null {
  const runaway = hint;
  const text = lines[n - 1];
  if (text === undefined) return null;

  // \begin{X} … \end{Y}: Y is a typo for X, or X was never closed before an outer \end{Y}.
  let m = /\\begin\{([^}]+)\} on input line (\d+) ended by \\end\{([^}]+)\}/.exec(message);
  if (m) {
    const [, want, beganAt, got] = m;
    const at = text.indexOf(`\\end{${got}}`);
    if (at >= 0) {
      const before = lines.slice(0, Math.max(0, +beganAt - 1)).join("\n");
      const outerOpen = count(before, `\\begin{${got}}`) > count(before, `\\end{${got}}`);
      if (outerOpen) {
        // Close X on its own line, just before the outer \end{Y}, indented like its \begin.
        const indent = /^\s*/.exec(lines[+beganAt - 1] ?? "")![0];
        return fix(n, text, `${indent}\\end{${want}}\n${text}`, `\\begin{${want}} (line ${beganAt}) is never closed: it needs an \\end{${want}} before \\end{${got}}.`);
      }
      return fix(n, text, text.slice(0, at) + `\\end{${want}}` + text.slice(at + got.length + 6), `\\begin{${want}} has to be closed by \\end{${want}}, not \\end{${got}}.`);
    }
  }

  // A stray }: "Extra }, or forgotten $".
  if (/Extra \}, or forgotten \$/.test(message)) {
    const at = unmatchedClose(text);
    if (at >= 0) return fix(n, text, text.slice(0, at) + text.slice(at + 1), "There's a } here without a matching {.");
  }

  // \left( with no \right): add the matching \right before the math ends.
  if (/Missing \\right\. inserted/.test(message)) {
    for (let k = n; k >= Math.max(1, n - 8); k--) {
      const t = lines[k - 1];
      const lefts = [...t.matchAll(/\\left\s*(\\\{|\\langle|\\lvert|\\lVert|\\\||[(\[|.])/g)];
      if (lefts.length <= count(t, "\\right")) continue;
      const open = lefts[lefts.length - 1];
      const close = { "(": ")", "[": "]", "\\{": "\\}", "\\langle": "\\rangle", "\\lvert": "\\rvert", "\\lVert": "\\rVert", "|": "|", "\\|": "\\|", ".": "." }[open[1]] ?? ".";
      const after = open.index! + open[0].length;
      const mathEnd = t.slice(after).search(/\$|\\\)|\\\]/);
      const pos = mathEnd < 0 ? t.trimEnd().length : after + mathEnd;
      const pad = t[pos - 1] === " " ? "" : " ";
      return fix(k, t, `${t.slice(0, pos)}${pad}\\right${close}${t.slice(pos)}`, `\\left${open[1]} needs a matching \\right${close}.`);
    }
  }

  // A \right with no \left: keep the bracket, drop the \right.
  if (/Extra \\right/.test(message)) {
    const r = /\\right\s*/.exec(text);
    if (r) return fix(n, text, text.slice(0, r.index) + text.slice(r.index + r[0].length), "This \\right has no \\left before it.");
  }

  // A misspelled command: the closest real one, if there's exactly one that close.
  if (/Undefined control sequence/.test(message)) {
    for (const c of text.matchAll(/\\([A-Za-z]+)/g)) {
      const name = c[1];
      // The log says which command it was (hint); otherwise, the first we don't know.
      if (hint ? name !== hint : known.has(name)) continue;
      const near = [...known].filter((k) => Math.abs(k.length - name.length) <= 2 && lev(k, name) <= (name.length > 4 ? 2 : 1));
      const best = near.sort((a, b) => lev(a, name) - lev(b, name));
      if (best.length && (best.length === 1 || lev(best[0], name) < lev(best[1], name))) {
        const at = c.index!;
        return fix(n, text, text.slice(0, at + 1) + best[0] + text.slice(at + 1 + name.length), `\\${name} isn't a LaTeX command — you probably meant \\${best[0]}.`);
      }
      return null; // an unknown command we can't place: leave it to the model
    }
  }

  // A missing } (TeX ran into the end of the file or paragraph looking for it).
  if (runaway && /File ended while scanning use of|Paragraph ended before/.test(message) && runaway.trim().startsWith("{")) {
    const start = runaway.replace(/\\([A-Za-z]+) /g, "\\$1").trim().slice(0, 12);
    const at = start.startsWith("{") ? text.indexOf(start) : -1;
    if (at >= 0) {
      // The argument most likely ends where the math, cell or line does.
      const pos = at + 1 + argumentEnd(text.slice(at + 1));
      const what = /use of \\(\w+)/.exec(message)?.[1];
      return fix(n, text, text.slice(0, pos) + "}" + text.slice(pos), `A { is never closed${what ? ` in the argument of \\${what}` : ""}: it needs a matching }.`);
    }
  }

  // A { never closed, on this line or one just above (TeX often notices a line or two later).
  if (/Missing \} inserted|File ended while scanning use of|Paragraph ended before/.test(message)) {
    for (let k = n; k >= Math.max(1, n - 8); k--) {
      const t = lines[k - 1];
      const open = unclosedOpens(t);
      if (!open.length) continue;
      const at = open[open.length - 1];
      const pos = at + 1 + argumentEnd(t.slice(at + 1));
      return fix(k, t, t.slice(0, pos) + "}" + t.slice(pos), `A { ${k === n ? "on this line" : `on line ${k}`} is never closed: it needs a matching }.`);
    }
  }

  // & in running text.
  if (/Misplaced alignment tab character &/.test(message)) {
    const spans = mathSpans(text);
    let out = "";
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\\") { out += text.slice(i, i + 2); i++; continue; }
      out += text[i] === "&" && !inMath(spans, i) ? "\\&" : text[i];
    }
    return fix(n, text, out, "& separates columns in tables and aligned equations; in text, write \\& for an ampersand.");
  }

  // A math-only command in text: \mathbb{R} → $\mathbb{R}$.
  m = /\\(\w+) allowed only in math mode/.exec(message);
  if (m) {
    const spans = mathSpans(text);
    const at = [...text.matchAll(new RegExp(`\\\\${m[1]}(?![A-Za-z])`, "g"))].map((x) => x.index!).find((i) => !inMath(spans, i));
    if (at !== undefined) {
      const end = commandWithArgs(text, at);
      return fix(n, text, `${text.slice(0, at)}$${text.slice(at, end)}$${text.slice(end)}`, `\\${m[1]} only works in math mode, so it goes inside $…$.`);
    }
  }

  // A $ that's never closed (TeX then complains about whatever comes next, in math mode).
  if (/Missing \$ inserted|invalid in math mode|Extra \}, or forgotten \$|Display math should end with/.test(message)) {
    for (let k = n; k >= Math.max(1, n - 8); k--) {
      const t = lines[k - 1];
      const dollars = singleDollars(t);
      if (dollars.length % 2 === 0) continue;
      // Close it after the formula: the math-looking words right after the open $.
      const open = dollars[dollars.length - 1];
      const words = [...t.slice(open + 1).matchAll(/\S+/g)];
      let end = open + 1;
      for (const w of words) {
        if (!/[\\^_=<>+\-*/()\d]|^[A-Za-z]$/.test(w[0])) break;
        end = open + 1 + w.index! + w[0].length;
      }
      while (/[.,;:]/.test(t[end - 1]) && end > open + 2) end--;
      if (end === open + 1) end = t.trimEnd().length;
      return fix(k, t, `${t.slice(0, end)}$${t.slice(end)}`, `The $ ${k === n ? "on this line" : `on line ${k}`} opens math that's never closed.`);
    }
  }

  // Math (x^2, y_1) typed outside $…$.
  if (/Missing \$ inserted/.test(message)) {
    const spans = mathSpans(text);
    const words = [...text.matchAll(/\S+/g)].map((w) => ({ s: w[0], from: w.index!, to: w.index! + w[0].length }));
    const mathy = (w: string) => /[\\^_=<>+]|^-$|^\d+[.,]?$|^[A-Za-z]$/.test(w);
    // The run of math-looking words around the first ^ or _ that's outside math.
    const k = words.findIndex((w) => /[\^_]/.test(w.s) && !inMath(spans, w.from + 1) && !/^\\/.test(w.s));
    if (k >= 0) {
      let a = k;
      let b = k;
      while (a > 0 && mathy(words[a - 1].s) && !/^\\item$/.test(words[a - 1].s) && !inMath(spans, words[a - 1].from)) a--;
      while (b + 1 < words.length && mathy(words[b + 1].s) && !inMath(spans, words[b + 1].from)) b++;
      // Keep sentence punctuation outside: "3." → $…3$.
      let to = words[b].to;
      while (/[.,;:]/.test(text[to - 1]) && to > words[a].from + 1) to--;
      const from = words[a].from;
      return fix(n, text, `${text.slice(0, from)}$${text.slice(from, to)}$${text.slice(to)}`, "^ and _ only work in math mode, so the formula goes inside $…$.");
    }
  }

  return null;
}
