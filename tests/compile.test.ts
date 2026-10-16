import { describe, expect, it } from "vitest";
import { BuildController, diagnosticsFor } from "../src/compile/controller";
import { exportPdf, exportTo, linkedPdfs, pdfName, readManifest, unlinkPdfs } from "../src/compile/export";
import { failureSummary, includedFiles, locateRunaway, parseDiagnostics } from "../src/compile/log";
import type { CompileRequest, CompileResult } from "../src/host/types";
import { defaultConfig } from "../src/workspace/config";
import { memoryHost, settle } from "./helpers";

// Real Tectonic 0.17 output captured while building this feature.
const BAD_STDERR = `error: bad.tex:4: Undefined control sequence
error: something bad happened inside XeTeX; its output follows:

===============================================================================
(bad.tex
! Undefined control sequence.
l.4 \\undefinedmacro
===============================================================================
error: the XeTeX engine had an unrecoverable error
caused by: halted on potentially-recoverable error as specified
`;
const OK_STDERR = `warning: ok.tex:6: Overfull \\hbox (231.46727pt too wide) detected at line 6
warning: ok.tex:6: Overfull \\hbox (231.46727pt too wide) detected at line 6
warning: warnings were issued by the TeX engine; use --print and/or --keep-logs for details.
`;
const OK_LOG = `(ok.tex
LaTeX Warning: Reference \`nope' on page 1 undefined on input line 4.

Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing \`math shift' on input line 12.

Overfull \\hbox (231.46727pt too wide) detected at line 6
LaTeX Warning: There were undefined references.
`;

describe("log parsing", () => {
  it("errors from stderr, without Tectonic's generic lines", () => {
    expect(parseDiagnostics(BAD_STDERR)).toEqual([{ severity: "error", file: "bad.tex", line: 4, message: "Undefined control sequence" }]);
  });
  it("dedupes repeated warnings and adds LaTeX warnings from the log", () => {
    expect(parseDiagnostics(OK_STDERR, OK_LOG, "ok.tex")).toEqual([
      { severity: "warning", file: "ok.tex", line: 6, message: "Overfull \\hbox (231.46727pt too wide) detected at line 6" },
      { severity: "warning", file: "ok.tex", line: 4, message: "Reference `nope' on page 1 undefined" },
      { severity: "warning", file: "ok.tex", line: 12, message: "Token not allowed in a PDF string (Unicode): removing `math shift'" },
      { severity: "warning", file: null, line: null, message: "There were undefined references." },
    ]);
  });
  it("summarizes failures without a location", () => {
    expect(failureSummary("error: failed to download https://relay.fullyjustified.net/default_bundle: dns error")).toMatch(/offline/);
    expect(failureSummary("error: couldn't open input file\nerror: the XeTeX engine had an unrecoverable error")).toBe("couldn't open input file");
  });
  it("finds included files", () => {
    expect(includedFiles("\\lstinputlisting[language=Python]{hw3-code/solve.py}\n% \\input{commented}\n\\input{parts/a}\n\\include{b.tex}"))
      .toEqual(["hw3-code/solve.py", "parts/a.tex", "b.tex"]);
  });
});

describe("PDF export", () => {
  const src = "/C/hw/hw1.tex";
  const built = "/C/hw/.build/hw1.pdf";

  it("names the PDF from the pattern", () => {
    expect(pdfName("{{course_compact}}_{{stem}}.pdf", { course_compact: "CS101", stem: "hw1" })).toBe("CS101_hw1.pdf");
    expect(pdfName("{{course_compact}}_{{stem}}.pdf", { course_compact: "", stem: "notes" })).toBe("notes.pdf");
    expect(pdfName("{{stem}}", { stem: "x" })).toBe("x.pdf");
  });

  it("exports when nothing is there, and records the hash", async () => {
    const host = memoryHost({ [src]: "", [built]: "PDF v1" });
    expect(await exportPdf(host, src, built, "CS101_hw1.pdf")).toEqual({ status: "exported", path: "/C/hw/CS101_hw1.pdf" });
    expect(host.files.get("/C/hw/CS101_hw1.pdf")).toBe("PDF v1");
    const m = await readManifest(host, "/C/hw");
    expect(m.exports["CS101_hw1.pdf"].source).toBe("hw1.tex");
  });

  it("overwrites its own unchanged export on the next build", async () => {
    const host = memoryHost({ [src]: "", [built]: "PDF v1" });
    await exportPdf(host, src, built, "hw1.pdf");
    host.files.set(built, "PDF v2");
    expect((await exportPdf(host, src, built, "hw1.pdf")).status).toBe("exported");
    expect(host.files.get("/C/hw/hw1.pdf")).toBe("PDF v2");
  });

  it("never overwrites a PDF it didn't write (e.g. the course's hw1.pdf)", async () => {
    const host = memoryHost({ [src]: "", [built]: "my PDF", "/C/hw/hw1.pdf": "course handout" });
    const r = await exportPdf(host, src, built, "hw1.pdf");
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringContaining("wasn't made by TeXdesk") });
    expect(host.files.get("/C/hw/hw1.pdf")).toBe("course handout");
  });

  it("doesn't overwrite an export that was changed afterwards", async () => {
    const host = memoryHost({ [src]: "", [built]: "v1" });
    await exportPdf(host, src, built, "hw1.pdf");
    host.files.set("/C/hw/hw1.pdf", "annotated by hand");
    const r = await exportPdf(host, src, built, "hw1.pdf");
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringContaining("changed outside TeXdesk") });
    expect(host.files.get("/C/hw/hw1.pdf")).toBe("annotated by hand");
  });
});

