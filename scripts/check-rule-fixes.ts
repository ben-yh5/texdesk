// Builds broken documents with the real Tectonic and runs the built-in fixes on the errors,
// then rebuilds the fixed document: npx tsx scripts/check-rule-fixes.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { locateRunaway, parseDiagnostics, runawayText, undefinedCommand } from "../src/compile/log";
import { ruleFix } from "../src/compile/fixes";
import { knownCommandNames } from "../src/editor/commands";

const pre = "\\documentclass{article}\n\\usepackage{amsmath, amssymb}\n\\begin{document}\n\\begin{enumerate}\n";
const post = "\\end{enumerate}\n\\end{document}\n";
const cases: Record<string, string> = {
  "missing } in \\frac": "  \\item Let $x = \\frac{1}{2$ and $y = 3$.\n",
  "typo \\alhpa": "  \\item Suppose $\\alhpa > 0$.\n",
  "math outside $": "  \\item We have x^2 + y_1 = 3 here.\n",
  "\\end mismatch": "  \\item \\begin{align*}\n    x &= 1 \\\\\n    y &= 2\n  \\end{align}\n",
  "unescaped &": "  \\item Smith & Jones showed $a = b$.\n",
  "\\mathbb outside math": "  \\item The set \\mathbb{R} of reals.\n",
  "typo \\textbg": "  \\item This is \\textbg{important}.\n",
  "missing } in \\sqrt": "  \\item Then $\\sqrt{x + 1 = 2$.\n",
  "missing } in \\textbf": "  \\item This is \\textbf{very important.\n",
  "missing } in \\section": "  \\item \\textit{Note: read this.\n\n  More text here.\n",
  "extra }": "  \\item Let $x = 1}$ be given.\n",
  "missing { in \\frac": "  \\item Let $x = \\frac{1}2}$ be given.\n",
  "missing } in align": "  \\item \\begin{align*}\n    x &= \\frac{a}{b \\\\\n    y &= 2\n  \\end{align*}\n",
  "missing } multi-line display": "  \\item \\[\n    \\sum_{i=1}^{n i\n  \\]\n",
  "unclosed itemize": "  \\item a\n  \\begin{itemize}\n    \\item b\n",
  "\\left( without \\right": "  \\item $\\left( \\frac{a}{b} = c$\n",
  "extra \\right)": "  \\item $\\frac{a}{b} \\right) = c$\n",
  "unclosed $": "  \\item Let $x + 1 be given.\n",
  "missing } in subscript": "  \\item $x_{i + 1 = 2$\n",
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "texdesk-rules-"));
const build = (doc: string) => {
  const file = path.join(dir, "hw.tex");
  fs.writeFileSync(file, doc);
  const r = spawnSync("tectonic", ["--keep-logs", "--outdir", dir, file], { cwd: dir, encoding: "utf8" });
  let log = "";
  try { log = fs.readFileSync(path.join(dir, "hw.log"), "utf8"); } catch { /* none */ }
  const diags = parseDiagnostics(r.stderr, log, "hw.tex");
  const unplaced = diags.find((d) => d.severity === "error");
  if (unplaced && !diags.some((d) => d.severity === "error" && d.line)) { unplaced.line = locateRunaway(log, doc); unplaced.hint = runawayText(log) ?? undefined; }
  for (const d of diags) if (d.line && /Undefined control sequence/.test(d.message)) d.hint = undefinedCommand(log, d.line) ?? undefined;
  return { ok: r.status === 0, error: diags.find((d) => d.severity === "error" && d.line) };
};
for (const [name, body] of Object.entries(cases)) {
  const doc = pre + body + post;
  const { error } = build(doc);
  if (!error) { console.log(`== ${name}: no located error`); continue; }
  const f = ruleFix(error.message, error.line!, doc.split("\n"), knownCommandNames(), error.hint);
  if (!f) { console.log(`== ${name}: line ${error.line} "${error.message}" — no built-in fix`); continue; }
  const lines = doc.split("\n");
  lines[f.line - 1] = f.replacement;
  const after = build(lines.join("\n"));
  console.log(`== ${name}: ${after.ok ? "FIXED ✓" : "still failing ✗"}\n   ${JSON.stringify(f.original)}\n → ${JSON.stringify(f.replacement)}\n   ${f.explanation}`);
}
fs.rmSync(dir, { recursive: true, force: true });
