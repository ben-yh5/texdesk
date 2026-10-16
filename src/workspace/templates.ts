// Templates: plain .tex files in `.texdesk/templates/` that new files start from. What a
// template is called, where its files go and how they're named is in workspace.json
// (`templates`), so any workspace can define its own "New …" commands; the app knows nothing
// about what they mean.

import { Host, join } from "../host/types";
import type { TemplateDef, WorkspaceFile } from "./model";

/** The shared preamble a new workspace starts with (every built-in template loads it). */
export const PREAMBLE_STY = `\\ProvidesPackage{preamble}
% Shared by every document in this workspace: templates load it with \\usepackage{preamble}.
% It's yours to edit.
\\RequirePackage[margin=1in]{geometry}
\\RequirePackage{amsmath, amssymb, amsthm, mathtools}
\\RequirePackage{graphicx, float, enumitem}
\\RequirePackage{parskip}   % blank line = new paragraph, no indent
\\RequirePackage{xcolor, listings}
\\RequirePackage{texdesk}  % \\link{file} between documents (provided by TeXdesk)

\\lstset{
  basicstyle=\\ttfamily\\small,
  columns=fullflexible, keepspaces=true,
  breaklines=true, showstringspaces=false,
  frame=single, framerule=0.3pt, rulecolor=\\color{gray!50},
  numbers=left, numberstyle=\\tiny\\color{gray}, xleftmargin=2em,
  tabsize=4,
  keywordstyle=\\color{blue!60!black}\\bfseries,
  commentstyle=\\color{gray}\\itshape,
  stringstyle=\\color{red!50!black},
}

\\theoremstyle{plain}
\\newtheorem{theorem}{Theorem}
\\newtheorem{lemma}[theorem]{Lemma}
\\theoremstyle{definition}
\\newtheorem{definition}[theorem]{Definition}

\\newcommand{\\R}{\\mathbb{R}}
\\newcommand{\\N}{\\mathbb{N}}
\\newcommand{\\Z}{\\mathbb{Z}}
\\newcommand{\\Q}{\\mathbb{Q}}
`;

export const DEFAULT_TEMPLATES: Record<string, string> = {
  "article.tex": `\\documentclass[11pt]{article}
\\usepackage{preamble}
\\title{{{title}}}
\\author{{{author}}}
\\date{{{date}}}
\\begin{document}
\\maketitle

$0
\\end{document}
`,
};

/** Starting text for a template made with "New template". */
export const NEW_TEMPLATE = `\\documentclass[11pt]{article}
\\usepackage{preamble}
\\begin{document}
\\section*{{{title}}}

$0
\\end{document}
`;

export const TEMPLATES_README = `# Templates

Every \`.tex\` file here is a template that "New file…" (⌘N) can start from. Edit them like
any document. What a template is called, where its files go and how they're named is set in
Settings → Workspace → Templates (it's saved in \`.texdesk/workspace.json\`).

## Variables

\`{{name}}\` is replaced by a variable; anything else in double braces is left alone (LaTeX
uses \`{{\` too). \`$0\` marks where the cursor goes.

- Always available: \`{{date}}\` (October 9, 2026), \`{{year}}\`, \`{{title}}\`, \`{{stem}}\`
  (the new file's name without \`.tex\`) and \`{{n}}\` (the next number, when the name uses it).
- Your variables (Settings → Files & folders), e.g. \`{{author}}\`.
- The fields of every typed folder above the new file, e.g. a class's \`{{course}}\`. The
  nearest folder wins; \`{{class.course}}\` names the folder type to be sure.
- \`{{class_folder}}\`: the name of the nearest folder of that type (e.g. for \`\\\\link\`).
- Anything the template asks for.
`;

export interface PromptSpec {
  /** Variable name. */
  name: string;
  /** What to ask. */
  question: string;
}

export interface TemplateHeader {
  label: string | null;
  /** Folder type the new file goes in (the nearest folder of it). */
  in: string | null;
  /** Subfolder of that folder. */
  dir: string;
  /** File name pattern. */
  name: string | null;
  prompt: PromptSpec[];
}

export const EMPTY_HEADER: TemplateHeader = { label: null, in: null, dir: "", name: null, prompt: [] };

export interface TemplateInfo {
  /** Its key in workspace.json `templates`, or the body's file name for one that has no entry. */
  key: string;
  /** Body file name in `.texdesk/templates/`, e.g. `homework.tex`. */
  file: string;
  /** Where the body lives, or null for a built-in default that isn't in the workspace. */
  path: string | null;
  scope: "workspace" | "built-in";
  header: TemplateHeader;
}

export interface LoadedTemplate extends TemplateInfo {
  body: string;
  errors: string[];
}

export const questionFor = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ");

/** A workspace.json template entry as a header. */
export function headerOf(t: TemplateDef): TemplateHeader {
  return {
    label: t.label ?? null, in: t.in ?? null, dir: t.dir ?? "", name: t.name ?? null,
    prompt: Object.entries(t.prompt ?? {}).map(([name, question]) => ({ name, question: question || questionFor(name) })),
  };
}

export const templatesDir = (root: string) => join(root, ".texdesk", "templates");

/**
 * Every template: each workspace.json entry (with its body), each other `.tex` in
 * `.texdesk/templates/` (no "New …" command, but ⌘N can start from it), and the built-in
 * defaults that aren't in the workspace.
 */
