// Parser for snippet strings: `$0`, `$1`…, `${1:default}`, and `$$` for a literal `$`.
// A `$` not followed by a digit or `{` is a literal `$`. Backslashes are not special.

export interface ParsedStop {
  index: number;
  /** Offsets into `text`. Several ranges = mirrored field. */
  ranges: { from: number; to: number }[];
}

export interface ParsedSnippet {
  text: string;
  /** Tab stops in visiting order: 1, 2, …, then the exit ($0 or end of text) last. */
  stops: ParsedStop[];
  /** Whether the source had an explicit `$0`. */
  hasExit: boolean;
}

export interface InstantiateOptions {
  /** Prefix added after every newline (indentation of the line the snippet lands on). */
  indent?: string;
  /** Replacement for tab characters at the start of a line. */
  indentUnit?: string;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

export function parseSnippet(src: string, opts: InstantiateOptions = {}): ParsedSnippet {
  const indent = opts.indent ?? "";
  const unit = opts.indentUnit ?? "\t";
  let out = "";
  let atLineStart = false;
  const fields = new Map<number, { from: number; to: number }[]>();
  const add = (index: number, from: number, to: number) => {
    let list = fields.get(index);
    if (!list) fields.set(index, (list = []));
    list.push({ from, to });
  };

  // Emits literal text, applying indentation rules.
  const emit = (s: string) => {
    for (const ch of s) {
      if (ch === "\n") { out += "\n" + indent; atLineStart = true; continue; }
      if (ch === "\t" && atLineStart) { out += unit; continue; }
      atLineStart = false;
      out += ch;
    }
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c !== "$") { emit(c); i++; continue; }
    const n = src[i + 1];
    if (n === "$") { emit("$"); i += 2; continue; }
    if (isDigit(n)) {
      let j = i + 1;
      while (isDigit(src[j])) j++;
      const idx = +src.slice(i + 1, j);
      add(idx, out.length, out.length);
      atLineStart = false;
      i = j;
      continue;
    }
    if (n === "{" && isDigit(src[i + 2])) {
      let j = i + 2;
      while (isDigit(src[j])) j++;
      const idx = +src.slice(i + 2, j);
      if (src[j] === "}") { add(idx, out.length, out.length); atLineStart = false; i = j + 1; continue; }
      if (src[j] === ":") {
        // Default text runs to the matching close brace; `$$` is still an escaped `$`.
        let depth = 1, k = j + 1, def = "";
        while (k < src.length) {
          const ch = src[k];
          if (ch === "$" && src[k + 1] === "$") { def += "$"; k += 2; continue; }
          if (ch === "{") depth++;
          else if (ch === "}" && --depth === 0) break;
          def += ch;
          k++;
        }
        if (k < src.length) {
          const from = out.length;
          emit(def);
          add(idx, from, out.length);
          i = k + 1;
          continue;
        }
      }
    }
    emit("$");
    i++;
  }

  const stops: ParsedStop[] = [...fields.keys()]
    .filter((k) => k !== 0)
    .sort((a, b) => a - b)
    .map((index) => ({ index, ranges: fields.get(index)! }));
  const exit = fields.get(0);
  stops.push({ index: 0, ranges: exit ? [exit[0]] : [{ from: out.length, to: out.length }] });
  return { text: out, stops, hasExit: !!exit };
}