function fakeCompiler(files: Record<string, string>) {
  const host = memoryHost(files);
  const calls: CompileRequest[] = [];
  let respond: (req: CompileRequest) => Promise<CompileResult> = async (req) => {
    const pdf = req.file.replace(/\/([^/]+)\.tex$/, "/.build/$1.pdf");
    host.files.set(pdf, `PDF of ${req.file}`);
    return { ok: true, cancelled: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1200, pdf, launchError: null };
  };
  host.compile = (req) => { calls.push(req); return respond(req); };
  return { host, calls, setRespond: (f: typeof respond) => { respond = f; } };
}

const ctx = (root: string) => async () => ({
  root, config: { ...defaultConfig, exportPdf: true, pdfName: "{{course_compact}}_{{stem}}.pdf" },
  vars: { course_compact: "CS101" }, figuresDir: `${root}/Fa30/1-CS101/figures`,
});

describe("saved PDFs (Save PDF as…)", () => {
  const src = "/C/hw/hw1.tex";
  const built = "/C/hw/.build/hw1.pdf";
  const dest = "/C/submit/hw1-final.pdf";

  it("saves anywhere, replacing what the save dialog approved, and stays linked", async () => {
    const host = memoryHost({ [src]: "", [built]: "PDF v1", [dest]: "old file" });
    expect(await exportTo(host, src, built, dest, { linked: true, force: true })).toEqual({ status: "exported", path: dest });
    expect(host.files.get(dest)).toBe("PDF v1");
    expect(await linkedPdfs(host, src)).toEqual([dest]);
    expect(await linkedPdfs(host, "/C/hw/hw2.tex")).toEqual([]);
  });

  it("a build updates it, unless it was changed outside TeXdesk", async () => {
    const { host } = fakeCompiler({ [src]: "\\documentclass{article}" });
    host.files.set(built, "PDF v1");
    await exportTo(host, src, built, dest, { linked: true, force: true });
    const b = new BuildController(host, async () => ({ root: "/C", config: defaultConfig, vars: {}, figuresDir: null }));
    await b.build(src);
    expect(b.status.export).toBeUndefined(); // the automatic export is off by default
    expect(b.status.saved).toEqual([{ status: "exported", path: dest }]);
    expect(host.files.get(dest)).toBe(host.files.get(built));
    host.files.set(dest, "annotated by hand");
    await b.build(src);
    expect(b.status.saved?.[0]).toMatchObject({ status: "skipped" });
    expect(host.files.get(dest)).toBe("annotated by hand");
  });

  it("unlinking keeps the file but stops updates", async () => {
    const host = memoryHost({ [src]: "", [built]: "PDF v1" });
    await exportTo(host, src, built, dest, { linked: true, force: true });
    expect(await unlinkPdfs(host, src)).toEqual([dest]);
    expect(await linkedPdfs(host, src)).toEqual([]);
    expect(host.files.get(dest)).toBe("PDF v1");
  });
});

