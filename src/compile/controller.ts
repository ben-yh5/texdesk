// Build orchestration: debounced compile-on-save, superseded builds, diagnostics, PDF
// export, and recompiling when files the document includes change.

import { Host, basename, dirname, join } from "../host/types";
import type { WorkspaceConfig } from "../workspace/config";
import { ExportResult, exportPdf, exportTo, linkedPdfs, pdfName } from "./export";
import { BuildDiagnostic, failureSummary, includedFiles, locateRunaway, parseDiagnostics, runawayText, undefinedCommand } from "./log";

export interface BuildStatus {
  state: "idle" | "running" | "ok" | "failed";
  /** Source file of the latest build. */
  file: string | null;
  durationMs?: number;
  diagnostics: BuildDiagnostic[];
  /** Why the build failed, when there's no located error to point at. */
  summary?: string;
  /** PDF in `.build/`. */
  pdf?: string | null;
  /** The automatic export next to the source, if enabled. */
  export?: ExportResult;
  /** PDFs saved with "Save PDF as…", updated after this build. */
  saved?: ExportResult[];
}

export interface BuildContext {
  root: string | null;
  /** Config in effect for the document (its folders' types and settings applied). */
  config: WorkspaceConfig;
  /** Template variables for the document's folder (for `pdf_name`). */
  vars: Record<string, string>;
  /** The figures folder from settings, if any (on the search path). */
  figuresDir: string | null;
}

export const DEBOUNCE_MS = 300;

export class BuildController {
  status: BuildStatus = { state: "idle", file: null, diagnostics: [] };
  /** The last document built (used when saving a non-root file such as a .sty). */
  lastRoot: string | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private token = 0;
  private unwatchIncludes: (() => void)[] = [];

  constructor(private host: Host, private context: (file: string) => Promise<BuildContext>) {}

  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private set(s: BuildStatus) { this.status = s; for (const fn of this.listeners) fn(); }

  /** Compile-on-save entry point: debounced. */
  schedule(file: string, delay = DEBOUNCE_MS) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.build(file), delay);
  }

  /** Which document a save of `file` should build: itself if it's a root document, else the last one built. */
  async rootFor(file: string): Promise<string | null> {
    if (!file.endsWith(".tex")) return this.lastRoot;
    try {
      const text = await this.host.readText(file);
      if (/^[^%\n]*\\documentclass/m.test(text)) return file;
    } catch { /* fall through */ }
    return this.lastRoot;
  }

  /** Returns false when there's nothing to build (not a document, and no previous build). */
  async build(file: string): Promise<boolean> {
    clearTimeout(this.timer);
    const source = await this.rootFor(file);
    if (!source) return false;
    const token = ++this.token;
    this.lastRoot = source;
    this.set({ ...this.status, state: "running", file: source });

    const { searchPaths, cfg, ctx } = await this.paths(source);
    let result;
    try {
      result = await this.host.compile({ file: source, searchPaths, tectonic: cfg.tectonic });
    } catch (err) {
      if (token === this.token) this.set({ state: "failed", file: source, diagnostics: [], summary: String(err) });
      return true;
    }
    if (token !== this.token || result.cancelled) return true; // a newer build owns the status

    if (result.launchError) {
      this.set({ state: "failed", file: source, diagnostics: [], summary: result.launchError });
      return true;
    }
    const dir = dirname(source);
    const stem = basename(source).replace(/\.tex$/, "");
    let log = "";
    try { log = await this.host.readText(join(dir, ".build", `${stem}.log`)); } catch { /* no log */ }
    const diagnostics = parseDiagnostics(result.stderr, log, basename(source));
    // Errors TeX couldn't place (a missing } …): find their line from the runaway text.
    if (!result.ok && !diagnostics.some((d) => d.severity === "error" && d.line !== null)) {
      const unplaced = diagnostics.find((d) => d.severity === "error" && d.line === null);
      let text = "";
      try { text = await this.host.readText(source); } catch { /* gone */ }
      const line = unplaced && text ? locateRunaway(log, text) : null;
      if (unplaced && line) { unplaced.file = basename(source); unplaced.line = line; unplaced.hint = runawayText(log) ?? undefined; }
    }
    // Which command an "Undefined control sequence" is about.
    for (const d of diagnostics) {
      if (d.severity === "error" && d.line && /Undefined control sequence/.test(d.message)) d.hint = undefinedCommand(log, d.line) ?? undefined;
    }

    let exp: ExportResult | undefined;
    const saved: ExportResult[] = [];
    if (result.ok && result.pdf && cfg.exportPdf) {
      const name = pdfName(cfg.pdfName, { ...ctx.vars, stem });
      try {
        exp = await exportPdf(this.host, source, result.pdf, name);
      } catch (err) {
        exp = { status: "skipped", path: join(dir, name), reason: `couldn't export: ${String(err)}` };
      }
    }
    if (result.ok && result.pdf) {
      for (const dest of await linkedPdfs(this.host, source)) {
        if (exp && "path" in exp && dest === exp.path) continue;
        try {
          saved.push(await exportTo(this.host, source, result.pdf, dest, { linked: true }));
        } catch (err) {
          saved.push({ status: "skipped", path: dest, reason: `couldn't update ${basename(dest)}: ${String(err)}` });
        }
      }
    }

    this.set({
      state: result.ok ? "ok" : "failed",
      file: source,
      durationMs: result.durationMs,
      diagnostics,
      summary: result.ok ? undefined : diagnostics.some((d) => d.severity === "error" && d.line !== null) ? undefined : failureSummary(result.stderr),
      pdf: result.pdf,
      export: exp,
      saved,
    });
    if (token === this.token) await this.watchIncludes(source);
    return true;
  }

  private async paths(source: string) {
    const ctx = await this.context(source);
    const cfg = ctx.config;
    const searchPaths = [
      ...(ctx.root ? [ctx.root, join(ctx.root, ".texdesk", "tex")] : []),
      ...(ctx.figuresDir ? [ctx.figuresDir] : []),
    ];
    return { searchPaths, cfg, ctx };
  }

  /** Recompile when a file pulled in with \lstinputlisting / \input / \include changes. */
  private async watchIncludes(source: string) {
    this.unwatchIncludes.forEach((f) => f());
    this.unwatchIncludes = [];
    let text: string;
    try { text = await this.host.readText(source); } catch { return; }
    const dir = dirname(source);
    const files = new Set(includedFiles(text).map((p) => (p.startsWith("/") ? p : join(dir, p))));
    const dirs = new Set([...files].map(dirname));
    for (const d of dirs) {
      try {
        this.unwatchIncludes.push(await this.host.watch(d, (paths) => {
          if (paths.some((p) => files.has(p))) this.schedule(source);
        }));
      } catch { /* folder missing */ }
    }
  }

  dispose() {
    clearTimeout(this.timer);
    this.unwatchIncludes.forEach((f) => f());
  }
}

/** Diagnostic lines that belong to `openFile`, given the build's source file. */
export function diagnosticsFor(status: BuildStatus, openFile: string): BuildDiagnostic[] {
  if (!status.file) return [];
  const dir = dirname(status.file);
  return status.diagnostics.filter((d) => {
    if (d.line === null || d.file === null) return false;
    const abs = d.file.startsWith("/") ? d.file : join(dir, d.file.replace(/^\.\//, ""));
    return abs === openFile;
  });
}
