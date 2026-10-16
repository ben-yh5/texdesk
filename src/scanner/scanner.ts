// Math-context scanner for LaTeX.
//
// The scanner walks a document line by line, carrying a small immutable state
// (a stack of frames) across lines. Callers cache the state at the start of
// each line so that a keystroke only rescans from the edited line onward, and
// a position query only scans from its line start to the column.

export type Mode = "text" | "inline" | "display" | "code";

export interface ScannerConfig {
  /** Environments whose body is display math. Starred forms are added automatically. */
  displayEnvs: string[];
  /** Environments whose body is inline math. */
  inlineEnvs: string[];
  /** Environments whose body is verbatim code. */
  codeEnvs: string[];
  /** Commands whose brace argument is text mode when used inside math. */
  textCommands: string[];
  /** Commands that take a verbatim argument delimited by any char (or braces). */
  verbCommands: string[];
}

export const defaultScannerConfig: ScannerConfig = {
  displayEnvs: ["equation", "align", "gather", "multline", "flalign", "alignat", "eqnarray", "displaymath"],
  inlineEnvs: ["math"],
  codeEnvs: ["lstlisting", "verbatim", "Verbatim", "minted"],
  textCommands: ["text", "textrm", "textbf", "textit", "textsf", "texttt", "textnormal", "mbox", "intertext", "shortintertext"],
  verbCommands: ["verb", "lstinline"],
};

type EnvRole = "display" | "inline" | "code" | "inherit";

export type Frame =
  | { readonly k: "env"; readonly name: string; readonly role: EnvRole }
  | { readonly k: "delim"; readonly open: "$" | "$$" | "\\(" | "\\[" }
  | { readonly k: "textarg"; readonly depth: number }
  | { readonly k: "verb"; readonly close: string };

/** Scanner state: a stack of frames, innermost last. Treated as immutable. */
export type ScanState = readonly Frame[];

export const initialState: ScanState = [];

export interface CompiledConfig {
  roles: Map<string, EnvRole>;
  textCommands: Set<string>;
  verbCommands: Set<string>;
}

export function compileConfig(cfg: ScannerConfig = defaultScannerConfig): CompiledConfig {
  const roles = new Map<string, EnvRole>();
  for (const e of cfg.displayEnvs) { roles.set(e, "display"); roles.set(e + "*", "display"); }
  for (const e of cfg.inlineEnvs) roles.set(e, "inline");
  for (const e of cfg.codeEnvs) roles.set(e, "code");
  return { roles, textCommands: new Set(cfg.textCommands), verbCommands: new Set(cfg.verbCommands) };
}

const defaultCompiled = compileConfig();

export function modeOf(state: ScanState): Mode {
  for (let i = state.length - 1; i >= 0; i--) {
    const f = state[i];
    switch (f.k) {
      case "verb": return "code";
      case "textarg": return "text";
      case "delim": return f.open === "$" || f.open === "\\(" ? "inline" : "display";
      case "env":
        if (f.role === "inherit") continue;
        return f.role;
    }
  }
  return "text";
}

export function envStackOf(state: ScanState): string[] {
  const out: string[] = [];
  for (const f of state) if (f.k === "env") out.push(f.name);
  return out;
}

export function statesEqual(a: ScanState, b: ScanState): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x.k !== y.k) return false;
    switch (x.k) {
      case "env": if (x.name !== (y as typeof x).name) return false; break;
      case "delim": if (x.open !== (y as typeof x).open) return false; break;
      case "textarg": if (x.depth !== (y as typeof x).depth) return false; break;
      case "verb": if (x.close !== (y as typeof x).close) return false; break;
    }
  }
  return true;
}

const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

/** Reads `{name}` starting at `i` (allowing spaces before the brace). Returns [name, indexAfter] or null. */
function readBraceName(line: string, i: number): [string, number] | null {
  while (line[i] === " ") i++;
  if (line[i] !== "{") return null;
  const close = line.indexOf("}", i + 1);
  if (close < 0) return null;
  return [line.slice(i + 1, close), close + 1];
}

/**
 * Scans `line` from column 0 to `end` (default: whole line), starting from `state`.
 * When `end` is the full line length, the returned state is the state at the start
 * of the next line (end-of-line rules applied); otherwise it's the state at `end`.
 */
/**
 * `onStep(i, stack)` (optional) is called before each token at column `i`, and once more at
 * the end of the scanned range, with the frame stack at that point (don't keep a reference).
 */
