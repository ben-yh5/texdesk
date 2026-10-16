// Converts an Obsidian LaTeX Suite data.json into a TeXdesk plugin.
//
//   npx tsx scripts/convert-latex-suite.ts <data.json> [workspace-or-plugins-dir] [--keep-dollars] [--name id]
//
// The input file is only read. The output is a new plugin folder (default name
// imported-latex-suite) in your plugins (~/.config/texdesk/plugins), or in a workspace's
// .texdesk/plugins when a workspace is given. An existing plugin is never overwritten.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { convertLatexSuite } from "../src/convert/latexSuite";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (name: string) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };

const keepDollars = flag("--keep-dollars");
const id = opt("--name") ?? "imported-latex-suite";
const [input, target] = args;
if (!input) {
  console.error("usage: convert-latex-suite <data.json> [workspace-or-plugins-dir] [--keep-dollars] [--name id]");
  process.exit(2);
}

const src = path.resolve(input);
let dir = target ? path.resolve(target) : path.join(os.homedir(), ".config", "texdesk", "plugins");
if (fs.existsSync(path.join(dir, ".texdesk"))) dir = path.join(dir, ".texdesk", "plugins");
const plugin = path.join(dir, id);
if (fs.existsSync(plugin)) { console.error(`${plugin} already exists — not overwriting (use --name another-id)`); process.exit(1); }

const fnModule = `${id}-functions`;
const { code, functionsCode, summary } = convertLatexSuite(fs.readFileSync(src, "utf8"), {
  latexDelimiters: !keepDollars, sourcePath: src, functionsModule: fnModule,
});
fs.mkdirSync(plugin, { recursive: true });
fs.writeFileSync(path.join(plugin, "plugin.json"), JSON.stringify({ name: "Imported LaTeX Suite snippets", description: `From ${path.basename(src)}`, version: "1" }, null, 2) + "\n", { flag: "wx" });
if (functionsCode) fs.writeFileSync(path.join(plugin, `${fnModule}.ts`), functionsCode, { flag: "wx" });
fs.writeFileSync(path.join(plugin, `${id}.ts`), code, { flag: "wx" });
console.log(`Wrote the plugin ${plugin}`);
if (functionsCode) console.log(`  ${fnModule}.ts: JavaScript functions, copied verbatim`);
console.log(`  ${summary.converted} converted, ${summary.todo.length} left as TODO comments`);
for (const t of summary.todo) console.log(`  TODO ${t.trigger}: ${t.reason}`);
for (const n of summary.notes) console.log(`  note: ${n}`);
