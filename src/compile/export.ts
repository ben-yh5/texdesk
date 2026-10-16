// Copying the built PDF out of `.build/` without ever clobbering a PDF TeXdesk didn't
// write. `.build/manifest.json` records the SHA-256 of every copy; a copy is (over)written
// only if the destination is missing or still matches that hash.
//
// Two kinds of copy: the automatic export next to the source (`export_pdf` / `pdf_name`),
// and "saved" PDFs from **Save PDF as…**, which stay linked to the source and are updated
// after every successful build until unlinked.

import { Host, basename, dirname, join } from "../host/types";

export interface ManifestEntry {
  sha256: string;
  /** Source file name (in the manifest's folder). */
  source: string;
  /** Saved with "Save PDF as…": updated on every build of `source`. */
  linked?: boolean;
}

export interface Manifest {
  version: 1;
  /** Copy → info. Keyed by file name for copies in the source's folder, else by absolute path. */
  exports: Record<string, ManifestEntry>;
}

export type ExportResult =
  | { status: "exported"; path: string }
  | { status: "skipped"; path: string; reason: string }
  | { status: "disabled" };

export function manifestPath(sourceDir: string): string {
  return join(sourceDir, ".build", "manifest.json");
}

export async function readManifest(host: Host, sourceDir: string): Promise<Manifest> {
  const p = manifestPath(sourceDir);
  try {
    if (await host.exists(p)) {
      const m = JSON.parse(await host.readText(p)) as Manifest;
      if (m && typeof m.exports === "object") return m;
    }
  } catch {
    // unreadable manifest: treat as empty (we then refuse to overwrite anything)
  }
  return { version: 1, exports: {} };
}

async function writeManifest(host: Host, dir: string, m: Manifest) {
  await host.mkdirAll(join(dir, ".build"));
  await host.writeText(manifestPath(dir), JSON.stringify(m, null, 2) + "\n");
}

/** Manifest key for a copy: its name if it's in `dir`, else its absolute path. */
function keyFor(dir: string, dest: string): string {
  return dirname(dest) === dir ? basename(dest) : dest;
}

/** Absolute path of a manifest key. */
export function entryPath(dir: string, key: string): string {
  return key.startsWith("/") ? key : join(dir, key);
}

/** Fills `{{stem}}` and template variables in the configured PDF name. */
export function pdfName(pattern: string, vars: Record<string, string>): string {
  let name = pattern.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? "");
  name = name.replace(/^[_\-\s]+/, "").replace(/[/\\]/g, "-");
  if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
  return name;
}

/**
 * Copies `builtPdf` to `dest` and records it. Refuses (status "skipped") if `dest` exists
 * and isn't an unchanged copy TeXdesk wrote, unless `force` (the user picked it in a save dialog).
 */
export async function exportTo(
  host: Host, source: string, builtPdf: string, dest: string, opts: { linked?: boolean; force?: boolean } = {},
): Promise<ExportResult> {
  const dir = dirname(source);
  if (dest === builtPdf) return { status: "disabled" };
  const name = basename(dest);
  const key = keyFor(dir, dest);
  const manifest = await readManifest(host, dir);
  const existing = await host.sha256(dest);
  const known = manifest.exports[key];
  if (!opts.force && existing !== null && (!known || known.sha256 !== existing)) {
    return {
      status: "skipped",
      path: dest,
      reason: known
        ? `${name} was changed outside TeXdesk, so it wasn't overwritten`
        : opts.linked
          ? `${name} already exists and wasn't made by TeXdesk, so it wasn't overwritten`
          : `${name} already exists and wasn't made by TeXdesk, so it wasn't overwritten — change the exported PDF name (Settings → Build & PDF, or the folder type's) to export under another name`,
    };
  }
  await host.copyFile(builtPdf, dest);
  const sha = await host.sha256(dest);
  const linked = opts.linked || known?.linked;
  manifest.exports[key] = { sha256: sha!, source: basename(source), ...(linked ? { linked: true } : {}) };
  await writeManifest(host, dir, manifest);
  return { status: "exported", path: dest };
}

/** The automatic export next to the source, named `name`. */
export function exportPdf(host: Host, source: string, builtPdf: string, name: string): Promise<ExportResult> {
  return exportTo(host, source, builtPdf, join(dirname(source), name));
}

/** PDFs saved from `source` with "Save PDF as…" (absolute paths). */
export async function linkedPdfs(host: Host, source: string): Promise<string[]> {
  const dir = dirname(source);
  const m = await readManifest(host, dir);
  return Object.entries(m.exports)
    .filter(([, e]) => e.linked && e.source === basename(source))
    .map(([k]) => entryPath(dir, k));
}

/** Stops updating saved PDFs of `source` (all of them, or just `dest`). The files themselves stay. */
export async function unlinkPdfs(host: Host, source: string, dest?: string): Promise<string[]> {
  const dir = dirname(source);
  const m = await readManifest(host, dir);
  const removed: string[] = [];
  for (const [k, e] of Object.entries(m.exports)) {
    if (!e.linked || e.source !== basename(source)) continue;
    if (dest && entryPath(dir, k) !== dest) continue;
    delete m.exports[k];
    removed.push(entryPath(dir, k));
  }
  if (removed.length) await writeManifest(host, dir, m);
  return removed;
}