export function scanLine(
  state: ScanState, line: string, end = -1, cc: CompiledConfig = defaultCompiled,
  onStep?: (i: number, stack: readonly Frame[]) => void,
): ScanState {
  const full = end < 0;
  // A partial scan must not look ahead past `end` (e.g. into the rest of `\begin{…}`).
  if (!full) line = line.slice(0, end);
  const stop = line.length;
  const st = state.slice() as Frame[];
  const top = () => st[st.length - 1];
  const mathy = () => { const m = modeOf(st); return m === "inline" || m === "display"; };

  let i = 0;
  outer: while (i < stop) {
    onStep?.(i, st);
    const t = top();

    // Verbatim code environment: only look for the matching \end{name}.
    if (t && t.k === "env" && t.role === "code") {
      const needle = "\\end{" + t.name + "}";
      const at = line.indexOf(needle, i);
      if (at < 0 || at >= stop) { i = stop; break; }
      st.pop();
      i = at + needle.length;
      continue;
    }

    // Inline verbatim: look for the closing delimiter.
    if (t && t.k === "verb") {
      const at = line.indexOf(t.close, i);
      if (at < 0 || at >= stop) { i = stop; break; }
      st.pop();
      i = at + 1;
      continue;
    }

    const c = line[i];
    switch (c) {
      case "%":
        break outer;

      case "\\": {
        const n = line[i + 1];
        if (n === undefined) { i++; continue; }
        if (!isLetter(n)) {
          const m = modeOf(st);
          if (n === "(" && m === "text") st.push({ k: "delim", open: "\\(" });
          else if (n === "[" && m === "text") st.push({ k: "delim", open: "\\[" });
          else if (n === ")" && t?.k === "delim" && t.open === "\\(") st.pop();
          else if (n === "]" && t?.k === "delim" && t.open === "\\[") st.pop();
          i += 2; // covers \\, \$, \%, \{, \} and other control symbols
          continue;
        }
        let j = i + 1;
        while (j < line.length && isLetter(line[j])) j++;
        const name = line.slice(i + 1, j);
        i = j;

        if (name === "begin") {
          const r = readBraceName(line, i);
          if (!r) continue;
          const [env, after] = r;
          st.push({ k: "env", name: env, role: cc.roles.get(env) ?? "inherit" });
          i = after;
        } else if (name === "end") {
          const r = readBraceName(line, i);
          if (!r) continue;
          const [env, after] = r;
          for (let k = st.length - 1; k >= 0; k--) {
            const f = st[k];
            if (f.k === "env" && f.name === env) { st.length = k; break; }
          }
          i = after;
        } else if (cc.verbCommands.has(name)) {
          if (line[i] === "*") i++;
          const d = line[i];
          if (d === undefined || d === " ") continue;
          st.push({ k: "verb", close: d === "{" ? "}" : d });
          i++;
        } else if (cc.textCommands.has(name) && mathy()) {
          let j2 = i;
          while (line[j2] === " ") j2++;
          if (line[j2] === "{") { st.push({ k: "textarg", depth: 1 }); i = j2 + 1; }
        }
        continue;
      }

      case "$": {
        const m = modeOf(st);
        if (t?.k === "delim" && t.open === "$") { st.pop(); i++; continue; }
        if (line[i + 1] === "$") {
          if (t?.k === "delim" && t.open === "$$") st.pop();
          else if (m === "text") st.push({ k: "delim", open: "$$" });
          i += 2;
          continue;
        }
        if (m === "text") st.push({ k: "delim", open: "$" });
        i++;
        continue;
      }

      case "{":
        if (t?.k === "textarg") st[st.length - 1] = { k: "textarg", depth: t.depth + 1 };
        i++;
        continue;

      case "}":
        if (t?.k === "textarg") {
          if (t.depth <= 1) st.pop();
          else st[st.length - 1] = { k: "textarg", depth: t.depth - 1 };
        }
        i++;
        continue;

      default:
        i++;
    }
  }

  onStep?.(Math.min(i, stop), st);

  if (full) {
    // Inline verbatim never spans lines.
    while (top()?.k === "verb") st.pop();
    // A blank line is a paragraph break, which TeX forbids inside delimited math or
    // brace arguments. Recover from unclosed delimiters so one typo doesn't turn the
    // rest of the document into math. Environments are kept.
    if (line.trim() === "") {
      while (st.length) {
        const f = top()!;
        if (f.k === "delim" || f.k === "textarg") st.pop();
        else break;
      }
    }
  }

  return st.length === state.length && statesEqual(st, state) ? state : st;
}

/** Scans a whole document, returning the state at the start of every line. */
export function scanDocument(lines: readonly string[], cc: CompiledConfig = defaultCompiled): ScanState[] {
  const out: ScanState[] = new Array(lines.length);
  let s = initialState;
  for (let i = 0; i < lines.length; i++) {
    out[i] = s;
    s = scanLine(s, lines[i], -1, cc);
  }
  return out;
}

/** State at a column, given the state at its line start. */
export function stateAt(lineStart: ScanState, line: string, col: number, cc: CompiledConfig = defaultCompiled): ScanState {
  return scanLine(lineStart, line, col, cc);
}
