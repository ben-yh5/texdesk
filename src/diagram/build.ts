// Builds a picture on its own (a standalone document with the document's preamble) for the
// diagram editor, in the document's .build/diagram/ folder, and reads back where things landed.

import { Host, join } from "../host/types";
import { failureSummary, parseDiagnostics } from "../compile/log";
import { Point, diagramDocument, instrument, parsePicture, readProbes } from "./tikz";

export interface DiagramError {
  /** Line in the picture (1 = its \begin{tikzpicture} line), or null. */
  line: number | null;
  message: string;
}

export interface DiagramBuild {
  ok: boolean;
  /** Set when the build was superseded by a newer one (nothing to show). */
  cancelled?: boolean;
  pdf: string | null;
  /** Probe id → position in TeX points. */
  probes: Map<string, Point>;
  errors: DiagramError[];
}

export interface DiagramBuildOptions {
  /** The folder of the document the picture is in. */
  docDir: string;
  preamble: string;
  picture: string;
  searchPaths: string[];
  tectonic: string | null;
}

export async function buildDiagram(host: Host, o: DiagramBuildOptions): Promise<DiagramBuild> {
  const dir = join(o.docDir, ".build", "diagram");
  const file = join(dir, "diagram.tex");
  const doc = diagramDocument(o.preamble, instrument(parsePicture(o.picture)));
  await host.mkdirAll(dir);
  await host.writeText(file, doc);
  const result = await host.compile({ file, searchPaths: [o.docDir, ...o.searchPaths], tectonic: o.tectonic });
  const empty = { probes: new Map<string, Point>(), pdf: null };
  if (result.cancelled) return { ok: false, cancelled: true, errors: [], ...empty };
  if (result.launchError) return { ok: false, errors: [{ line: null, message: result.launchError }], ...empty };

  let log = "";
  try { log = await host.readText(join(dir, ".build", "diagram.log")); } catch { /* no log */ }
  // Lines before the picture in the generated document.
  const offset = doc.slice(0, doc.lastIndexOf("\\begin{document}\n")).split("\n").length;
  const errors = parseDiagnostics(result.stderr, log, "diagram.tex")
    .filter((d) => d.severity === "error")
    .map((d) => ({ line: d.line !== null && d.line > offset ? d.line - offset : null, message: d.message }));
  if (!result.ok && !errors.length) errors.push({ line: null, message: failureSummary(result.stderr) });
  return { ok: result.ok, pdf: result.pdf, probes: readProbes(log), errors };
}
