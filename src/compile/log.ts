// Turning Tectonic output into diagnostics.
//
// Engine errors/warnings come on stderr as `error: file.tex:12: message`. LaTeX-level
// warnings ("Reference `x' undefined on input line 4") only appear in the .log file.

export interface BuildDiagnostic {
  /** File name as Tectonic reports it (relative to the source's folder), or null. */
  file: string | null;
  /** 1-based line, or null when unknown. */
  line: number | null;
  severity: "error" | "warning";
  message: string;
  /** For fixing it: the undefined command's name, or the runaway text of a missing }. */
  hint?: string;
}

const LOCATED = /^(error|warning): (.+?):(\d+): (.*)$/;
const GENERIC = [
  /^something bad happened inside/,
  /^the XeTeX engine had an unrecoverable error/,
  /^caused by:/,
  /^halted on potentially-recoverable error/,
  /^warnings were issued by the TeX engine/,
];
const LOG_WARNING = /^((?:LaTeX|Package \S+|Class \S+) Warning: )([\s\S]*?) on input line (\d+)\.$/;

export function parseDiagnostics(stderr: string, log = "", mainFile: string | null = null): BuildDiagnostic[] {
  const out: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: BuildDiagnostic) => {
    const k = `${d.severity}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(d);
  };

  for (const raw of stderr.split("\n")) {
    const line = raw.trimEnd();
    const m = LOCATED.exec(line);
    if (m) {
      push({ severity: m[1] as "error" | "warning", file: m[2], line: +m[3], message: m[4] });
      continue;
    }
    const g = /^(error|warning): (.*)$/.exec(line);
    if (g && !GENERIC.some((re) => re.test(g[2]))) push({ severity: g[1] as "error" | "warning", file: null, line: null, message: g[2] });
  }

  // LaTeX/package warnings from the log; they can wrap across lines, so join each
  // warning's continuation lines (indented, or until a blank line) first.
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^(LaTeX|Package \S+|Class \S+) Warning: /.test(lines[i])) continue;
    let text = lines[i];
    // Continuations are indented, or prefixed with "(package)" padding.
    while (i + 1 < lines.length && !/ on input line \d+\.$/.test(text) && /^(\s+\S|\([\w.-]+\)\s+\S)/.test(lines[i + 1])) {
      text += " " + lines[++i].replace(/^\([\w.-]+\)\s*/, "").trim();
    }
    const m = LOG_WARNING.exec(text.replace(/\s+/g, " "));
    if (m) push({ severity: "warning", file: mainFile, line: +m[3], message: m[2].trim() });
    else if (/There were undefined references|Label\(s\) may have changed/.test(text)) {
      push({ severity: "warning", file: null, line: null, message: text.replace(/^LaTeX Warning: /, "").trim() });
    }
  }
  return out;
}

/**
 * Line (1-based) of an error TeX couldn't place, like "File ended while scanning use of
 * \frac" from a missing }: the log shows the runaway text after "Runaway argument?", which
 * is found in the source. Null if there's no runaway text or it isn't found once.
 */
export function locateRunaway(log: string, source: string): number | null {
  const m = /Runaway (?:argument|definition|text)\?\n(.+)/.exec(log);
  if (!m) return null;
  // TeX prints "\end {x}" with a space after control words; the source has "\end{x}".
  const runaway = m[1].replace(/\\([A-Za-z]+) /g, "\\$1").trim();
  for (const len of [40, 24, 14, 8]) {
    const needle = runaway.slice(0, len);
    if (needle.length < Math.min(len, runaway.length) || needle.trim().length < 4) continue;
    const first = source.indexOf(needle);
    if (first < 0 || source.indexOf(needle, first + 1) >= 0) continue; // not found, or ambiguous
    return source.slice(0, first).split("\n").length;
  }
  return null;
}

/** The command an "Undefined control sequence" error on line `n` is about (the last one TeX read). */
export function undefinedCommand(log: string, n: number): string | null {
  const m = new RegExp(`! Undefined control sequence\\.[\\s\\S]*?\\nl\\.${n} (.*)`).exec(log);
  const names = m ? [...m[1].matchAll(/\\([A-Za-z]+)/g)] : [];
  return names.length ? names[names.length - 1][1] : null;
}

/** The text TeX printed after "Runaway argument?" (where an unclosed { started). */
export function runawayText(log: string): string | null {
  return /Runaway (?:argument|definition|text)\?\n(.+)/.exec(log)?.[1] ?? null;
}

/** A friendlier summary when a build fails without any located error. */
export function failureSummary(stderr: string): string {
  if (/relay\.fullyjustified|bundle|network|dns|resolve host|connection|timed out/i.test(stderr) && /fail|error/i.test(stderr)) {
    return "Tectonic couldn't download its package bundle — are you offline? The first build (and new packages) need internet.";
  }
  const first = stderr.split("\n").map((l) => l.replace(/^error: /, "").trim()).find((l) => l && !GENERIC.some((re) => re.test(l)));
  return first ?? "Build failed";
}

/** Paths from `\lstinputlisting[...]{path}` (and `\input{}`/`\include{}`) in a document. */
export function includedFiles(tex: string): string[] {
  const out = new Set<string>();
  for (const line of tex.split("\n")) {
    const code = line.replace(/(^|[^\\])%.*$/, "$1");
    for (const m of code.matchAll(/\\(lstinputlisting|inputminted\{[^}]*\}|input|include)\s*(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
      let p = m[2].trim();
      if ((m[1] === "input" || m[1] === "include") && !/\.\w+$/.test(p)) p += ".tex";
      out.add(p);
    }
  }
  return [...out];
}
