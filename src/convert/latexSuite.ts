// LaTeX Suite (Obsidian plugin) → TeXdesk snippet file.
//
// Input: the plugin's data.json (its `snippets` field is JavaScript source, not JSON).
// Output: TypeScript for `.texdesk/snippets/`, plus a summary. The input is only read.
//
// Differences handled here:
// - Tab stops: LaTeX Suite visits $0 first; TeXdesk visits $1… and uses $0 as the exit.
//   LS $k becomes $(k+1) and the snippet exits at its end.
// - `[[n]]` (capture group n) becomes ctx.match[n+1]; `${VISUAL}` becomes ctx.selection.
// - Literal `$` is escaped as `$$` (TeXdesk's literal-dollar syntax).
// - Snippet variables (`${GREEK}`) become constants used in the regex triggers.
// - Markdown-only snippets: code fences become lstlisting blocks; callouts and other
//   Markdown are left as TODO comments. `c` (code block) mode snippets were for TikZ
//   blocks in Obsidian, so they fire inside a tikzpicture environment instead.
// - Optionally, `$…$` / `$$…$$` math delimiters become `\(…\)` / `\[…\]`.

export interface ConvertOptions {
  /** Rewrite `$…$` → `\(…\)` and `$$…$$` → `\[…\]` in replacements that are just math delimiters. Default true. */
  latexDelimiters?: boolean;
  /** Shown in the header. */
  sourcePath?: string;
  date?: Date;
  /** Module name (without .ts) for verbatim JavaScript function snippets. Default "imported-latex-suite-functions". */
  functionsModule?: string;
}

export interface ConvertResult {
  /** The main snippet file. */
  code: string;
  /** Companion file holding JavaScript function replacements verbatim (unchecked), if any. */
  functionsCode: string | null;
  summary: ConvertSummary;
}

export interface ConvertSummary {
  converted: number;
  todo: { trigger: string; reason: string }[];
  notes: string[];
}

interface LsSnippet {
  trigger: string | RegExp;
  replacement: string | ((...args: unknown[]) => unknown);
  options?: string;
  priority?: number;
  description?: string;
  flags?: string;
}

interface LsData {
  snippets?: string;
  snippetVariables?: string;
  autofractionEnabled?: boolean;
  autofractionSymbol?: string;
  autofractionBreakingChars?: string;
  autofractionExcludedEnvs?: string;
  matrixShortcutsEnabled?: boolean;
  matrixShortcutsEnvNames?: string;
  autoEnlargeBrackets?: boolean;
  autoEnlargeBracketsTriggers?: string;
  taboutEnabled?: boolean;
}

// ---- splitting the snippets source into top-level items -------------------------------

type Item = { kind: "comment"; text: string } | { kind: "snippet"; source: string };

/** Splits the `[ … ]` source into top-level elements and comments, respecting strings, regexes and nesting. */
export function splitSnippetSource(src: string): Item[] {
  const items: Item[] = [];
  let i = src.indexOf("[");
  if (i < 0) throw new Error("snippets source doesn't contain an array");
  i++;
  let depth = 0;
  let start = -1;
  let lastSignificant = "[";

  const skipString = (q: string) => {
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") i++;
      else if (q === "`" && src[i] === "$" && src[i + 1] === "{") { // template expression
        let d = 0;
        for (; i < src.length; i++) {
          if (src[i] === "{") d++;
          else if (src[i] === "}" && --d === 0) break;
        }
      }
      i++;
    }
  };
  const skipRegex = () => {
    i++;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
      i++;
    }
    i++;
    while (/[a-z]/.test(src[i] ?? "")) i++;
    i--;
  };

  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const text = src.slice(i + 2, end < 0 ? src.length : end).trim();
      if (depth === 0) items.push({ kind: "comment", text });
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (depth === 0) items.push({ kind: "comment", text: src.slice(i + 2, end).trim() });
      i = end + 1;
      continue;
    }
    if (/\s/.test(c)) continue;
    if (depth === 0 && start < 0 && c !== "," && c !== "]") start = i;
    if (c === '"' || c === "'" || c === "`") { skipString(c); lastSignificant = "x"; continue; }
    if (c === "/" && /[(,=:[!&|?{};]/.test(lastSignificant)) { skipRegex(); lastSignificant = "x"; continue; }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === ")" || (c === "]" && depth > 0)) depth--;
    else if (c === "]" && depth === 0) {
      if (start >= 0) items.push({ kind: "snippet", source: src.slice(start, i).trim().replace(/,\s*$/, "") });
      break;
    }
    if (c === "," && depth === 0) {
      if (start >= 0) items.push({ kind: "snippet", source: src.slice(start, i).trim() });
      start = -1;
    }
    lastSignificant = c;
  }
  return items;
}

