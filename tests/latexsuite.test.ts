import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { convertLatexSuite, splitSnippetSource, tokenize } from "../src/convert/latexSuite";
import { loadSnippetFiles } from "../src/snippets/loader";
import { SnippetRuntime } from "../src/snippets/runtime";
import { SNIPPETS_TSCONFIG, texdeskDts } from "../src/workspace/seed";
import { editor, press, select, show, type } from "./helpers";

// A synthetic LaTeX Suite config exercising each feature (written like the plugin's own
// format: JavaScript, comments, regex literals, trailing commas).
const SNIPPETS = fs.readFileSync(path.join(__dirname, "fixtures", "latex-suite-snippets.txt"), "utf8");

const DATA = JSON.stringify({
  snippets: SNIPPETS,
  snippetVariables: '{\n\t"${GREEK}": "alpha|beta|gamma",\n}',
  autofractionEnabled: true,
  autofractionSymbol: "\\frac",
  autofractionExcludedEnvs: '[\n\t\t["^{", "}"],\n\t]',
  matrixShortcutsEnabled: true,
  matrixShortcutsEnvNames: "pmatrix, align*",
  autoEnlargeBrackets: true,
  autoEnlargeBracketsTriggers: "sum, int",
  taboutEnabled: true,
});

const result = convertLatexSuite(DATA, { date: new Date("2026-10-06"), sourcePath: "/x/data.json" });
const files = [
  { name: "imported-latex-suite.ts", code: result.code },
  ...(result.functionsCode ? [{ name: "imported-latex-suite-functions.ts", code: result.functionsCode }] : []),
];
const rt = () => {
  const r = new SnippetRuntime();
  const l = loadSnippetFiles(files);
  r.replace(l.set, l.errors, files.length);
  return r;
};

describe("parsing the LaTeX Suite source", () => {
  it("splits top-level entries and comments, respecting strings and regexes", () => {
    const items = splitSnippetSource(SNIPPETS);
    expect(items.filter((i) => i.kind === "snippet").length).toBe(18);
    expect(items[0]).toEqual({ kind: "comment", text: "Math mode" });
    expect(items).toContainEqual({ kind: "comment", text: '{trigger: "--", replacement: "–", options: "tA"},' });
  });
  it("tokenizes tab stops, defaults, groups and VISUAL", () => {
    expect(tokenize("\\frac{${0:a}}{$1}[[0]]${VISUAL}$x")).toEqual([
      { t: "lit", v: "\\frac{" }, { t: "stop", n: 0, def: "a" }, { t: "lit", v: "}{" }, { t: "stop", n: 1 },
      { t: "lit", v: "}" }, { t: "group", n: 0 }, { t: "visual" }, { t: "lit", v: "$x" },
    ]);
  });
});

describe("conversion", () => {
  it("summarizes what happened", () => {
    expect(result.summary.converted).toBe(18); // 17 snippets + auto-fraction
    expect(result.summary.todo).toEqual([{ trigger: "ex", reason: "Obsidian callout — no LaTeX equivalent" }]);
    expect(result.summary.notes.join("\n")).toMatch(/Auto-enlarge brackets/);
  });
  it("renumbers tab stops and rewrites math delimiters", () => {
    expect(result.code).toContain('s("mk", "\\\\($1\\\\)", { mode: "text", auto: true }),');
    expect(result.code).toContain('s("dm", "\\\\[\\n\\t$1\\n\\\\]", { mode: "text", auto: true, wordBoundary: true }),');
    expect(result.code).toContain('s("beg", "\\\\begin{$1}$2\\\\end{$1}"');
    expect(result.code).toContain('"\\\\sum_{${1:i}=${2:1}}^{${3:N}} $4", { mode: "math" }');
  });
  it("keeps dollars when asked", () => {
    expect(convertLatexSuite(DATA, { latexDelimiters: false }).code).toContain('s("mk", "$$$1$$", { mode: "text", auto: true }),');
  });
  it("leaves untranslatable entries as TODO comments with the original source", () => {
    expect(result.code).toContain('  // TODO(latex-suite): Obsidian callout — no LaTeX equivalent\n  // {trigger: "ex", replacement: ">[!example]- ", options: "tw"}');
  });
  it("puts verbatim JavaScript functions in an unchecked companion file", () => {
    expect(result.functionsCode).toMatch(/^\/\/ @ts-nocheck/);
    expect(result.functionsCode).toContain("export const fn1 = (match) => {");
    expect(result.code).toContain('import * as js from "./imported-latex-suite-functions";');
  });
  it("the output typechecks against texdesk.d.ts", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "texdesk-ls-"));
    fs.writeFileSync(path.join(tmp, "texdesk.d.ts"), texdeskDts());
    fs.writeFileSync(path.join(tmp, "tsconfig.json"), SNIPPETS_TSCONFIG);
    for (const f of files) fs.writeFileSync(path.join(tmp, f.name), f.code);
    const r = spawnSync(path.join(__dirname, "..", "node_modules", ".bin", "tsc"), ["-p", tmp, "--pretty", "false"], { encoding: "utf8" });
    fs.rmSync(tmp, { recursive: true });
    expect((r.stdout + r.stderr).trim()).toBe("");
  });
  it("loads without errors", () => {
    expect(loadSnippetFiles(files).errors).toEqual([]);
  });
});

