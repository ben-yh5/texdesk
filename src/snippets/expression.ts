// `previousExpression()`: the LaTeX expression immediately before the cursor.

import type { Expression } from "./types";

/** Commands that act as operators/separators and therefore end an expression. */
const OPERATOR_COMMANDS = new Set([
  "cdot", "times", "div", "pm", "mp", "ast", "star", "circ", "bullet", "oplus", "otimes",
  "to", "gets", "mapsto", "implies", "impliedby", "iff", "Rightarrow", "Leftarrow", "rightarrow", "leftarrow",
  "le", "leq", "ge", "geq", "neq", "ne", "approx", "equiv", "sim", "simeq", "cong", "propto",
  "in", "notin", "ni", "subset", "subseteq", "supset", "supseteq", "cap", "cup", "setminus",
  "land", "lor", "wedge", "vee", "lnot", "neg",
  "quad", "qquad", "left", "right", "middle", "mid",
]);

const isAlnum = (c: string | undefined) =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9"));
const isLetter = (c: string | undefined) =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));

/** True if the char at `p` is preceded by an odd number of backslashes. */
function escaped(s: string, p: number): boolean {
  let n = 0;
  for (let q = p - 1; q >= 0 && s[q] === "\\"; q--) n++;
  return n % 2 === 1;
}

const OPEN_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Given a closing bracket at `k`, returns the index of its matching opener, or -1 if
 * there is none before a math boundary (`$`, `\(`, `\[`) or the start of `s`.
 */
function matchBackward(s: string, k: number): number {
  const stack: string[] = [OPEN_OF[s[k]]];
  for (let p = k - 1; p >= 0; p--) {
    const c = s[p];
    if (escaped(s, p)) {
      if (c === "(" || c === "[") return -1; // \( or \[ — start of the math region
      continue;
    }
    if (c === "$") return -1;
    if (c === ")" || c === "]" || c === "}") stack.push(OPEN_OF[c]);
    else if (c === "(" || c === "[" || c === "{") {
      if (stack[stack.length - 1] !== c) return -1;
      stack.pop();
      if (stack.length === 0) return p;
    }
  }
  return -1;
}

/** For `\right<delim>` ending at `end`, the start of its matching `\left`, or -1. */
function matchLeftRight(s: string, rightStart: number): number {
  let depth = 1;
  for (let p = rightStart - 1; p >= 0; p--) {
    if (s[p] !== "\\" || escaped(s, p)) continue;
    if (s.startsWith("\\right", p) && !isLetter(s[p + 6])) depth++;
    else if (s.startsWith("\\left", p) && !isLetter(s[p + 5])) {
      if (--depth === 0) return p;
    }
  }
  return -1;
}

/** Start index of the single unit ending at `i` (exclusive), or -1 if there is none. */
function unitBefore(s: string, i: number): number {
  if (i <= 0) return -1;
  const c = s[i - 1];

  if (c === "'") {
    let j = i - 1;
    while (j > 0 && s[j - 1] === "'") j--;
    return unitBefore(s, j);
  }

  if ((c === ")" || c === "]" || c === "}" || c === "." || c === "|") && !escaped(s, i - 1)) {
    // \right) … \left(  (also \right. and \right|)
    const rs = i - 1 - 6;
    if (rs >= 0 && s.startsWith("\\right", rs) && !escaped(s, rs)) return matchLeftRight(s, rs);
    if (c === "." || c === "|") return -1;
    return matchBackward(s, i - 1);
  }

  if (isAlnum(c)) {
    let j = i - 1;
    while (j > 0 && isAlnum(s[j - 1])) j--;
    if (j > 0 && s[j - 1] === "\\" && !escaped(s, j - 1) && isLetter(s[j])) {
      let k = j;
      while (k < i && isLetter(s[k])) k++;
      const name = s.slice(j, k);
      if (OPERATOR_COMMANDS.has(name)) return k < i ? k : -1;
      return j - 1;
    }
    return j;
  }

  return -1;
}

/**
 * The expression ending at the end of `before`. `base` is the document offset of
 * `before[0]`, used to build the returned range.
 */
export function previousExpression(before: string, base = 0): Expression | null {
  const end = before.length;
  let i = end;
  for (;;) {
    const u = unitBefore(before, i);
    if (u < 0) break;
    i = u;
    // Sub/superscripts attach to the unit before them.
    while (i > 0 && (before[i - 1] === "^" || before[i - 1] === "_") && !escaped(before, i - 1)) {
      const b = unitBefore(before, i - 1);
      if (b < 0) break;
      i = b;
    }
  }
  if (i === end) return null;
  const text = before.slice(i);
  return { text, unwrapped: unwrap(text), range: { from: base + i, to: base + end } };
}

function unwrap(text: string): string {
  if (text.startsWith("(") && text.endsWith(")") && matchBackward(text, text.length - 1) === 0) {
    return text.slice(1, -1);
  }
  const m = /^\\left\((.*)\\right\)$/s.exec(text);
  if (m && matchLeftRight(text, text.length - 7) === 0) return m[1];
  return text;
}