// ---- replacements --------------------------------------------------------------------

type Tok =
  | { t: "lit"; v: string }
  | { t: "stop"; n: number; def?: string }
  | { t: "group"; n: number }
  | { t: "visual" };

/** Tokenizes LaTeX Suite replacement syntax. */
export function tokenize(repl: string): Tok[] {
  const out: Tok[] = [];
  const lit = (v: string) => {
    const last = out[out.length - 1];
    if (last?.t === "lit") last.v += v; else out.push({ t: "lit", v });
  };
  let i = 0;
  while (i < repl.length) {
    if (repl.startsWith("${VISUAL}", i)) { out.push({ t: "visual" }); i += 9; continue; }
    const g = /^\[\[(\d+)\]\]/.exec(repl.slice(i));
    if (g) { out.push({ t: "group", n: +g[1] }); i += g[0].length; continue; }
    if (repl[i] === "$") {
      const d = /^\$(\d+)/.exec(repl.slice(i));
      if (d) { out.push({ t: "stop", n: +d[1] }); i += d[0].length; continue; }
      const m = /^\$\{(\d+):/.exec(repl.slice(i));
      if (m) {
        let depth = 1, j = i + m[0].length;
        for (; j < repl.length; j++) {
          if (repl[j] === "{") depth++;
          else if (repl[j] === "}" && --depth === 0) break;
        }
        out.push({ t: "stop", n: +m[1], def: repl.slice(i + m[0].length, j) });
        i = j + 1;
        continue;
      }
      const b = /^\$\{(\d+)\}/.exec(repl.slice(i));
      if (b) { out.push({ t: "stop", n: +b[1] }); i += b[0].length; continue; }
    }
    lit(repl[i]);
    i++;
  }
  return out;
}

const escLit = (s: string) => s.replace(/\$/g, "$$$$");

/** `$…$` / `$$…$$` around nothing but tab stops → `\(…\)` / `\[…\]`. */
function latexDelims(toks: Tok[]): Tok[] | null {
  if (toks.length < 3) return null;
  const first = toks[0], last = toks[toks.length - 1];
  if (first.t !== "lit" || last.t !== "lit") return null;
  const mid = toks.slice(1, -1);
  if (!mid.every((t) => t.t === "stop" || (t.t === "lit" && !t.v.includes("$")))) return null;
  if (first.v === "$" && last.v === "$") return [{ t: "lit", v: "\\(" }, ...mid, { t: "lit", v: "\\)" }];
  if (first.v === "$$" && last.v === "$$") return [{ t: "lit", v: "\\[\n\t" }, ...mid, { t: "lit", v: "\n\\]" }];
  return null;
}

/** A TS expression for the replacement: a string literal, or a `(ctx) => …` function. */
function emitReplacement(toks: Tok[]): string {
  const dynamic = toks.some((t) => t.t === "group" || t.t === "visual");
  const parts: string[] = [];
  let buf = "";
  const flush = () => { if (buf) parts.push(JSON.stringify(buf)); buf = ""; };
  for (const t of toks) {
    if (t.t === "lit") buf += escLit(t.v);
    else if (t.t === "stop") buf += t.def !== undefined ? `\${${t.n + 1}:${escLit(t.def)}}` : `$${t.n + 1}`;
    else if (t.t === "group") { flush(); parts.push(`lit(ctx.match![${t.n + 1}])`); }
    else { flush(); parts.push("lit(ctx.selection)"); }
  }
  flush();
  if (!dynamic) return parts[0] ?? '""';
  return `(ctx) => ${parts.join(" + ")}`;
}

// ---- triggers & options --------------------------------------------------------------

const VAR = /\$\{([A-Z_]+)\}/g;

function emitRegex(source: string, flags: string, vars: Map<string, string>): string {
  if (VAR.test(source)) {
    VAR.lastIndex = 0;
    const pieces: string[] = [];
    let last = 0;
    for (let m; (m = VAR.exec(source)); ) {
      if (m.index > last) pieces.push(JSON.stringify(source.slice(last, m.index)));
      pieces.push(vars.has(m[1]) ? m[1] : JSON.stringify(m[0]));
      last = m.index + m[0].length;
    }
    if (last < source.length) pieces.push(JSON.stringify(source.slice(last)));
    VAR.lastIndex = 0;
    return `new RegExp(${pieces.join(" + ")}${flags ? `, ${JSON.stringify(flags)}` : ""})`;
  }
  const re = new RegExp(source, flags); // validates; .source escapes "/"
  return `/${re.source}/${flags}`;
}

const MODES: Record<string, string> = { t: "text", m: "math", M: "display", n: "inline", c: "code" };

const LANGS: Record<string, string> = { python: "Python", py: "Python", java: "Java", c: "C", cpp: "C++", "c++": "C++", sql: "SQL", bash: "bash", sh: "bash", r: "R", haskell: "Haskell", matlab: "Matlab", ruby: "Ruby", html: "HTML", xml: "XML" };

// ---- main ----------------------------------------------------------------------------

export function convertLatexSuite(dataJson: string, opts: ConvertOptions = {}): ConvertResult {
  const data = JSON.parse(dataJson) as LsData;
  if (typeof data.snippets !== "string") throw new Error("this data.json has no `snippets` field — is it LaTeX Suite's?");
  const latexDelimiters = opts.latexDelimiters ?? true;
  const summary: ConvertSummary = { converted: 0, todo: [], notes: [] };

  // Snippet variables: `{"${GREEK}": "alpha|beta"}` (JSON-ish, may have trailing commas).
  const vars = new Map<string, string>();
  if (data.snippetVariables) {
    const obj = new Function(`return (${data.snippetVariables});`)() as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) {
      const m = /^\$\{([A-Z_]+)\}$/.exec(k);
      if (m && typeof v === "string") vars.set(m[1], v);
    }
  }

  const body: string[] = [];
  const todo = (source: string, trigger: string, reason: string) => {
    summary.todo.push({ trigger, reason });
    body.push(`  // TODO(latex-suite): ${reason}`);
    for (const l of source.split("\n")) body.push(`  // ${l.trimEnd()}`);
  };
  const functions: string[] = [];
  const fnModule = opts.functionsModule ?? "imported-latex-suite-functions";
  let usedTikzGuard = false;
  let rewroteDelims = false;
  let translatedFences = false;

  for (const item of splitSnippetSource(data.snippets)) {
    if (item.kind === "comment") {
      body.push(item.text ? `  // ${item.text}` : "");
      continue;
    }
    let sn: LsSnippet;
    try {
      sn = new Function(`return (${item.source});`)() as LsSnippet;
    } catch (err) {
      todo(item.source, "?", `couldn't evaluate this entry (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const triggerText = typeof sn.trigger === "string" ? sn.trigger : String(sn.trigger);
    if (!sn || (typeof sn.trigger !== "string" && !(sn.trigger instanceof RegExp)) || sn.replacement === undefined) {
      todo(item.source, triggerText, "missing trigger or replacement");
      continue;
    }
    const optStr = sn.options ?? "";
    const isRegex = sn.trigger instanceof RegExp || optStr.includes("r");

    // Options
    const modes = [...optStr].filter((c) => c in MODES).map((c) => MODES[c]);
    const tikz = modes.includes("code");
    const o: string[] = [];
    const modeList = tikz ? modes.filter((m) => m !== "code").concat("text") : modes;
    const uniq = [...new Set(modeList)];
    if (uniq.length === 1) o.push(`mode: ${JSON.stringify(uniq[0])}`);
    else if (uniq.length > 1) o.push(`mode: ${JSON.stringify(uniq)}`);
    if (optStr.includes("A")) o.push("auto: true");
    if (optStr.includes("w")) o.push("wordBoundary: true");
    if (sn.priority) o.push(`priority: ${sn.priority}`);
    if (sn.description) o.push(`description: ${JSON.stringify(sn.description)}`);

    // Trigger
    let trig: string;
    try {
      if (sn.trigger instanceof RegExp) trig = emitRegex(sn.trigger.source, sn.trigger.flags.replace(/[gy]/g, ""), vars);
      else if (isRegex) trig = emitRegex(sn.trigger, (sn.flags ?? "").replace(/[gy]/g, ""), vars);
      else trig = JSON.stringify(sn.trigger);
    } catch (err) {
      todo(item.source, triggerText, `invalid regex (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    // Replacement
    let repl: string;
    let visual = false;
    if (typeof sn.replacement === "function") {
      const name = `fn${functions.length + 1}`;
      const label = sn.description ? `${triggerText}: ${sn.description}` : triggerText;
      functions.push(`// ${label.replace(/\n/g, " ")}\nexport const ${name} = ${sn.replacement.toString()};`);
      const arg = isRegex ? "ctx.match" : "ctx.before.slice(ctx.triggerRange.from - ctx.cursor)";
      repl = `(ctx) => fromLatexSuite(js.${name}(${arg}))`;
      if (optStr.includes("v")) visual = true;
    } else if (typeof sn.replacement === "string") {
      let r = sn.replacement;
      if (/^>\s*\[!/.test(r)) { todo(item.source, triggerText, "Obsidian callout — no LaTeX equivalent"); continue; }
      if (r.startsWith("```")) {
        const m = /^```([^\n]*)\n([\s\S]*)\n```$/.exec(r);
        if (!m || /\\begin\{document\}/.test(m[2])) { todo(item.source, triggerText, "Markdown code fence (e.g. tikz) — no direct LaTeX equivalent"); continue; }
        const lang = m[1].trim();
        r = `\\begin{lstlisting}${lang ? `[language=${LANGS[lang.toLowerCase()] ?? lang}]` : ""}\n${m[2]}\n\\end{lstlisting}`;
        translatedFences = true;
      }
      let toks = tokenize(r);
      visual = toks.some((t) => t.t === "visual") || optStr.includes("v");
      if (latexDelimiters) {
        const d = latexDelims(toks);
        if (d) { toks = d; rewroteDelims = true; }
      }
      repl = emitReplacement(toks);
    } else {
      todo(item.source, triggerText, "replacement is neither a string nor a function");
      continue;
    }
    if (visual) {
      if (typeof sn.trigger !== "string" || isRegex) { todo(item.source, triggerText, "visual snippet with a regex trigger isn't supported"); continue; }
      o.push("visual: true");
      // In LaTeX Suite, visual snippets fire as soon as the key is typed over a selection.
      const ai = o.indexOf("auto: true");
      if (ai >= 0) o.splice(ai, 1);
    }
    if (tikz) {
      usedTikzGuard = true;
      const inner = repl.startsWith("(ctx) =>") ? `(${repl})(ctx)` : repl;
      repl = `(ctx) => (inTikz(ctx) ? ${inner} : false)`;
    }

    body.push(`  s(${trig}, ${repl}${o.length ? `, { ${o.join(", ")} }` : ""}),`);
    summary.converted++;
  }

  // Built-in features that were enabled in LaTeX Suite's settings.
  const extra: string[] = [];
  const keys: string[] = [];
  if (data.autofractionEnabled) {
    let excluded: [string, string][] = [];
    try { excluded = data.autofractionExcludedEnvs ? (new Function(`return (${data.autofractionExcludedEnvs});`)() as [string, string][]) : []; } catch { /* ignore */ }
    const sym = data.autofractionSymbol || "\\frac";
    extra.push(
      `  // Auto-fraction (LaTeX Suite setting): "x/" → ${sym}{x}{…}.`,
      `  s("/", (ctx) => {`,
      ...(excluded.length ? [`    if (insideAny(ctx.before, ${JSON.stringify(excluded)})) return false;`] : []),
      `    const num = ctx.previousExpression();`,
      `    if (!num) return false;`,
      `    return ctx.replace(num.range, ${JSON.stringify(escLit(sym) + "{")} + lit(num.unwrapped) + "}{$1}$0");`,
      `  }, { mode: "math", auto: true, description: "auto-fraction" }),`,
    );
    summary.converted++;
  }
  if (data.matrixShortcutsEnabled) {
    const envs = (data.matrixShortcutsEnvNames ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const re = `/^(${envs.map((e) => e.replace(/[*]/g, "\\*")).join("|")})$/`;
    keys.push(
      `// Matrix shortcuts (LaTeX Suite setting): in ${envs.join(", ")}:`,
      `// Tab → " & ", Enter → " \\\\" + newline, Shift+Enter → jump past \\end{…}.`,
      `const MATRIX_ENVS = ${re};`,
      `export const keys = [`,
      `  key("Tab", { mode: "math", env: MATRIX_ENVS }, (ctx) => ctx.insert(" & ")),`,
      `  key("Enter", { mode: "math", env: MATRIX_ENVS }, (ctx) => ctx.insert(" \\\\\\\\\\n")),`,
      `  key("Shift-Enter", { mode: "math", env: MATRIX_ENVS }, (ctx) => {`,
      `    const end = "\\\\end{" + ctx.env + "}";`,
      `    const at = ctx.doc.slice(ctx.cursor).indexOf(end);`,
      `    if (at < 0) return false;`,
      `    const p = ctx.cursor + at + end.length;`,
      `    return ctx.replace({ from: p, to: p }, "$0");`,
      `  }),`,
      `];`,
    );
  }
  if (data.autoEnlargeBrackets) {
    summary.notes.push(`"Auto-enlarge brackets" (\\left/\\right around ${data.autoEnlargeBracketsTriggers}) wasn't converted — it's a built-in LaTeX Suite feature with no snippet equivalent yet.`);
  }
  if (data.taboutEnabled) summary.notes.push("Tabout is built into TeXdesk.");
  if (rewroteDelims) summary.notes.push("Snippets that inserted $…$ / $$…$$ now insert \\(…\\) / \\[…\\].");
  if (translatedFences) summary.notes.push("Markdown code-fence snippets now insert lstlisting blocks.");
  if (usedTikzGuard) summary.notes.push("Code-block (c) snippets now fire inside a tikzpicture environment.");

  const helpers: string[] = [
    `/** Escapes text so it's inserted literally (TeXdesk reads $1 etc. as tab stops). */`,
    `const lit = (t: string | undefined) => (t ?? "").replace(/\\$/g, "$$$$");`,
  ];
  if (body.some((l) => l.includes("fromLatexSuite("))) {
    helpers.push(
      ``,
      `/** Converts a LaTeX Suite snippet string ($0 first) to TeXdesk syntax ($1 first, $0 = exit). */`,
      `function fromLatexSuite(r: unknown): string | false {`,
      `  if (typeof r !== "string") return false;`,
      `  return r.replace(/\\$\\{(\\d+)(:|\\})|\\$(\\d+)|\\$/g, (m, a, sep, b) =>`,
      `    a !== undefined ? "\${" + (+a + 1) + sep : b !== undefined ? "$" + (+b + 1) : "$$");`,
      `}`,
    );
  }
  if (usedTikzGuard) helpers.push(``, `const inTikz = (ctx: Context) => ctx.envStack.includes("tikzpicture");`);
  if (extra.some((l) => l.includes("insideAny("))) {
    helpers.push(
      ``,
      `/** Whether the text before the cursor is inside one of the [open, close] pairs (e.g. "^{", "}"). */`,
      `function insideAny(before: string, pairs: [string, string][]): boolean {`,
      `  return pairs.some(([open, close]) => {`,
      `    const at = before.lastIndexOf(open);`,
      `    if (at < 0) return false;`,
      `    let depth = 1;`,
      `    for (const ch of before.slice(at + open.length)) {`,
      `      if (open.endsWith("{") && ch === "{") depth++;`,
      `      else if (ch === close[0] && --depth === 0) return false;`,
      `    }`,
      `    return true;`,
      `  });`,
      `}`,
    );
  }
  const usedVars = [...vars.keys()].filter((k) => body.some((l) => new RegExp(`\\b${k}\\b`).test(l)));

  const date = (opts.date ?? new Date()).toISOString().slice(0, 10);
  const header = [
    `// Converted from LaTeX Suite by TeXdesk on ${date}.`,
    ...(opts.sourcePath ? [`// Source (read only): ${opts.sourcePath}`] : []),
    `// ${summary.converted} snippets converted${summary.todo.length ? `; ${summary.todo.length} left as TODO comments (search for "TODO(latex-suite)")` : ""}.`,
    ...summary.notes.map((n) => `// - ${n}`),
    `// This file is yours now: edit, split, or delete it freely.`,
    ``,
    `import { snippets, s${keys.length ? ", key" : ""}${usedTikzGuard ? ", type Context" : ""} } from "texdesk";`,
    ...(functions.length ? [`import * as js from "./${fnModule}";`] : []),
    ``,
    ...helpers,
    ...(usedVars.length ? [``, `// Snippet variables`, ...usedVars.map((k) => `const ${k} = ${JSON.stringify(vars.get(k))};`)] : []),
    ``,
  ];
  const code = [
    ...header,
    `export default snippets([`,
    ...trimBlankRuns(body),
    ...(extra.length ? [``, `  // ---- From your LaTeX Suite settings ----`, ...extra] : []),
    `]);`,
    ...(keys.length ? [``, ...keys] : []),
    ``,
  ].join("\n");
  const functionsCode = functions.length
    ? [
        `// @ts-nocheck`,
        `// JavaScript snippet functions copied verbatim from LaTeX Suite (used by the converted snippet file).`,
        `// They run as-is; TypeScript doesn't check this file. Return values use LaTeX Suite syntax ($0 first).`,
        ``,
        functions.join("\n\n"),
        ``,
      ].join("\n")
    : null;
  return { code, functionsCode, summary };
}

function trimBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) if (!(l === "" && (out.length === 0 || out[out.length - 1] === ""))) out.push(l);
  while (out[out.length - 1] === "") out.pop();
  return out;
}