describe("converted snippets behave like LaTeX Suite", () => {
  const cases: [string, string, string][] = [
    ["|", "mk", "\\(|\\)"],
    ["so |", "dm", "so \\[\n  |\n\\]"],
    ["|", "cdpy", "\\begin{lstlisting}[language=Python]\n|\n\\end{lstlisting}"],
    ["|", "money", "pay $x then |"],
    ["$|$", "x2", "$x_{2}|$"],
    ["$|$", "beta", "$\\beta|$"],
    ["$|$", "betax", "$\\beta x|$"],
    ["$|$", "sr", "$^{2}|$"],
    ["$|$", "iden2", "$\\begin{pmatrix}1 & 0 \\\\ 0 & 1\\end{pmatrix}|$"],
    ["$|$", "x/", "$\\frac{x}{|}$"],
    ["$e^{|}$", "x/", "$e^{x/|}$"],
    ["\\(|\\)", "pmat", "\\(\\begin{pmatrix}|\\end{pmatrix}\\)"],
    ["\\[|\\]", "pmat", "\\[\\begin{pmatrix}\n|\n\\end{pmatrix}\\]"],
    ["text |", "draw", "text draw|"],
    ["\\begin{tikzpicture}\n|\n\\end{tikzpicture}", "draw", "\\begin{tikzpicture}\n\\draw[|] ;\n\n\\end{tikzpicture}"],
  ];
  for (const [doc, typed, want] of cases) {
    it(`${JSON.stringify(typed)} in ${JSON.stringify(doc)}`, () => {
      const v = editor(doc, rt());
      type(v, typed);
      expect(show(v)).toBe(want);
    });
  }
  it("defaults and Tab-triggered snippets", () => {
    const v = editor("$|$", rt());
    type(v, "\\sum");
    press(v, "Tab");
    expect(show(v)).toBe("$\\sum_{[i]=1}^{N} $");
  });
  it("mirrored defaults (tayl)", () => {
    const v = editor("$|$", rt());
    type(v, "tayl");
    type(v, "g");
    expect(v.state.doc.toString()).toBe("$g(x) + g'(x)$");
  });
  it("visual", () => {
    const v = editor("$|ab$", rt());
    select(v, 1, 3);
    type(v, "U");
    expect(show(v)).toBe("$\\underbrace{ ab }_{ | }$");
  });
  it("matrix shortcuts", () => {
    const v = editor("\\[\\begin{pmatrix} a|\\end{pmatrix}\\]", rt());
    press(v, "Tab");
    press(v, "Enter");
    expect(show(v)).toBe("\\[\\begin{pmatrix} a &  \\\\\n|\\end{pmatrix}\\]");
    press(v, "Shift-Enter");
    expect(show(v)).toBe("\\[\\begin{pmatrix} a &  \\\\\n\\end{pmatrix}|\\]");
  });
});

describe("CLI", () => {
  it("writes a new plugin into a workspace's plugins folder and refuses to overwrite", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "texdesk-cli-"));
    fs.mkdirSync(path.join(ws, ".texdesk"), { recursive: true });
    const input = path.join(ws, "data.json");
    fs.writeFileSync(input, DATA);
    const run = () => spawnSync(path.join(__dirname, "..", "node_modules", ".bin", "tsx"), [path.join(__dirname, "..", "scripts", "convert-latex-suite.ts"), input, ws], { encoding: "utf8" });
    const first = run();
    expect(first.status).toBe(0);
    const plugin = path.join(ws, ".texdesk", "plugins", "imported-latex-suite");
    expect(fs.existsSync(path.join(plugin, "imported-latex-suite.ts"))).toBe(true);
    expect(fs.existsSync(path.join(plugin, "imported-latex-suite-functions.ts"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(plugin, "plugin.json"), "utf8")).name).toBe("Imported LaTeX Suite snippets");
    expect(fs.readFileSync(input, "utf8")).toBe(DATA); // input untouched
    const second = run();
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/already exists — not overwriting/);
    fs.rmSync(ws, { recursive: true });
  });
});