export async function listTemplates(host: Host, root: string, ws: WorkspaceFile): Promise<TemplateInfo[]> {
  const dir = templatesDir(root);
  const files = new Set<string>();
  if (await host.exists(dir)) for (const e of await host.readDir(dir)) if (!e.isDir && e.name.endsWith(".tex")) files.add(e.name);
  const out: TemplateInfo[] = [];
  const claimed = new Set<string>();
  for (const [key, t] of Object.entries(ws.templates)) {
    claimed.add(t.body);
    const present = files.has(t.body);
    if (!present && !DEFAULT_TEMPLATES[t.body]) continue;
    out.push({ key, file: t.body, path: present ? join(dir, t.body) : null, scope: present ? "workspace" : "built-in", header: headerOf(t) });
  }
  for (const f of files) if (!claimed.has(f)) out.push({ key: f.replace(/\.tex$/, ""), file: f, path: join(dir, f), scope: "workspace", header: EMPTY_HEADER });
  for (const f of Object.keys(DEFAULT_TEMPLATES)) {
    if (!files.has(f) && !claimed.has(f)) out.push({ key: f.replace(/\.tex$/, ""), file: f, path: null, scope: "built-in", header: EMPTY_HEADER });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Reads a template's body. */
export async function readTemplate(host: Host, t: TemplateInfo): Promise<LoadedTemplate> {
  const body = t.path ? await host.readText(t.path) : DEFAULT_TEMPLATES[t.file] ?? "";
  return { ...t, body, errors: [] };
}

/** A template by key. */
export async function findTemplate(host: Host, root: string, ws: WorkspaceFile, key: string): Promise<LoadedTemplate> {
  const t = (await listTemplates(host, root, ws)).find((x) => x.key === key);
  if (!t) throw new Error(`There's no template “${key}”`);
  return readTemplate(host, t);
}

/** The command label for a template ("New <label>"). */
export const templateLabel = (t: { key: string; header: TemplateHeader }) => t.header.label ?? t.key;

/** The default name pattern when a template doesn't give one. */
export const defaultName = () => "{{title}}.tex";

/**
 * What to ask before creating from `t`: its prompts, then any variable its name uses,
 * skipping what's already known (`n` is computed, never asked).
 */
export function promptsFor(t: { header: TemplateHeader }, known: Record<string, string>, name = t.header.name ?? defaultName()): PromptSpec[] {
  const out = t.header.prompt.filter((p) => !(p.name in known));
  for (const v of variablesIn(name)) {
    if (v === "n" || v in known || out.some((p) => p.name === v)) continue;
    out.push({ name: v, question: questionFor(v) });
  }
  return out;
}

/** Names of the `{{variables}}` in `text` (`{{class.code}}` included). */
export function variablesIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{(\w+(?:\.\w+)?)\}\}/g)].map((m) => m[1]))];
}

/**
 * Substitutes `{{var}}` for every variable in `vars` (others are left alone, since LaTeX uses
 * double braces) and removes the first `$0`, returning its offset as the cursor.
 */
export function renderTemplate(template: string, vars: Record<string, string>): { text: string; cursor: number } {
  const filled = template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (m, name: string) => (Object.hasOwn(vars, name) ? vars[name] : m));
  const at = filled.indexOf("$0");
  if (at < 0) return { text: filled, cursor: filled.length };
  return { text: filled.slice(0, at) + filled.slice(at + 2), cursor: at };
}

/** A file or folder name from a pattern; variable values can't add path separators. */
export function renderName(pattern: string, vars: Record<string, string>): string {
  const name = pattern.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (m, k: string) =>
    Object.hasOwn(vars, k) ? vars[k].trim().replace(/[/\\:*?"<>|]+/g, "-").replace(/\s+/g, " ") : m);
  if (!name.trim() || name.split("/").some((p) => p === ".." || p === ".")) throw new Error(`"${name}" isn't a usable name`);
  return name;
}

/** Matches names made from `pattern`, capturing `{{n}}`; null if the pattern has no `{{n}}`. */
export function numberPattern(pattern: string): RegExp | null {
  if (!pattern.includes("{{n}}")) return null;
  const parts = pattern.split(/(\{\{\w+(?:\.\w+)?\}\})/);
  let n = false;
  const src = parts.map((p) => {
    if (p === "{{n}}" && !n) { n = true; return "(\\d+)"; }
    if (/^\{\{\w+(?:\.\w+)?\}\}$/.test(p)) return ".+?";
    return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return new RegExp(`^${src}$`);
}

/** One more than the highest `{{n}}` among names in `dir` made from `pattern` (1 if none). */
export async function nextNumber(host: Host, dir: string, pattern: string, folders: boolean): Promise<number> {
  const re = numberPattern(pattern);
  if (!re || !(await host.exists(dir))) return 1;
  let max = 0;
  for (const e of await host.readDir(dir)) {
    if (e.isDir !== folders) continue;
    const m = re.exec(e.name);
    if (m) max = Math.max(max, +m[1]);
  }
  return max + 1;
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** Variables every template gets. */
export function builtinVars(now: Date): Record<string, string> {
  return { date: formatDate(now), year: String(now.getFullYear()) };
}