describe("build controller", () => {
  const doc = "/W/Fa30/1-CS101/hw/hw1.tex";
  const files = { [doc]: "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}", "/W/hw.sty": "% sty" };

  it("builds with the workspace root, texdesk.sty folder and configured figures folder on the search path, then exports", async () => {
    const { host, calls } = fakeCompiler(files);
    const b = new BuildController(host, ctx("/W"));
    await b.build(doc);
    expect(calls[0].searchPaths).toEqual(["/W", "/W/.texdesk/tex", "/W/Fa30/1-CS101/figures"]);
    expect(b.status).toMatchObject({ state: "ok", durationMs: 1200, export: { status: "exported", path: "/W/Fa30/1-CS101/hw/CS101_hw1.pdf" } });
  });

  it("debounces compile-on-save", async () => {
    const { host, calls } = fakeCompiler(files);
    const b = new BuildController(host, ctx("/W"));
    b.schedule(doc, 30); b.schedule(doc, 30); b.schedule(doc, 30);
    await settle(80);
    expect(calls.length).toBe(1);
  });

  it("saving a non-root file (hw.sty) rebuilds the last document", async () => {
    const { host, calls } = fakeCompiler(files);
    const b = new BuildController(host, ctx("/W"));
    await b.build(doc);
    await b.build("/W/hw.sty");
    expect(calls.map((c) => c.file)).toEqual([doc, doc]);
  });

  it("a superseded build's result is ignored", async () => {
    const { host, setRespond } = fakeCompiler(files);
    const b = new BuildController(host, ctx("/W"));
    let release!: () => void;
    setRespond(() => new Promise((r) => { release = () => r({ ok: false, cancelled: true, exitCode: null, stdout: "", stderr: "", durationMs: 5, pdf: null, launchError: null }); }));
    const first = b.build(doc);
    await settle(5);
    setRespond(async () => ({ ok: true, cancelled: false, exitCode: 0, stdout: "", stderr: "warning: hw1.tex:3: Overfull", durationMs: 7, pdf: null, launchError: null }));
    await b.build(doc);
    release();
    await first;
    expect(b.status).toMatchObject({ state: "ok", durationMs: 7 });
  });

  it("errors become diagnostics for the open file", async () => {
    const { host, setRespond } = fakeCompiler(files);
    setRespond(async () => ({ ok: false, cancelled: false, exitCode: 1, stdout: "", stderr: BAD_STDERR.replace(/bad\.tex/g, "hw1.tex"), durationMs: 5, pdf: null, launchError: null }));
    const b = new BuildController(host, ctx("/W"));
    await b.build(doc);
    expect(b.status.state).toBe("failed");
    expect(b.status.summary).toBeUndefined();
    expect(diagnosticsFor(b.status, doc)).toEqual([{ severity: "error", file: "hw1.tex", line: 4, message: "Undefined control sequence" }]);
    expect(diagnosticsFor(b.status, "/W/other.tex")).toEqual([]);
  });

  it("a missing Tectonic is reported plainly", async () => {
    const { host, setRespond } = fakeCompiler(files);
    setRespond(async () => ({ ok: false, cancelled: false, exitCode: null, stdout: "", stderr: "", durationMs: 0, pdf: null, launchError: "Tectonic isn't installed" }));
    const b = new BuildController(host, ctx("/W"));
    await b.build(doc);
    expect(b.status).toMatchObject({ state: "failed", summary: "Tectonic isn't installed" });
  });

  it("export can be turned off", async () => {
    const { host } = fakeCompiler(files);
    const b = new BuildController(host, async () => ({ root: "/W", config: { ...defaultConfig, exportPdf: false }, vars: {}, figuresDir: null }));
    await b.build(doc);
    expect(b.status.export).toBeUndefined();
    expect([...host.files.keys()].some((f) => f.endsWith("hw/hw1.pdf"))).toBe(false);
  });

  it("recompiles when an \\lstinputlisting file changes", async () => {
    const { host, calls } = fakeCompiler({
      ...files,
      [doc]: "\\documentclass{article}\n\\begin{document}\n\\lstinputlisting{code/solve.py}\n\\end{document}",
      "/W/Fa30/1-CS101/hw/code/solve.py": "print(1)",
    });
    const b = new BuildController(host, ctx("/W"));
    await b.build(doc);
    host.touch("/W/Fa30/1-CS101/hw/code/solve.py", "print(2)");
    await settle(400);
    expect(calls.length).toBe(2);
    host.touch("/W/Fa30/1-CS101/hw/code/other.py", "x");
    await settle(400);
    expect(calls.length).toBe(2);
  });
});

describe("locating errors TeX couldn't place", () => {
  it("finds a missing } from the runaway text", () => {
    const source = "\\documentclass{article}\n\\begin{document}\n\\begin{enumerate}\n  \\item Let $x = \\frac{1}{2$ and $y = 3$.\n\\end{enumerate}\n\\end{document}\n";
    const log = "Runaway argument?\n{2$ and $y = 3$. \\end {enumerate} \\end {document} \n! File ended while scanning use of \\frac .\n";
    expect(locateRunaway(log, source)).toBe(4);
    expect(locateRunaway("no runaway here", source)).toBeNull();
    expect(locateRunaway("Runaway argument?\n{zzzz qqq\n", source)).toBeNull();
  });
});
