// Holds the currently loaded snippets and key handlers plus their errors and warnings.
// Editors subscribe to it; the loader replaces its contents on hot reload.

import { emptySet, MatchLog, Reporter, SnippetSet } from "./engine";
import type { FileInfo } from "./types";

export interface SnippetProblem {
  file: string;
  message: string;
  /** Snippet label, for runtime errors and slowness warnings. */
  label?: string;
  kind: "load" | "runtime" | "slow";
}

export const SLOW_KEYSTROKE_MS = 5;
const MAX_RUNTIME_PROBLEMS = 20;

export class SnippetRuntime implements Reporter {
  set: SnippetSet = emptySet;
  loadErrors: SnippetProblem[] = [];
  runtimeProblems: SnippetProblem[] = [];
  lastLog: MatchLog | null = null;
  fileInfo: FileInfo | null = null;
  /** Number of snippet files loaded successfully. */
  fileCount = 0;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  replace(set: SnippetSet, loadErrors: SnippetProblem[], fileCount: number) {
    this.set = set;
    this.loadErrors = loadErrors;
    this.fileCount = fileCount;
    this.runtimeProblems = [];
    this.emit();
  }

  setFileInfo(info: FileInfo | null) {
    this.fileInfo = info;
    this.emit();
  }

  private addProblem(p: SnippetProblem) {
    this.runtimeProblems = [...this.runtimeProblems.filter((q) => !(q.file === p.file && q.label === p.label && q.kind === p.kind)), p]
      .slice(-MAX_RUNTIME_PROBLEMS);
    this.emit();
  }

  error(label: string, file: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[texdesk] snippet ${label} (${file}) threw:`, err);
    this.addProblem({ file, label, message, kind: "runtime" });
  }

  slow(label: string, file: string, ms: number) {
    this.addProblem({ file, label, message: `took ${ms.toFixed(1)}ms`, kind: "slow" });
  }

  recordLog(log: MatchLog) {
    this.lastLog = log;
    if (log.totalMs > SLOW_KEYSTROKE_MS) {
      this.addProblem({ file: "(all)", label: log.event, message: `snippet matching took ${log.totalMs.toFixed(1)}ms`, kind: "slow" });
    } else {
      this.emit();
    }
  }

  clearRuntimeProblems() {
    this.runtimeProblems = [];
    this.emit();
  }
}
