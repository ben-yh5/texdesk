// The words worth spellchecking in a LaTeX document: prose only. Math, code, comments, the
// preamble, command names, and arguments that aren't prose (labels, file names, keys…) are
// left out.

import { CompiledConfig, Mode, compileConfig, initialState, modeOf, scanLine } from "../scanner/scanner";

export interface WordAt {
  word: string;
  from: number;
  to: number;
}

/** Commands whose `[options]` and first `{argument}` aren't prose. */
const NOT_PROSE = new Set([
  "label", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "cite", "citep", "citet", "nocite",
  "begin", "end", "usepackage", "RequirePackage", "documentclass", "input", "include", "includegraphics",
  "lstinputlisting", "url", "href", "bibliography", "bibliographystyle", "newcommand", "renewcommand",
  "providecommand", "DeclareMathOperator", "newenvironment", "renewenvironment", "newtheorem", "setlength",
  "addtolength", "hypersetup", "lstset", "setlist", "color", "textcolor", "colorbox", "definecolor",
  "vspace", "hspace", "pagestyle", "thispagestyle", "numberwithin", "setcounter", "addtocounter",
]);
/** Like NOT_PROSE, but `[…]` is a label to check (`\link[Problem set 2]{hw2}`). */
const TARGET_ONLY = new Set(["link"]);

const defaultCompiled = compileConfig();

/** Where `{…}` starting at `i` (after spaces) ends; `i` if there's no group. */
function skipGroup(line: string, i: number, open: string, close: string): number {
  let j = i;
  while (line[j] === " ") j++;
  if (line[j] !== open) return i;
  let depth = 0;
  for (; j < line.length; j++) {
    if (line[j] === "\\") { j++; continue; }
    if (line[j] === open) depth++;
    else if (line[j] === close && --depth === 0) return j + 1;
  }
  return line.length;
}

/** Prose words in `text`, with their offsets. */
export function proseWords(text: string, cc: CompiledConfig = defaultCompiled): WordAt[] {
  const lines = text.split("\n");
  // Only the body of a full document; a fragment (an \input file) is all body.
  const begin = lines.findIndex((l) => /^[^%]*\\begin\{document\}/.test(l));
  const out: WordAt[] = [];
  let state = initialState;
  let offset = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const steps: [number, Mode][] = [];
    const next = scanLine(state, line, -1, cc, (i, stack) => steps.push([i, modeOf(stack)]));
    if (n > begin) wordsInLine(textOnly(line, steps), offset, out);
    state = next;
    offset += line.length + 1;
  }
  return out;
}

/** `line` with everything outside text mode blanked out (offsets kept). */
function textOnly(line: string, steps: [number, Mode][]): string {
  let s = "";
  for (let k = 0; k < steps.length; k++) {
    const [from, mode] = steps[k];
    const to = k + 1 < steps.length ? steps[k + 1][0] : line.length;
    s += mode === "text" ? line.slice(from, to) : " ".repeat(Math.max(0, to - from));
  }
  return s.padEnd(line.length, " ");
}

function wordsInLine(line: string, offset: number, out: WordAt[]) {
  const re = /\\([A-Za-z@]+)\*?|\\.|%.*$|\p{L}+(?:['’]\p{L}+)*/gmu;
  for (let m; (m = re.exec(line)); ) {
    if (m[0][0] === "%") break;
    if (m[0][0] === "\\") {
      const name = m[1];
      if (name && (NOT_PROSE.has(name) || TARGET_ONLY.has(name))) {
        let i = re.lastIndex;
        if (!TARGET_ONLY.has(name)) i = skipGroup(line, i, "[", "]");
        else {
          // Check the label in [...], skip the target after it.
          const afterLabel = skipGroup(line, i, "[", "]");
          wordsInLine(" ".repeat(i) + line.slice(i, afterLabel) + " ".repeat(line.length - afterLabel), offset, out);
          i = afterLabel;
        }
        re.lastIndex = skipGroup(line, i, "{", "}");
      }
      continue;
    }
    const word = m[0];
    const before = line[m.index - 1] ?? "";
    const after = line[re.lastIndex] ?? "";
    // Not words: single letters, ACRONYMS and CamelCase, and bits of things like 2nd or x2.
    if (word.length < 2 || /\p{Lu}.*\p{Lu}/u.test(word) || /\d/.test(before) || /\d/.test(after)) continue;
    out.push({ word, from: offset + m.index, to: offset + re.lastIndex });
  }
}

/** Words to check, once each, minus the dictionary's (which match in any capitalization). */
export function wordsToCheck(words: WordAt[], dictionary: Set<string>): string[] {
  const known = new Set([...dictionary].map((w) => w.toLowerCase()));
  const seen = new Set<string>();
  for (const w of words) if (!known.has(w.word.toLowerCase())) seen.add(w.word);
  return [...seen];
}

/** Parses a dictionary file: one word per line; blank lines and `#` comments ignored. */
export function parseDictionary(text: string): Set<string> {
  return new Set(text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
}
