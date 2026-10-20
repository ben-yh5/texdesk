import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { currentCompletions, setSelectedCompletion } from "@codemirror/autocomplete";
import { App } from "../src/app/App";
import { formatWorkspace, emptyWorkspace, type WorkspaceFile } from "../src/workspace/model";
import { STARTERS } from "../src/workspace/starters";
import { fixtureFiles, memoryHost, settle, type } from "./helpers";
import { forEachDiagnostic } from "@codemirror/lint";
import type { Anchor, Viewer, ViewerFactory } from "../src/preview/viewer";
import type { PdfLocation } from "../src/preview/synctex";
import fs from "node:fs";
import path from "node:path";

const WS = "/School";
/** A workspace plugin's folder. */
const SNIPS = `${WS}/.texdesk/plugins/mine`;
/** One of your plugins (the test host's home is /home). */
const GLOBAL_SNIPS = "/home/.config/texdesk/plugins/latex-snippets";
const WSJ = `${WS}/.texdesk/workspace.json`;
const COURSEWORK = STARTERS.find((st) => st.id === "coursework")!;
/** workspace.json text: the school's folder types and folders, plus `extra`. */
const wsJson = (extra: Partial<WorkspaceFile> = {}, settings: Record<string, unknown> = {}) => formatWorkspace({
  ...emptyWorkspace(),
  folderTypes: COURSEWORK.folderTypes,
  overviews: COURSEWORK.overviews,
  folders: {
    Fa30: { type: "term" },
    "Fa30/1-CS101": { type: "class", fields: { code: "CS101", course: "CS 101", course_compact: "CS101" }, settings: { pdf_name: "{{course_compact}}_{{stem}}.pdf" } },
    "Fa30/2-MATH210": { type: "class", fields: { code: "MATH210", course: "MATH 210" } },
  },
  settings,
  ...extra,
});
// CodeMirror's "Mod" is Cmd on macOS and Ctrl elsewhere (jsdom reports a non-Mac platform).
const modKey = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 1000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    try { const v = fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out; status: " + (document.querySelector(".status")?.textContent ?? "") + " | pal: " + (document.querySelector(".pal-title")?.textContent ?? "") + " | " + [...document.querySelectorAll(".pal-item .pal-label")].map((e) => e.textContent).join(","));
    await settle(5);
  }
}

/** The PDF pane, if it's showing. */
const pdfPane = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>(".pdf-side")].find((el) => el.style.display !== "none") ?? null;

let cleanup: (() => void)[] = [];
// The welcome tour shows once; tests that want it clear this.
// The test workspace's code is allowed (as if you'd said Allow); the trust tests undo this.
beforeEach(() => { localStorage.clear(); localStorage.setItem("texdesk:tourDone", "true"); localStorage.setItem(`texdesk:trust:${WS}`, "true"); });
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; document.body.innerHTML = ""; });

/** A stand-in for the pdf.js viewer that records what it was asked to do. */
function stubViewers() {
  const viewers: (Viewer & { loads: { text: string; anchor: Anchor | null | undefined }[]; reveals: PdfLocation[]; quietReveals: PdfLocation[]; current: Anchor })[] = [];
  const factory: ViewerFactory = async () => {
    const v = {
      loads: [] as { text: string; anchor: Anchor | null | undefined }[],
      reveals: [] as PdfLocation[],
      quietReveals: [] as PdfLocation[],
      current: { page: 1, fraction: 0 } as Anchor,
      onSync: null as Viewer["onSync"],
      onLink: null as Viewer["onLink"],
      pointAt: () => ({ page: 1, x: 10, y: 20 }),
      async load(data: ArrayBuffer, anchor?: Anchor | null) { v.loads.push({ text: new TextDecoder().decode(data), anchor }); if (anchor) v.current = anchor; },
      anchor() { return v.current; },
      reveal(loc: PdfLocation, opts?: { quiet?: boolean }) { v.reveals.push(loc); if (opts?.quiet) v.quietReveals.push(loc); },
      destroy() {},
    };
    viewers.push(v);
    return v;
  };
  return { viewers, factory };
}

async function boot(files: Record<string, string>, initial: string | null = null, pickFolder: string | null = null, prepare?: (host: ReturnType<typeof memoryHost>) => void) {
  const host = memoryHost(files);
  prepare?.(host);
  host.initialFile = async () => initial;
  host.pickFolder = async () => pickFolder;
  const root = document.createElement("div");
  document.body.append(root);
  const pdf = stubViewers();
  cleanup.push(render(() => <App host={host} viewerFactory={pdf.factory} />, root));
  await settle(30);
  const editor = () => EditorView.findFromDOM(root.querySelector(".cm-editor") as HTMLElement)!;
  const status = () => root.querySelector(".status")!.textContent!;
  const tree = () => [...root.querySelectorAll(".tree-row .tree-name")].map((e) => e.textContent);
  /** `metaKey: true` means the platform's Mod key (⌘ on macOS, Ctrl in jsdom). */
  const key = (k: string, mods: KeyboardEventInit = {}) => {
    const m = { ...mods };
    if (m.metaKey && !/Mac/.test(navigator.platform)) { delete m.metaKey; m.ctrlKey = true; }
    return window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...m }));
  };
  /** Types into the palette and presses Enter. */
  const palette = async (text: string, clear = true) => {
    const input = await waitFor(() => root.querySelector<HTMLInputElement>(".pal-input"));
    input.value = clear ? text : input.value + text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle(5);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle(30);
  };
  const command = async (name: string) => { key("k", { metaKey: true, shiftKey: true }); await palette(name); };
  return { host, root, editor, status, tree, key, palette, command, pdf };
}

const workspace = {
  [WSJ]: wsJson(),
  [`${WS}/hw.sty`]: "% sty",
  [`${WS}/Fa30/1-CS101/hw/hw1.tex`]: "\\documentclass{article}\nText \\(x\\) here",
  [`${WS}/Fa30/1-CS101/hw/hw2.tex`]: "two",
  [`${WS}/Fa30/1-CS101/hw/hw1.pdf`]: "%PDF course handout",
  [`${WS}/Fa30/1-CS101/hw/data.zip`]: "PK",
  [`${WS}/Fa30/1-CS101/notes/.keep`]: "",
  [`${WS}/Fa30/1-CS101/figures/.keep`]: "",
  [`${WS}/Fa30/2-MATH210/hw/hw3.tex`]: "math hw3",
  [`${WS}/.git/HEAD`]: "ref",
};

/** The workspace with the Coursework starter's templates. */
const coursework: Record<string, string> = {
  ...workspace,
  [WSJ]: wsJson({ templates: COURSEWORK.templates, overviews: COURSEWORK.overviews }),
  ...Object.fromEntries(Object.entries(COURSEWORK.bodies).map(([name, text]) => [`${WS}/.texdesk/templates/${name}`, text])),
};

describe("opening", () => {
  it("shows a welcome screen when there's nothing to reopen", async () => {
    const { root } = await boot({});
    expect(root.querySelector(".welcome")?.textContent).toContain("Open folder");
  });

  it("opening a file finds its workspace, reveals it in the tree, and shows the breadcrumb", async () => {
    const { editor, status, tree } = await boot(workspace, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => editor()?.state.doc.toString().startsWith("\\documentclass"));
    expect(status()).toContain("Fa30 / 1-CS101 / hw1.tex");
    expect(tree()).toEqual(expect.arrayContaining(["Fa30", "1-CS101", "hw", "hw1.tex", "hw2.tex", "hw1.pdf", "hw.sty"]));
    expect(tree()).not.toContain(".git");
    editor().dispatch({ selection: { anchor: 31 } });
    await settle(0);
    expect(status()).toContain("inline math");
  });

  it("reopens the last folder and file on the next launch", async () => {
    const a = await boot(workspace, `${WS}/Fa30/1-CS101/hw/hw2.tex`);
    await waitFor(() => a.editor()?.state.doc.toString() === "two");
    cleanup.forEach((f) => f()); cleanup = [];
    document.body.innerHTML = "";
    const b = await boot(Object.fromEntries(a.host.files));
    await waitFor(() => b.editor()?.state.doc.toString() === "two");
    expect(b.status()).toContain("hw2.tex");
  });

  it("a folder without .texdesk asks first, and setting up creates only .texdesk/ and preamble.sty", async () => {
    const files = { "/Fresh/notes/old.md": "# old", "/Fresh/preamble.sty": "% my own preamble" };
    const { host, root, key, palette, status } = await boot(files, null, "/Fresh");
    key("o", { metaKey: true, shiftKey: true });
    await waitFor(() => root.querySelector(".pal-title")?.textContent?.includes("Set up Fresh for TeXdesk"));
    expect([...root.querySelectorAll(".pal-item .pal-label")].map((e) => e.textContent)).toEqual(["Blank", "Coursework", "Open without setting up"]);
    await palette("Blank");
    await waitFor(() => host.files.has("/Fresh/.texdesk/workspace.json"));
    const created = [...host.files.keys()].filter((f) => !(f in files) && !f.startsWith("/home/")).sort();
    expect(created.every((f) => f.startsWith("/Fresh/.texdesk/"))).toBe(true);
    expect(created.some((f) => f.includes("homework") || f.includes("snippets") || f.includes("plugins"))).toBe(false);
    expect(created).toEqual(expect.arrayContaining([
      "/Fresh/.texdesk/workspace.json", "/Fresh/.texdesk/workspace.schema.json", "/Fresh/.texdesk/templates/article.tex", "/Fresh/.texdesk/templates/README.md",
    ]));
    expect(host.files.get("/Fresh/preamble.sty")).toBe("% my own preamble");
    expect(host.files.get("/Fresh/notes/old.md")).toBe("# old");
    expect(status()).toContain("Set up TeXdesk");
  });

  it("“Open without setting up” writes nothing", async () => {
    const files = { "/Plain/a.tex": "a" };
    const { host, root, key, palette } = await boot(files, null, "/Plain");
    key("o", { metaKey: true, shiftKey: true });
    await waitFor(() => root.querySelector(".pal-title"));
    await palette("without");
    await waitFor(() => root.querySelector(".sidebar"));
    expect([...host.files.keys()].filter((f) => !f.startsWith("/home/"))).toEqual(["/Plain/a.tex"]);
  });

  it("binary files (other than PDFs) open in the default app instead of the editor", async () => {
    const { host, root } = await boot(workspace, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => root.querySelector(".tree-row"));
    const zip = [...root.querySelectorAll<HTMLElement>(".tree-row")].find((r) => r.textContent?.includes("data.zip"))!;
    zip.click();
    await waitFor(() => host.opened.length);
    expect(host.opened).toEqual([`${WS}/Fa30/1-CS101/hw/data.zip`]);
  });
});

describe("⌘K and commands", () => {
  it("⌘K matches path segments: “101 hw2”", async () => {
    const { editor, key, palette } = await boot(workspace, `${WS}/Fa30/2-MATH210/hw/hw3.tex`);
    await waitFor(() => editor()?.state.doc.toString() === "math hw3");
    key("k", { metaKey: true });
    await palette("101 hw2");
    await waitFor(() => editor().state.doc.toString() === "two");
  });

  it("⌘⇧F opens the sidebar's search: every .tex file, unsaved edits included; clicking a match selects it", async () => {
    const { root, editor, key } = await boot(workspace, `${WS}/Fa30/2-MATH210/hw/hw3.tex`);
    await waitFor(() => editor()?.state.doc.toString() === "math hw3");
    editor().dispatch({ changes: { from: 0, insert: "here unsaved\n" } });
    key("f", { metaKey: true, shiftKey: true });
    const input = await waitFor(() => root.querySelector<HTMLInputElement>(".search-input"));
    await waitFor(() => document.activeElement === input);
    input.value = "here";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await waitFor(() => root.querySelectorAll(".search-hit").length === 2);
    expect([...root.querySelectorAll(".search-file-name")].map((e) => e.textContent)).toEqual(["hw3.tex", "hw1.tex"]);
    expect(root.querySelector(".search-count")!.textContent).toBe("2 results in 2 files");
    input.value = "\\(x";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await waitFor(() => root.querySelectorAll(".search-hit").length === 1);
    root.querySelector<HTMLElement>(".search-hit")!.click();
    await waitFor(() => editor().state.doc.toString().startsWith("\\documentclass"));
    const sel = editor().state.selection.main;
    expect(editor().state.sliceDoc(sel.from, sel.to)).toBe("\\(x");
  });

  it("opening a match doesn't reorder the results (the file open when you searched stays first)", async () => {
    const { root, editor, key } = await boot(workspace, `${WS}/Fa30/2-MATH210/hw/hw3.tex`);
    await waitFor(() => editor()?.state.doc.toString() === "math hw3");
    editor().dispatch({ changes: { from: 0, insert: "here\n" } });
    key("f", { metaKey: true, shiftKey: true });
    const input = await waitFor(() => root.querySelector<HTMLInputElement>(".search-input"));
    input.value = "here";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const order = () => [...root.querySelectorAll(".search-file-name")].map((e) => e.textContent).join();
    await waitFor(() => order() === "hw3.tex,hw1.tex");
    root.querySelectorAll<HTMLElement>(".search-hit")[1].click(); // in hw1.tex
    await waitFor(() => editor().state.doc.toString().startsWith("\\documentclass"));
    await settle(400); // the save of hw3 and the reindex that follows
    expect(order()).toBe("hw3.tex,hw1.tex");
    expect(root.querySelector(".search-hit.selected")!.textContent).toContain("here");
  });

  it("Esc closes search, hiding the sidebar again if search showed it; ⌘⇧F in the box closes it too", async () => {
    const { root, editor, key } = await boot(workspace, `${WS}/Fa30/2-MATH210/hw/hw3.tex`);
    await waitFor(() => editor()?.state.doc.toString() === "math hw3");
    key("\\", { metaKey: true });
    await waitFor(() => !root.querySelector(".sidebar"));
    key("f", { metaKey: true, shiftKey: true });
    const input = await waitFor(() => root.querySelector<HTMLInputElement>(".search-input"));
    await waitFor(() => document.activeElement === input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await waitFor(() => !root.querySelector(".sidebar"));
    expect(editor().hasFocus).toBe(true);

    key("\\", { metaKey: true }); // shown for good: closing search goes back to the files
    await waitFor(() => root.querySelector(".sidebar"));
    key("f", { metaKey: true, shiftKey: true });
    await waitFor(() => document.activeElement === root.querySelector(".search-input"));
    key("f", { metaKey: true, shiftKey: true });
    await waitFor(() => (root.querySelector(".search-panel")!.parentElement as HTMLElement).style.display === "none");
    expect(root.querySelector(".sidebar")).toBeTruthy();
  });

  it("a template's command (New Homework) finds the course from the open file, numbers it, and puts the cursor at $0", async () => {
    const { host, editor, command, status } = await boot(coursework, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => editor()?.state.doc.length);
    await command("New Homework");
    const p = `${WS}/Fa30/1-CS101/hw/hw3.tex`;
    await waitFor(() => host.files.has(p));
    const text = host.files.get(p)!;
    expect(text).toContain("\\textbf{Course:} CS 101 \\\\");
    expect(text).toContain("Problem Set \\#3");
    await waitFor(() => editor().state.doc.toString() === text);
    const cur = editor().state.selection.main.head;
    expect(text.slice(cur - 8, cur)).toBe("  \\item ");
    expect(status()).toContain("hw3.tex");
  });

  it("outside a course, it asks which one", async () => {
    const { host, editor, command, palette } = await boot(coursework, WS);
    await settle(30);
    await command("New Homework");
    await palette("210");
    await waitFor(() => host.files.has(`${WS}/Fa30/2-MATH210/hw/hw4.tex`));
    await waitFor(() => editor()?.state.doc.toString().includes("Problem Set \\#4"));
  });

  it("New Note asks for a title and creates notes/<title>.tex", async () => {
    const { host, editor, command, palette } = await boot(coursework, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => editor()?.state.doc.length);
    await command("New Note");
    await palette("Graph Algorithms");
    const p = `${WS}/Fa30/1-CS101/notes/Graph Algorithms.tex`;
    await waitFor(() => host.files.has(p));
    expect(host.files.get(p)).toContain("\\section*{Graph Algorithms}");
  });

  it("New Class makes a folder of that type in the term, named by its code, with its fields and subfolders", async () => {
    const { host, editor, command, palette, root } = await boot(coursework, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => editor()?.state.doc.length);
    await command("New Class");
    expect((await waitFor(() => root.querySelector<HTMLInputElement>(".pal-input")))!.placeholder).toBe("Course code, e.g. CS101");
    await palette("CS201");
    await palette("CS 201");
    await waitFor(() => JSON.parse(host.files.get(WSJ)!).folders["Fa30/CS201"]);
    expect(JSON.parse(host.files.get(WSJ)!).folders["Fa30/CS201"]).toEqual({ type: "class", fields: { code: "CS201", course: "CS 201" } });
    for (const sub of ["hw", "notes", "figures"]) expect(await host.exists(`${WS}/Fa30/CS201/${sub}`)).toBe(true);
    // It opens the new class's overview, with its New buttons.
    await waitFor(() => root.querySelector(".tab.overview .tab-name")?.textContent === "CS201");
    await waitFor(() => [...root.querySelectorAll(".ov-new-btn")].map((x) => x.textContent).includes("New Homework"));
  });

  it("with no folder of the type a template or folder needs, it says so and creates nothing", async () => {
    const files = { ...coursework, [WSJ]: wsJson({ templates: COURSEWORK.templates, folders: {} }) };
    const { host, command, status } = await boot(files, WS);
    await settle(30);
    const before = host.files.size;
    await command("New Class");
    await waitFor(() => status().includes("A Class goes inside a Term — make one of those first"));
    await command("New Homework");
    await waitFor(() => status().includes("No Class folder yet"));
    expect(host.files.size).toBe(before);
  });

  it("without templates there are no homework commands; each folder type has a New command", async () => {
    const { key, root } = await boot(workspace, WS);
    await settle(30);
    key("k", { metaKey: true, shiftKey: true });
    await waitFor(() => root.querySelector(".pal-item"));
    const labels = [...root.querySelectorAll(".pal-item .pal-label")].map((e) => e.textContent);
    expect(labels.some((l) => /Homework|Note/.test(l!))).toBe(false);
    expect(labels).toEqual(expect.arrayContaining(["New Term", "New Class"]));
  });
});

describe("templates folder", () => {
  it("opening a workspace without .texdesk/templates/ adds the default templates as files", async () => {
    const b = await boot(workspace, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.host.files.has(`${WS}/.texdesk/templates/article.tex`));
    expect(b.host.files.has(`${WS}/.texdesk/templates/README.md`)).toBe(true);
  });
  it("an existing templates folder is left alone", async () => {
    const b = await boot({ ...workspace, [`${WS}/.texdesk/templates/mine.tex`]: "x" }, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    await settle(50);
    expect([...b.host.files.keys()].filter((f) => f.includes("/templates/"))).toEqual([`${WS}/.texdesk/templates/mine.tex`]);
  });
});

describe("file tree", () => {
  const hw1 = `${WS}/Fa30/1-CS101/hw/hw1.tex`;
  const files = {
    ...workspace,
    [WSJ]: wsJson({ templates: { hw: { body: "hw.tex", in: "class", dir: "hw", name: "hw{{n}}.tex" }, notes: { body: "notes.tex", in: "class", dir: "notes" } } }),
    [`${WS}/.texdesk/templates/hw.tex`]: "\\documentclass{article}\n% {{course}} #{{n}} {{title}}\n$0\n",
    [`${WS}/.texdesk/templates/notes.tex`]: "\\section*{{{title}}}\n",
  };

  /** Types a name into the tree's inline box and presses Enter. */
  async function nameIt(root: HTMLElement, name: string) {
    const input = await waitFor(() => root.querySelector<HTMLInputElement>(".tree-input"));
    input.value = name;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle(30);
  }
  const row = (root: HTMLElement, name: string) =>
    waitFor(() => [...root.querySelectorAll<HTMLElement>(".tree-row")].find((r) => r.querySelector(".tree-name")?.textContent === name));

  it("⌘N asks for a name next to the open file; an extension is kept", async () => {
    const { host, editor, key, root, palette } = await boot(files, hw1);
    await waitFor(() => editor()?.state.doc.length);
    key("n", { metaKey: true });
    expect((await waitFor(() => root.querySelector(".pal-title"))).textContent).toBe("New file in Fa30/1-CS101/hw");
    await palette("scratch.py");
    await waitFor(() => host.files.get(`${WS}/Fa30/1-CS101/hw/scratch.py`) === "");
    await waitFor(() => editor().state.doc.toString() === "" && root.querySelector(".tree-row.active")?.textContent?.includes("scratch.py"));
  });

  it("an existing name is refused in the box, and nothing is overwritten", async () => {
    const { host, editor, command, root } = await boot(files, hw1);
    await waitFor(() => editor()?.state.doc.length);
    await command("New file");
    const input = await waitFor(() => root.querySelector<HTMLInputElement>(".pal-input"));
    input.value = "hw2"; // .tex is implied
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect((await waitFor(() => root.querySelector(".pal-error"))).textContent).toContain("hw2.tex already exists");
    expect(host.files.get(`${WS}/Fa30/1-CS101/hw/hw2.tex`)).toBe("two");
  });

  /** Types a name into the New file box, optionally clicks a template under it, and presses Enter. */
  async function newFileNamed(root: HTMLElement, name: string, template?: string) {
    const input = await waitFor(() => root.querySelector<HTMLInputElement>(".pal-input"));
    input.value = name;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle(5);
    if (template) {
      const item = await waitFor(() => [...root.querySelectorAll<HTMLElement>(".pal-choices .pal-item")].find((i) => i.querySelector(".pal-label")!.textContent === template));
      item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      await settle(5);
    }
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle(30);
  }
  const choiceLabels = (root: HTMLElement) => [...root.querySelectorAll(".pal-choices .pal-item")].map((i) => i.querySelector(".pal-label")!.textContent + (i.classList.contains("active") ? "*" : ""));

  it("the template is chosen in the same box; the folder a template targets suggests it", async () => {
    const { host, editor, command, root } = await boot(files, hw1);
    await waitFor(() => editor()?.state.doc.length);
    await command("New file");
    await waitFor(() => root.querySelector(".pal-choices"));
    expect(choiceLabels(root)).toEqual(["hw*", "article", "notes", "Blank file"]);
    await newFileNamed(root, "hw7");
    const text = await waitFor(() => host.files.get(`${WS}/Fa30/1-CS101/hw/hw7.tex`));
    expect(text).toBe("\\documentclass{article}\n% CS 101 #7 hw7\n\n");
    await waitFor(() => editor().state.doc.toString() === text);
    expect(editor().state.selection.main.head).toBe(text.length - 1);
  });

  it("↑↓ or a click picks another template; non-.tex names hide the list", async () => {
    const { host, editor, command, root } = await boot(files, hw1);
    await waitFor(() => editor()?.state.doc.length);
    await command("New file");
    const input = await waitFor(() => root.querySelector<HTMLInputElement>(".pal-input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await settle(5);
    expect(choiceLabels(root)).toEqual(["hw", "article*", "notes", "Blank file"]);
    input.value = "run.py";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle(5);
    expect(root.querySelector(".pal-choices")).toBeNull();
    await newFileNamed(root, "Lecture 4", "notes");
    expect(await waitFor(() => host.files.get(`${WS}/Fa30/1-CS101/hw/Lecture 4.tex`))).toContain("\\section*{Lecture 4}");
    await command("New file");
    await newFileNamed(root, "draft", "Blank file");
    await waitFor(() => host.files.get(`${WS}/Fa30/1-CS101/hw/draft.tex`) === "");
  });

  it("the tree's + asks for a file in that folder; New folder is named in place", async () => {
    const { host, root, command, editor, palette } = await boot(files, hw1);
    await waitFor(() => editor()?.state.doc.length);
    await command("New folder");
    await nameIt(root, "code");
    await waitFor(() => host.files.has(`${WS}/Fa30/1-CS101/hw/code/.keep`));
    const notes = await row(root, "notes");
    notes.querySelector<HTMLButtonElement>('.tree-add[title="New file here"]')!.click();
    expect((await waitFor(() => root.querySelector(".pal-title"))).textContent).toBe("New file in Fa30/1-CS101/notes");
    await palette("data/input.txt");
    await waitFor(() => host.files.has(`${WS}/Fa30/1-CS101/notes/data/input.txt`));
  });

  it("renaming the open file keeps it open; Escape cancels", async () => {
    const { host, root, editor } = await boot(files, hw1);
    await waitFor(() => editor()?.state.doc.length);
    (await row(root, "hw1.tex")).click();
    root.querySelector<HTMLElement>(".tree")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const input = await waitFor(() => root.querySelector<HTMLInputElement>(".tree-input"));
    expect(input.value).toBe("hw1.tex");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(10);
    expect(root.querySelector(".tree-input")).toBeNull();
    root.querySelector<HTMLElement>(".tree")!.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    await nameIt(root, "hw1-final.tex");
    await waitFor(() => host.files.has(`${WS}/Fa30/1-CS101/hw/hw1-final.tex`));
    expect(host.files.has(hw1)).toBe(false);
    // Still open under its new name: saving writes there, not to the old path.
    editor().dispatch({ changes: { from: 0, insert: "% edited\n" } });
    editor().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ...modKey, bubbles: true, cancelable: true }));
    await waitFor(() => host.files.get(`${WS}/Fa30/1-CS101/hw/hw1-final.tex`)!.startsWith("% edited"));
    expect(host.files.has(hw1)).toBe(false);
  });

  it("dragging a file onto a folder moves it", async () => {
    const { host, root, editor } = await boot(files, hw1);
    await waitFor(() => editor()?.state.doc.length);
    await row(root, "hw2.tex");
    expect(root.querySelectorAll(".drop-target").length).toBe(0); // nothing highlighted until you drag
    const src = await row(root, "hw2.tex");
    const dest = await row(root, "notes");
    src.dispatchEvent(new Event("dragstart", { bubbles: true }));
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    dest.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(dest.classList.contains("drop-target")).toBe(true);
    dest.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await waitFor(() => host.files.get(`${WS}/Fa30/1-CS101/notes/hw2.tex`) === "two");
    expect(root.querySelectorAll(".drop-target").length).toBe(0);
    expect(host.files.has(`${WS}/Fa30/1-CS101/hw/hw2.tex`)).toBe(false);
  });

  it("moving a file updates links to it, and its own relative links", async () => {
    const lecture = `${WS}/Fa30/1-CS101/notes/lecture3.tex`;
    const b = await boot({
      ...files,
      [lecture]: "See \\link{../hw/hw2} and \\link{hw2}.",
      [`${WS}/Fa30/1-CS101/hw/hw2.tex`]: "Read \\link[notes]{../notes/lecture3} first.",
      [`${WS}/Fa30/1-CS101/notes/week1/.keep`]: "",
    }, lecture);
    await waitFor(() => b.editor()?.state.doc.length);
    const src = await row(b.root, "lecture3.tex");
    const dest = await row(b.root, "week1");
    src.dispatchEvent(new Event("dragstart", { bubbles: true }));
    dest.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    dest.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await waitFor(() => b.status().includes("updated 2 links in 2 files"));
    expect(b.host.files.get(`${WS}/Fa30/1-CS101/hw/hw2.tex`)).toBe("Read \\link[notes]{../notes/week1/lecture3} first.");
    // The moved file is the open one: its edit goes through the editor and is saved.
    expect(b.editor().state.doc.toString()).toBe("See \\link{../../hw/hw2} and \\link{hw2}.");
    expect(b.host.files.get(`${WS}/Fa30/1-CS101/notes/week1/lecture3.tex`)).toBe("See \\link{../../hw/hw2} and \\link{hw2}.");
  });

  it("a folder can't be dropped into itself", async () => {
    const { root, editor } = await boot(files, hw1);
    await waitFor(() => editor()?.state.doc.length);
    const hw = await row(root, "hw");
    hw.dispatchEvent(new Event("dragstart", { bubbles: true }));
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    (await row(root, "hw1.tex")).dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
  });

  it("deleting asks first, moves to the Trash, and closes the file if it was open", async () => {
    const { host, root, editor, palette } = await boot(files, hw1);
    await waitFor(() => editor()?.state.doc.length);
    (await row(root, "hw1.tex")).click();
    const tree = root.querySelector<HTMLElement>(".tree")!;
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", metaKey: true, ctrlKey: true, bubbles: true }));
    await palette("Cancel");
    expect(host.files.has(hw1)).toBe(true);
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await palette("Move to Trash");
    await waitFor(() => !host.files.has(hw1));
    expect(host.trashed).toEqual([hw1]);
    await waitFor(() => !root.querySelector(".tab.text"));
  });

  it("the right-click menu offers new, rename and delete", async () => {
    const { root, editor } = await boot(files, hw1);
    await waitFor(() => editor()?.state.doc.length);
    (await row(root, "hw2.tex")).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const items = [...(await waitFor(() => root.querySelector(".ctx-menu"))).querySelectorAll(".ctx-menu-item")].map((b) => b.firstChild!.textContent);
    expect(items).toEqual(["New File…", "New Folder…", "Rename…", "Move to Trash", "Reveal in Finder"]);
    (await row(root, "hw")).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await waitFor(() => [...root.querySelectorAll(".ctx-menu-item")].some((b) => b.firstChild!.textContent === "Set Folder Type…"));
    // A term's menu offers a new class in it.
    (await row(root, "Fa30")).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await waitFor(() => [...root.querySelectorAll(".ctx-menu-item")].some((b) => b.firstChild!.textContent === "New Class…"));
  });

  it("Set Folder Type… gives a folder a type, then asks for its fields; Edit Fields… changes them", async () => {
    const extra = { [`${WS}/Wi31/Stuff/.keep`]: "" };
    const { host, root, editor, palette } = await boot({ ...files, ...extra }, hw1);
    await waitFor(() => editor()?.state.doc.length);
    const menu = async (name: string, item: string) => {
      (await row(root, name)).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      (await waitFor(() => [...root.querySelectorAll<HTMLElement>(".ctx-menu-item")].find((b) => b.firstChild!.textContent === item))).click();
    };
    await row(root, "Wi31");
    await menu("Wi31", "Set Folder Type…");
    await palette("Term");
    await waitFor(() => JSON.parse(host.files.get(WSJ)!).folders.Wi31?.type === "term");
    (await row(root, "Wi31")).click();
    await menu("Stuff", "Set Folder Type…");
    await palette("Class");
    await palette("ABC101"); // its fields: code…
    await palette("Abc 101"); // …and course name
    await waitFor(() => JSON.parse(host.files.get(WSJ)!).folders["Wi31/Stuff"]?.fields?.course === "Abc 101");
    expect(JSON.parse(host.files.get(WSJ)!).folders["Wi31/Stuff"]).toEqual({ type: "class", fields: { code: "ABC101", course: "Abc 101" } });
    await menu("1-CS101", "Edit Fields…");
    await palette("", false); // keeps the code
    await palette("Probability", true);
    await waitFor(() => JSON.parse(host.files.get(WSJ)!).folders["Fa30/1-CS101"].fields.course === "Probability");
    expect(JSON.parse(host.files.get(WSJ)!).folders["Fa30/1-CS101"].fields.code).toBe("CS101");
  });

  it("Settings → Workspace edits templates: a built-in one is copied into the workspace to edit, and new ones get a file", async () => {
    const { host, root, editor, command } = await boot({ ...files, [WSJ]: wsJson({ templates: { article: { label: "Document", body: "article.tex" } } }) }, hw1);
    await waitFor(() => editor()?.state.doc.length);
    const workspacePane = async () => {
      await command("Folder types and templates");
      (await waitFor(() => [...root.querySelectorAll<HTMLElement>(".wsp-tab")].find((b) => b.textContent === "Templates"))).click();
    };
    await workspacePane();
    (await waitFor(() => [...root.querySelectorAll<HTMLElement>(".set-button")].find((b) => b.textContent === "Edit template…"))).click();
    await waitFor(() => host.files.has(`${WS}/.texdesk/templates/article.tex`) && !root.querySelector(".set"));
    await waitFor(() => editor().state.doc.toString().includes("\\maketitle"));
    await workspacePane();
    (await waitFor(() => [...root.querySelectorAll<HTMLElement>(".wsp-add")].find((b) => b.textContent === "+ Template"))).click();
    await waitFor(() => JSON.parse(host.files.get(WSJ)!).templates.new_template);
    expect(JSON.parse(host.files.get(WSJ)!).templates.new_template).toEqual({ label: "New template", body: "new_template.tex", name: "{{title}}.tex" });
    expect(host.files.get(`${WS}/.texdesk/templates/new_template.tex`)).toContain("\\section*{{{title}}}");
    // Giving it a folder type and subfolder: saved as you go.
    const goes = await waitFor(() => [...root.querySelectorAll(".wsp-row")].find((r) => r.querySelector(".wsp-label")?.textContent?.startsWith("Goes in"))?.querySelector<HTMLSelectElement>("select"));
    goes.value = "class";
    goes.dispatchEvent(new Event("change"));
    await waitFor(() => JSON.parse(host.files.get(WSJ)!).templates.new_template.in === "class");
    // Renaming its file: moved on disk, and workspace.json follows (".tex" is added).
    const body = await waitFor(() => root.querySelector<HTMLInputElement>(".wsp-body input"));
    expect(body.value).toBe("new_template.tex");
    body.value = "problem";
    body.dispatchEvent(new Event("change"));
    await waitFor(() => JSON.parse(host.files.get(WSJ)!).templates.new_template.body === "problem.tex");
    expect(host.files.has(`${WS}/.texdesk/templates/new_template.tex`)).toBe(false);
    expect(host.files.get(`${WS}/.texdesk/templates/problem.tex`)).toContain("\\section*{{{title}}}");
    // A name with a folder in it is refused, and the box goes back.
    body.value = "x/y.tex";
    body.dispatchEvent(new Event("change"));
    await waitFor(() => root.querySelector(".wsp-errors")?.textContent?.includes("plain file name"));
    expect(JSON.parse(host.files.get(WSJ)!).templates.new_template.body).toBe("problem.tex");
  });

  it("renaming a template's file in the tree keeps workspace.json pointing at it", async () => {
    const { host, root, editor } = await boot({
      ...files, [WSJ]: wsJson({ templates: { article: { label: "Document", body: "article.tex" } } }),
      [`${WS}/.texdesk/templates/article.tex`]: "\\documentclass{article}",
    }, hw1);
    await waitFor(() => editor()?.state.doc.length);
    (await row(root, ".texdesk")).click();
    (await row(root, "templates")).click();
    (await row(root, "article.tex")).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    (await waitFor(() => [...root.querySelectorAll<HTMLElement>(".ctx-menu-item")].find((b) => b.firstChild!.textContent === "Rename…"))).click();
    const input = await waitFor(() => root.querySelector<HTMLInputElement>(".tree-input"));
    input.value = "doc.tex";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => JSON.parse(host.files.get(WSJ)!).templates.article.body === "doc.tex");
    expect(host.files.has(`${WS}/.texdesk/templates/doc.tex`)).toBe(true);
  });

  it("Settings → Workspace edits folder types; renaming a type's key rewrites templates that use it", async () => {
    const { host, root, editor, command } = await boot({ ...coursework }, hw1);
    await waitFor(() => editor()?.state.doc.length);
    await command("Folder types and templates");
    (await waitFor(() => [...root.querySelectorAll<HTMLElement>(".wsp-item")].find((b) => b.textContent?.startsWith("Class")))).click();
    const field = (label: string) => waitFor(() => [...root.querySelectorAll(".wsp-row")].find((r) => r.querySelector(".wsp-label")?.textContent?.startsWith(label))?.querySelector<HTMLInputElement>("input"));
    const key = await field("Key");
    key.value = "course";
    key.dispatchEvent(new Event("change"));
    await waitFor(() => JSON.parse(host.files.get(WSJ)!).folderTypes.course);
    const w = JSON.parse(host.files.get(WSJ)!);
    expect(w.folders["Fa30/1-CS101"].type).toBe("course");
    expect(w.templates.homework.in).toBe("course");
    expect(w.folderTypes.term.children).toEqual(["course"]);
    expect(host.files.get(`${WS}/.texdesk/templates/note.tex`)).toContain("\\link[{{course}}]{{{course_folder}}}");
    const name = await field("Name");
    name.value = "Course";
    name.dispatchEvent(new Event("change"));
    await waitFor(() => JSON.parse(host.files.get(WSJ)!).folderTypes.course.label === "Course");
  });
});

describe("editing", () => {
  it("dropping a snippet file in takes effect without a restart; errors show in the status bar", async () => {
    const { host, editor, status } = await boot({ [WSJ]: "{}", [`${SNIPS}/plugin.json`]: "{}", [`${WS}/notes.tex`]: "" }, `${WS}/notes.tex`);
    await waitFor(() => editor());
    type(editor(), "mk");
    expect(editor().state.doc.toString()).toBe("mk");
    for (const f of fixtureFiles("snippets", ["basics.ts", "shared.ts"])) host.touch(`${SNIPS}/${f.name}`, f.code);
    await settle();
    expect(status()).toMatch(/\d+ snippets/);
    type(editor(), " mk");
    expect(editor().state.doc.toString()).toBe("mk \\(\\)");
    host.touch(`${SNIPS}/oops.ts`, "export default [;");
    await settle();
    expect(status()).toContain("⚠ 1");
  });

  it("Cmd+S saves; switching files autosaves", async () => {
    const { host, editor, status, key, palette } = await boot(workspace, `${WS}/Fa30/1-CS101/hw/hw2.tex`);
    await waitFor(() => editor()?.state.doc.toString() === "two");
    editor().dispatch({ selection: { anchor: 3 } });
    type(editor(), "!");
    expect(status()).toContain("●");
    editor().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ...modKey, bubbles: true, cancelable: true }));
    await waitFor(() => host.files.get(`${WS}/Fa30/1-CS101/hw/hw2.tex`) === "two!");
    type(editor(), "?");
    key("k", { metaKey: true });
    await palette("210 hw3");
    await waitFor(() => editor().state.doc.toString() === "math hw3");
    expect(host.files.get(`${WS}/Fa30/1-CS101/hw/hw2.tex`)).toBe("two!?");
  });

  it("a file outside any workspace gets the global snippets", async () => {
    const { editor, status } = await boot({
      "/tmp/loose.tex": "hi",
      [`${GLOBAL_SNIPS}/mine.ts`]: 'import { s } from "texdesk"; export default [s("qq", "Q", { auto: true })];',
    }, "/tmp/loose.tex");
    await waitFor(() => editor()?.state.doc.toString() === "hi");
    await waitFor(() => status().includes("1 snippet"));
  });
});

describe("Phase 2 commands", () => {
  const hw = `${WS}/Fa30/1-CS101/hw/hw2.tex`;
  const files = { ...workspace, [hw]: "\\begin{document}\n\\begin{enumerate}\n  \\item One\n\\end{enumerate}\n\\end{document}" };

  it("Paste as code asks for the language and inserts the clipboard verbatim", async () => {
    const { host, editor, command, palette } = await boot(files, hw);
    host.readClipboardText = async () => "for i in range(3):\n    print(i)";
    await waitFor(() => editor()?.state.doc.length);
    editor().dispatch({ selection: { anchor: editor().state.doc.line(3).to } });
    await command("Paste as code");
    await palette("Python");
    await waitFor(() => editor().state.doc.toString().includes("\\begin{lstlisting}[language=Python]\nfor i in range(3):\n    print(i)\n  \\end{lstlisting}"));
  });

  it("the snippet debug view shows mode, env stack and the last keystroke", async () => {
    const { host, root, editor, command } = await boot({ ...files, [`${SNIPS}/basics.ts`]: fixtureFiles("snippets", ["basics.ts"])[0].code, [`${SNIPS}/shared.ts`]: fixtureFiles("snippets", ["shared.ts"])[0].code }, hw);
    void host;
    await waitFor(() => editor()?.state.doc.length);
    editor().dispatch({ selection: { anchor: editor().state.doc.line(3).to } });
    await command("Snippet debug view");
    await waitFor(() => root.querySelector(".debug"));
    type(editor(), " $");
    type(editor(), "mk");
    await settle(10);
    const text = root.querySelector(".debug")!.textContent!;
    expect(text).toContain("document › enumerate");
    expect(text).toContain('"mk"');
    expect(text).toContain("skipped: mode is inline");
  });
});

describe("Phase 4: builds", () => {
  const hw = `${WS}/Fa30/1-CS101/hw/hw2.tex`;
  const files = {
    ...workspace,
    // These tests cover the automatic export, which is off by default.
    [WSJ]: wsJson({}, { export_pdf: true }),
    [hw]: "\\documentclass{article}\n\\begin{document}\nHello\n\\oops\n\\end{document}",
  };

  async function withCompiler(stderr: string, ok: boolean) {
    const b = await boot(files, hw);
    const calls: string[] = [];
    b.host.compile = async (req) => {
      calls.push(req.file);
      const pdf = ok ? req.file.replace(/\/([^/]+)\.tex$/, "/.build/$1.pdf") : null;
      if (pdf) b.host.files.set(pdf, "%PDF built");
      return { ok, cancelled: false, exitCode: ok ? 0 : 1, stdout: "", stderr, durationMs: 1234, pdf, launchError: null };
    };
    await waitFor(() => b.editor()?.state.doc.length);
    return { ...b, calls };
  }

  it("saving builds after a short delay; success shows the time and exports the PDF", async () => {
    const { host, editor, status, root, calls } = await withCompiler("", true);
    type(editor(), "x");
    editor().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ...modKey, bubbles: true, cancelable: true }));
    await waitFor(() => calls.length === 1, 2000);
    await waitFor(() => status().includes("✓ Built 1.2s"));
    expect(host.files.get(`${WS}/Fa30/1-CS101/hw/CS101_hw2.pdf`)).toBe("%PDF built");
    // The exported PDF is nested under its source in the tree, with a badge.
    await waitFor(() => root.querySelector(".tree-row.generated") || (root.querySelector(".tree-row.active .tree-icon") as HTMLElement)?.click());
    await waitFor(() => root.querySelector(".tree-row.generated"));
    expect(root.querySelector(".tree-row.generated")!.textContent).toContain("CS101_hw2.pdf");
  });

  it("errors show inline in the editor and in the build panel", async () => {
    const { editor, status, root, command } = await withCompiler("error: hw2.tex:4: Undefined control sequence\n", false);
    await command("Save");
    await waitFor(() => status().includes("✗ 1 error"));
    const found: { from: number; message: string }[] = [];
    forEachDiagnostic(editor().state, (d) => found.push({ from: d.from, message: d.message }));
    expect(found).toEqual([{ from: editor().state.doc.line(4).from, message: "Undefined control sequence" }]);
    (root.querySelector(".buildstatus") as HTMLElement).click();
    await waitFor(() => root.querySelector(".buildpanel"));
    expect(root.querySelector(".buildpanel")!.textContent).toContain("hw2.tex:4");
  });

  it("refuses to overwrite the course's PDF and says why", async () => {
    const { host, status, command } = await withCompiler("", true);
    host.files.set(`${WS}/Fa30/1-CS101/hw/CS101_hw2.pdf`, "course handout");
    await command("Save");
    await waitFor(() => status().includes("wasn't copied"));
    expect(host.files.get(`${WS}/Fa30/1-CS101/hw/CS101_hw2.pdf`)).toBe("course handout");
  });

  it("⌘K hides generated PDFs unless you type .pdf", async () => {
    const { root, key, command } = await withCompiler("", true);
    await command("Save");
    await waitFor(() => root.querySelector(".buildstatus.build-ok"));
    await settle(30);
    key("k", { metaKey: true });
    const input = await waitFor(() => root.querySelector<HTMLInputElement>(".pal-input"));
    input.value = "hw2";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle(10);
    const labels = () => [...root.querySelectorAll(".pal-label")].map((e) => e.textContent);
    expect(labels()).not.toContain("CS101_hw2.pdf");
    input.value = "hw2 .pdf";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle(10);
    expect(labels()).toContain("CS101_hw2.pdf");
  });
});

describe("Phase 5: preview", () => {
  const dir = `${WS}/Fa30/1-CS101/hw`;
  const doc = `${dir}/doc.tex`;
  const fixtures = path.join(__dirname, "fixtures");
  const files = {
    ...workspace,
    [doc]: fs.readFileSync(path.join(fixtures, "doc.tex"), "utf8"),
    [`${dir}/.build/doc.pdf`]: "%PDF v1",
    [`${dir}/.build/doc.synctex.gz`]: fs.readFileSync(path.join(fixtures, "doc.synctex"), "utf8").replace("/W/hw/doc.tex", doc),
  };

  async function bootPreview() {
    const b = await boot(files, doc);
    b.host.compile = async (req) => {
      b.host.files.set(`${dir}/.build/doc.pdf`, "%PDF v2");
      return { ok: true, cancelled: false, exitCode: 0, stdout: "", stderr: "", durationMs: 10, pdf: `${dir}/.build/doc.pdf`, launchError: null };
    };
    await waitFor(() => b.editor()?.state.doc.length);
    // The first document opens with its output in a group beside it.
    const [out] = await waitFor(() => b.pdf.viewers.length === 1 && b.pdf.viewers);
    return { ...b, out };
  }
  const tabs = (root: HTMLElement) => [...root.querySelectorAll(".group")].map((g) => [...g.querySelectorAll(".tab")].map((t) => t.querySelector(".tab-name")!.textContent + (t.classList.contains("active") ? "*" : "")));

  it("shows the open document's existing build output beside it", async () => {
    const { out, root } = await bootPreview();
    await waitFor(() => out.loads.length);
    expect(out.loads[0].text).toBe("%PDF v1");
    expect(tabs(root)).toEqual([["doc.tex*"]]);
    expect(pdfPane(root)).not.toBeNull();
  });

  it("reloads after each build, keeping the scroll position", async () => {
    const { out, command } = await bootPreview();
    await waitFor(() => out.loads.length);
    out.current = { page: 2, fraction: 0.4 };
    await command("Save");
    await waitFor(() => out.loads.length === 2);
    expect(out.loads[1]).toEqual({ text: "%PDF v2", anchor: null }); // null = keep the current position
  });

  it("PDFs from the tree open in a tab with the text", async () => {
    const b = await bootPreview();
    const row = await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".tree-row")].find((r) => r.textContent?.includes("hw1.pdf")));
    row.click();
    await waitFor(() => b.pdf.viewers[1]?.loads.length);
    expect(b.pdf.viewers[1].loads[0].text).toBe("%PDF course handout");
    expect(tabs(b.root)).toEqual([["doc.tex", "hw1.pdf*"]]);
  });

  it("⌘⇧J reveals the cursor's line in the PDF", async () => {
    const { editor, key, out } = await bootPreview();
    editor().dispatch({ selection: { anchor: editor().state.doc.line(11).from } });
    key("j", { metaKey: true, shiftKey: true });
    await waitFor(() => out.reveals.length);
    expect(out.reveals[0].page).toBe(2);
  });

  it("after a build, the PDF scrolls (quietly) to the line you edited", async () => {
    const { editor, out, command } = await bootPreview();
    await waitFor(() => out.loads.length);
    editor().dispatch({ selection: { anchor: editor().state.doc.line(11).to } });
    type(editor(), " ");
    await command("Save");
    await waitFor(() => out.quietReveals.length);
    expect(out.quietReveals[0].page).toBe(2);
  });

  it("the Follow editor switch on the PDF turns off double-click and follow-on-edit jumps (saved in your settings)", async () => {
    const b = await bootPreview();
    await waitFor(() => b.out.loads.length);
    const sw = await waitFor(() => b.root.querySelector<HTMLButtonElement>(".pdf-follow"));
    expect(sw.classList.contains("on")).toBe(true);
    sw.click();
    await waitFor(() => JSON.parse(b.host.files.get("/home/.config/texdesk/settings.json") ?? "{}").editor?.follow_edits === false);
    await waitFor(() => !b.root.querySelector(".pdf-follow.on"));
    b.editor().dispatch({ selection: { anchor: b.editor().state.doc.line(11).to } });
    type(b.editor(), " ");
    await b.command("Save");
    await waitFor(() => b.out.loads.length === 2);
    b.editor().contentDOM.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle(50);
    expect(b.out.reveals).toEqual([]);
    // ⌘⇧J still works.
    b.key("j", { metaKey: true, shiftKey: true });
    await waitFor(() => b.out.reveals.length === 1);
  });

  it("an edit in the preamble doesn't move the PDF", async () => {
    const { editor, out, command } = await bootPreview();
    await waitFor(() => out.loads.length);
    editor().dispatch({ selection: { anchor: editor().state.doc.line(2).to } });
    type(editor(), " ");
    await command("Save");
    await waitFor(() => out.loads.length === 2);
    await settle(50);
    expect(out.quietReveals).toEqual([]);
  });

  it("double-clicking a line shows it in the PDF", async () => {
    const { editor, out } = await bootPreview();
    editor().dispatch({ selection: { anchor: editor().state.doc.line(11).from + 1 } });
    editor().contentDOM.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await waitFor(() => out.reveals.length);
    expect(out.reveals[0].page).toBe(2);
    expect(out.quietReveals).toEqual([]); // highlighted, like ⌘⇧J
  });

  it("⌘-click in the PDF jumps to the source line", async () => {
    const { editor, out } = await bootPreview();
    out.onSync!(1, 250, 96);
    await waitFor(() => editor().state.doc.lineAt(editor().state.selection.main.head).number === 6);
  });

  it("⌘⇧P hides and shows the PDF pane, which keeps its place", async () => {
    const { root, key, out } = await bootPreview();
    await waitFor(() => out.loads.length);
    key("p", { metaKey: true, shiftKey: true });
    await waitFor(() => !pdfPane(root));
    key("p", { metaKey: true, shiftKey: true });
    await waitFor(() => pdfPane(root));
    expect(root.querySelectorAll(".group").length).toBe(1);
    expect(out.loads.length).toBe(1); // the same viewer, not reloaded
  });

  it("dragging the PDF pane's edge resizes it; the width is remembered", async () => {
    const { root } = await bootPreview();
    const side = await waitFor(() => pdfPane(root));
    const before = parseInt(side.style.width);
    root.querySelector(".pdf-splitter")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 450 }));
    window.dispatchEvent(new MouseEvent("mouseup", {}));
    expect(parseInt(side.style.width)).toBe(before + 50);
    expect(JSON.parse(localStorage.getItem("texdesk:pdfWidth")!)).toBe(before + 50);
  });

  it("switching documents remembers each one's position", async () => {
    const b = await bootPreview();
    await waitFor(() => b.out.loads.length);
    b.out.current = { page: 2, fraction: 0.5 };
    b.host.files.set(`${dir}/.build/hw1.pdf`, "%PDF hw1");
    b.key("k", { metaKey: true });
    await b.palette("101 hw1.tex");
    await waitFor(() => b.out.loads.some((l) => l.text === "%PDF hw1"));
    b.key("k", { metaKey: true });
    await b.palette("101 doc");
    await waitFor(() => b.out.loads.length >= 3 && b.out.loads[b.out.loads.length - 1].text.startsWith("%PDF v"));
    expect(b.out.loads[b.out.loads.length - 1].anchor).toEqual({ page: 2, fraction: 0.5 });
  });
});

describe("tabs and groups", () => {
  const dir = `${WS}/Fa30/1-CS101/hw`;
  const hw1 = `${dir}/hw1.tex`;
  const hw2 = `${dir}/hw2.tex`;
  const files = { ...workspace, [hw2]: "\\documentclass{article}\nTwo" };
  const tabs = (root: HTMLElement) => [...root.querySelectorAll(".group")].map((g) => [...g.querySelectorAll(".tab")].map((t) => t.querySelector(".tab-name")!.textContent + (t.classList.contains("active") ? "*" : "")));
  const tabEl = (root: HTMLElement, name: string) => waitFor(() => [...root.querySelectorAll<HTMLElement>(".tab")].find((t) => t.querySelector(".tab-name")!.textContent === name));
  const treeRow = (root: HTMLElement, name: string) => waitFor(() => [...root.querySelectorAll<HTMLElement>(".tree-row")].find((r) => r.querySelector(".tree-name")?.textContent === name));
  const fire = (el: Element, type: string) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  const editors = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".cm-editor")].map((e) => EditorView.findFromDOM(e)!);

  it("opening files adds tabs; switching keeps unsaved edits' undo history", async () => {
    const b = await boot(files, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    type(b.editor(), "Z");
    (await treeRow(b.root, "hw2.tex")).click();
    await waitFor(() => tabs(b.root)[0].join() === "hw1.tex,hw2.tex*");
    expect(b.host.files.get(hw1)!.includes("Z")).toBe(true); // saved when you left it
    (await tabEl(b.root, "hw1.tex")).click();
    await waitFor(() => b.editor().state.doc.toString().includes("Z"));
    b.editor().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ...modKey, bubbles: true, cancelable: true }));
    expect(b.editor().state.doc.toString().includes("Z")).toBe(false);
  });

  it("dropping a file on a group's right edge splits it; on a tab bar adds a tab there", async () => {
    const b = await boot(files, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Toggle PDF"); // one group
    await waitFor(() => b.root.querySelectorAll(".group").length === 1);
    fire(await treeRow(b.root, "hw1.pdf"), "dragstart");
    const body = b.root.querySelector(".group-body")!;
    const over = new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 1000 }) as DragEvent;
    // jsdom has no layout: give the body a width so x = 1000 is its right edge.
    (body as HTMLElement).getBoundingClientRect = () => ({ left: 0, width: 1000, right: 1000, top: 0, bottom: 500, height: 500, x: 0, y: 0, toJSON() {} });
    body.dispatchEvent(over);
    expect(b.root.querySelector(".drop-zone.drop-right")).not.toBeNull();
    fire(body, "drop");
    await waitFor(() => tabs(b.root).length === 2);
    expect(tabs(b.root)).toEqual([["hw1.tex*"], ["hw1.pdf*"]]);
    fire(await treeRow(b.root, "hw2.tex"), "dragstart");
    const bar = b.root.querySelectorAll(".tabbar")[1];
    fire(bar, "dragover");
    fire(bar, "drop");
    await waitFor(() => tabs(b.root)[1].includes("hw2.tex*"));
    expect(b.editor().state.doc.toString()).not.toContain("Two"); // the left group still shows hw1
  });

  it("dropping a folder from the tree on a group opens its overview there", async () => {
    const b = await boot(files, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Toggle PDF");
    await waitFor(() => b.root.querySelectorAll(".group").length === 1);
    fire(await treeRow(b.root, "hw"), "dragstart");
    const bar = b.root.querySelector(".tabbar")!;
    fire(bar, "dragover");
    fire(bar, "drop");
    await waitFor(() => b.root.querySelector(".tab.overview .tab-name")?.textContent === "hw");
    await waitFor(() => b.root.querySelector(".overview-pane .ov-h1")?.textContent === "hw");
  });

  it("dragging a tab into another group moves it, and an emptied group closes", async () => {
    const b = await boot(files, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    (await treeRow(b.root, "hw2.tex")).click();
    await waitFor(() => tabs(b.root)[0].includes("hw2.tex*"));
    await b.command("Split editor right");
    await waitFor(() => b.root.querySelectorAll(".group").length === 2);
    fire(await tabEl(b.root, "hw2.tex"), "dragstart");
    const bar = b.root.querySelectorAll(".tabbar")[0];
    fire(bar, "dragover");
    fire(bar, "drop");
    await waitFor(() => b.root.querySelectorAll(".group").length === 1);
    expect(tabs(b.root)).toEqual([["hw1.tex", "hw2.tex*"]]);
  });

  it("two text files side by side: clicking into one makes it current", async () => {
    const b = await boot(files, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    (await treeRow(b.root, "hw2.tex")).click();
    await waitFor(() => tabs(b.root)[0].includes("hw2.tex*"));
    await b.command("Split editor right");
    await waitFor(() => tabs(b.root).some((g) => g.join() === "hw2.tex*"));
    const [left, right] = editors(b.root);
    expect(left.state.doc.toString()).toContain("Text");
    expect(right.state.doc.toString()).toContain("Two");
    left.contentDOM.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await waitFor(() => b.status().includes("hw1.tex"));
    right.contentDOM.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await waitFor(() => b.status().includes("hw2.tex"));
  });

  it("a lone editor group always fills the row, even restored from a layout whose other group is gone", async () => {
    localStorage.setItem(`texdesk:layout:${WS}`, JSON.stringify({
      groups: [{ tabs: [{ kind: "text", path: "Fa30/1-CS101/hw/hw1.tex" }], active: 0, size: 0.5 }, { tabs: [{ kind: "pdf", path: "gone.pdf" }], active: 0, size: 0.5 }],
      activeGroup: 0,
    }));
    localStorage.setItem("texdesk:lastWorkspace", JSON.stringify(WS));
    const b = await boot(workspace);
    await waitFor(() => b.editor()?.state.doc.length);
    const groups = [...b.root.querySelectorAll<HTMLElement>(".group")];
    expect(groups.map((g) => g.style.flexGrow)).toEqual(["1"]);
  });

  it("⌘W closes the tab in front; the layout comes back next time", async () => {
    const b = await boot(files, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    (await treeRow(b.root, "hw2.tex")).click();
    await waitFor(() => tabs(b.root)[0].includes("hw2.tex*"));
    b.key("w", { metaKey: true });
    await waitFor(() => tabs(b.root)[0].join() === "hw1.tex*");
    cleanup.forEach((f) => f());
    cleanup = [];
    const again = await boot(files);
    await waitFor(() => tabs(again.root).length === 1 && pdfPane(again.root));
    expect(tabs(again.root)).toEqual([["hw1.tex*"]]);
    await waitFor(() => again.editor()?.state.doc.toString().includes("Text"));
  });
});

describe("Phase 6: settings", () => {
  const hw = `${WS}/Fa30/1-CS101/hw/hw2.tex`;

  it("shortcuts come from the keys settings and change when workspace.json is saved", async () => {
    const b = await boot(workspace, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => pdfPane(b.root));
    b.key("p", { metaKey: true, shiftKey: true });
    await waitFor(() => !pdfPane(b.root));
    b.host.touch(WSJ, wsJson({}, { keys: { toggle_pdf: "Mod-r" } }));
    await waitFor(() => b.status().includes("Settings reloaded"));
    b.key("p", { metaKey: true, shiftKey: true });
    await settle(30);
    expect(pdfPane(b.root)).toBeNull();
    b.key("r", { metaKey: true });
    await waitFor(() => pdfPane(b.root));
  });

  it("the Settings window saves for this workspace (or globally) and applies at once", async () => {
    const b = await boot(workspace, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Settings");
    const row = (label: string) => waitFor(() => [...b.root.querySelectorAll(".set-row")].find((r) => r.querySelector(".set-label")?.textContent === label) as HTMLElement);
    (await row("Line numbers")).querySelector<HTMLElement>(".set-toggle")!.click();
    await waitFor(() => !b.root.querySelector(".cm-lineNumbers"));
    const font = (await row("Font size")).querySelector<HTMLInputElement>("input")!;
    font.value = "16";
    font.dispatchEvent(new Event("change"));
    const file = () => JSON.parse(b.host.files.get(WSJ)!);
    await waitFor(() => file().settings?.editor?.font_size === 16 && file().settings?.editor?.line_numbers === false);
    // The rest of workspace.json is as it was.
    expect(Object.keys(file().folders)).toEqual(["Fa30", "Fa30/1-CS101", "Fa30/2-MATH210"]);
    // Overridden here: the row says so, and can go back to the global value.
    const reset = await waitFor(() => [...b.root.querySelectorAll(".set-row")].find((r) => r.querySelector(".set-label")?.textContent === "Font size")?.querySelector<HTMLElement>(".set-override"));
    expect(reset.textContent).toContain("this workspace");
    reset.click();
    await waitFor(() => file().settings?.editor?.font_size === undefined);
    // Global: saved in ~/.config/texdesk/settings.json.
    [...b.root.querySelectorAll<HTMLElement>(".set-scope-btn")].find((x) => x.textContent === "Global")!.click();
    const wrap = (await row("Wrap long lines")).querySelector<HTMLElement>(".set-toggle")!;
    wrap.click();
    await waitFor(() => JSON.parse(b.host.files.get("/home/.config/texdesk/settings.json") ?? "{}").editor?.line_wrapping === false);
    await settle(150);
    expect(b.status()).not.toContain("Settings reloaded");
  });

  it("Hotkeys: click a shortcut, press the new keys, and it's live", async () => {
    const b = await boot(workspace, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => pdfPane(b.root));
    await b.command("Settings");
    (await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".set-nav-item")].find((x) => x.textContent === "Hotkeys"))).click();
    const pdfRow = await waitFor(() => [...b.root.querySelectorAll(".set-row")].find((r) => r.querySelector(".set-label")?.textContent === "Toggle PDF") as HTMLElement);
    pdfRow.querySelector<HTMLElement>(".set-key")!.click();
    b.key("r", { metaKey: true });
    await waitFor(() => JSON.parse(b.host.files.get(WSJ)!).settings?.keys?.toggle_pdf === "Mod-r");
    b.key("Escape");
    await waitFor(() => !b.root.querySelector(".set"));
    b.key("r", { metaKey: true });
    await waitFor(() => !pdfPane(b.root));
  });

  it("the palette shows the configured shortcut", async () => {
    const b = await boot({ ...workspace, [WSJ]: wsJson({}, { keys: { toggle_pdf: "Mod-Alt-c" } }) }, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    b.key("k", { metaKey: true, shiftKey: true });
    await waitFor(() => b.root.querySelector(".pal-item"));
    const row = [...b.root.querySelectorAll(".pal-item")].find((r) => r.querySelector(".pal-label")?.textContent === "Toggle PDF")!;
    expect(row.querySelector(".pal-hint")!.textContent).toMatch(/C$/);
  });

  it("theme and editor settings apply live", async () => {
    const b = await boot(workspace, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(b.root.querySelector(".cm-lineNumbers")).toBeTruthy();
    b.host.touch(WSJ, wsJson({}, { editor: { theme: "dark", line_numbers: false } }));
    await waitFor(() => document.documentElement.dataset.theme === "dark");
    await waitFor(() => !b.root.querySelector(".cm-lineNumbers"));
    b.host.touch(WSJ, wsJson());
    await waitFor(() => document.documentElement.dataset.theme === undefined);
  });

  it("bad settings are reported, and the rest still apply", async () => {
    const b = await boot(workspace, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    b.host.touch(WSJ, wsJson({}, { editor: { theme: "neon", line_numbers: false } }));
    await waitFor(() => b.status().includes("editor.theme must be"));
    await waitFor(() => !b.root.querySelector(".cm-lineNumbers"));
  });

  it("there's no build command or setting: documents build on their own, and ⌘S on an unchanged one rebuilds it", async () => {
    const b = await boot(workspace, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    // hw1 has no PDF yet, so opening it builds it; let that build finish before counting builds.
    await waitFor(() => b.root.querySelector(".buildstatus.build-failed"));
    const calls: string[] = [];
    b.host.compile = async (req) => { calls.push(req.file); return { ok: true, cancelled: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1, pdf: null, launchError: null }; };
    b.key("k", { metaKey: true, shiftKey: true });
    await waitFor(() => b.root.querySelector(".pal-item"));
    expect([...b.root.querySelectorAll(".pal-label")].map((e) => e.textContent)).not.toContain("Compile");
    b.key("Escape");
    await b.command("Save");
    await waitFor(() => calls.length === 1);
    await b.command("Settings");
    (await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".set-nav-item")].find((x) => x.textContent === "Build & PDF"))).click();
    const labels = [...b.root.querySelectorAll(".set-label")].map((e) => e.textContent);
    expect(labels).not.toContain("Compile on save");
    expect(labels).not.toContain("Compile as you type");
  });

  it("a never-built document builds when it's opened; a new one from a template builds and opens its PDF", async () => {
    const b = await boot(coursework, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    // hw1 has no PDF yet, so opening it built it (the test host has no compiler, so it fails).
    await waitFor(() => b.root.querySelector(".buildstatus.build-failed"));
    const built: string[] = [];
    b.host.compile = async (req) => { built.push(req.file); return { ok: true, cancelled: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1, pdf: null, launchError: null }; };
    await b.command("Toggle PDF");
    await waitFor(() => !pdfPane(b.root));
    await b.command("New Homework");
    const p = `${WS}/Fa30/1-CS101/hw/hw3.tex`;
    await waitFor(() => built.includes(p));
    await waitFor(() => pdfPane(b.root));
    expect(b.editor().state.doc.toString()).toBe(b.host.files.get(p));
  });

  it("Paste image saves the clipboard image into the folder's figures folder and inserts a figure", async () => {
    const b = await boot(workspace, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    b.host.readClipboardImage = async () => new Uint8Array([137, 80, 78, 71, 1, 2]).buffer;
    b.editor().focus();
    await b.command("Paste image");
    await waitFor(() => b.editor().state.doc.toString().includes("\\includegraphics"));
    const fig = [...b.host.files.keys()].find((f) => f.startsWith(`${WS}/Fa30/1-CS101/figures/hw2-`))!;
    expect(fig).toMatch(/hw2-\d{8}-\d{6}\.png$/);
    expect(b.editor().state.doc.toString()).toContain(`\\includegraphics[width=0.6\\linewidth]{${fig.split("/").pop()}}`);
  });

  it("Paste image with an empty clipboard says so", async () => {
    const b = await boot(workspace, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Paste image");
    await waitFor(() => b.status().includes("no image on the clipboard"));
  });

  it("the math preview renders hw.sty macros, and can be toggled off", async () => {
    const files = { ...workspace, [`${WS}/hw.sty`]: "\\newcommand{\\R}{\\mathbb{R}}", [hw]: "\\documentclass{article}\n\\begin{document}\nLet $x \\in \\R^n$.\n\\end{document}" };
    const b = await boot(files, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    await settle(30);
    b.editor().dispatch({ selection: { anchor: b.editor().state.doc.line(3).from + 8 } });
    const tip = await waitFor(() => document.querySelector(".cm-math-preview"));
    expect(tip.querySelector(".katex-error")).toBe(null); // \R resolved through hw.sty
    expect(tip.textContent).toContain("R");
    await b.command("Toggle math preview");
    await waitFor(() => !document.querySelector(".cm-math-preview"));
  });
});

describe("Phase 7: LaTeX Suite import", () => {
  it("converts a picked data.json into new snippet files that load immediately, without touching the source", async () => {
    const data = JSON.stringify({ snippets: '[\n {trigger: "mk", replacement: "$$0$", options: "tA"},\n {trigger: "ex", replacement: ">[!example] ", options: "t"},\n]' });
    const b = await boot({ ...workspace, "/Obsidian/data.json": data }, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    b.host.pickFile = async () => "/Obsidian/data.json";
    await b.command("Import LaTeX Suite");
    await waitFor(() => b.status().includes("Imported 1 snippets as a new plugin — 1 left as TODO comments"));
    const P = "/home/.config/texdesk/plugins";
    expect(b.host.files.get(`${P}/imported-latex-suite/imported-latex-suite.ts`)).toContain('s("mk", "\\\\($1\\\\)"');
    expect(JSON.parse(b.host.files.get(`${P}/imported-latex-suite/plugin.json`)!).name).toBe("Imported LaTeX Suite snippets");
    expect(b.host.files.get("/Obsidian/data.json")).toBe(data);
    await waitFor(() => b.status().includes("1 snippet"));
    // A second import doesn't overwrite the first.
    await b.command("Import LaTeX Suite");
    await waitFor(() => b.host.files.has(`${P}/imported-latex-suite-2/imported-latex-suite-2.ts`));
    // Opening a global snippet file keeps the workspace open.
    expect(b.root.querySelector(".sidebar")).not.toBe(null);
  });
});

describe("links between files", () => {
  const hw = `${WS}/Fa30/1-CS101/hw/hw2.tex`;
  const note = `${WS}/Fa30/1-CS101/notes/lecture3.tex`;
  const files = {
    ...workspace,
    [hw]: "\\documentclass{article}\n\\begin{document}\nUses \\link{lecture3} and \\href{https://example.com}{a site}.\n\\end{document}",
    [note]: "\\documentclass{article}\n\\begin{document}\nLecture 3\n\\end{document}",
  };

  async function cursorOn(text: string) {
    const b = await boot(files, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    const line = b.editor().state.doc.line(3);
    b.editor().dispatch({ selection: { anchor: line.from + line.text.indexOf(text) } });
    return b;
  }

  it("“Follow link” opens the \\link under the cursor", async () => {
    const { editor, command } = await cursorOn("lecture3");
    await command("Follow link");
    await waitFor(() => editor().state.doc.toString().includes("Lecture 3"));
  });

  it("URLs open in the browser", async () => {
    const { command, host } = await cursorOn("example");
    await command("Follow link");
    await waitFor(() => host.opened.includes("https://example.com"));
  });

  it("dragging the sidebar's edge resizes it, within limits, and the width is remembered", async () => {
    const b = await boot(workspace, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    const bar = await waitFor(() => b.root.querySelector<HTMLElement>(".sidebar"));
    const handle = b.root.querySelector<HTMLElement>(".sidebar-splitter")!;
    expect(bar.style.width).toBe("250px");
    const drag = (dx: number) => {
      handle.dispatchEvent(new MouseEvent("mousedown", { clientX: 250, bubbles: true }));
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 250 + dx }));
      window.dispatchEvent(new MouseEvent("mouseup", {}));
    };
    drag(70);
    expect(bar.style.width).toBe("320px");
    drag(-1000);
    expect(bar.style.width).toBe("160px");
    drag(140);
    cleanup.forEach((f) => f()); cleanup = [];
    document.body.innerHTML = "";
    const again = await boot(workspace, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    const bar2 = await waitFor(() => again.root.querySelector<HTMLElement>(".sidebar"));
    expect(bar2.style.width).toBe("300px");
    again.root.querySelector<HTMLElement>(".sidebar-splitter")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(bar2.style.width).toBe("250px");
  });

  it("the sidebar lists backlinks, which open at the linking line", async () => {
    const { root, editor } = await boot(files, note);
    const row = await waitFor(() => root.querySelector<HTMLElement>(".backlink"));
    expect(row.textContent).toContain("hw2.tex");
    expect(row.textContent).toContain("\\link{lecture3}");
    row.click();
    await waitFor(() => editor().state.doc.toString().includes("Uses"));
    expect(editor().state.doc.lineAt(editor().state.selection.main.head).number).toBe(3);
  });

  it("“Insert link…” inserts a \\link (just the name when it's unique), using the selection as its label", async () => {
    const { editor, command, palette } = await boot(files, note);
    await waitFor(() => editor()?.state.doc.length);
    const line = editor().state.doc.line(3);
    editor().dispatch({ selection: { anchor: line.from, head: line.to } });
    await command("Insert link");
    await palette("hw2");
    expect(editor().state.doc.line(3).text).toBe("\\link[Lecture 3]{hw2}");
  });

  it("typing inside \\link{ suggests files and folders; Enter picks one", async () => {
    const { editor, root } = await boot(files, note);
    await waitFor(() => editor()?.state.doc.length);
    const end = editor().state.doc.line(3).to;
    editor().dispatch({ selection: { anchor: end } });
    type(editor(), " \\link{hw");
    const labels = await waitFor(() => currentCompletions(editor().state).length > 0 && currentCompletions(editor().state).map((c) => c.label));
    // Unique names stay bare; two folders called hw need a path.
    expect(labels).toEqual(expect.arrayContaining(["hw1", "hw2", "../hw", "../../2-MATH210/hw"]));
    await waitFor(() => root.querySelector(".cm-tooltip-autocomplete"));
    editor().dispatch({ effects: setSelectedCompletion(labels.indexOf("hw2")) });
    await settle(100); // the popup ignores keys for a moment after opening
    editor().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(editor().state.doc.line(3).text).toBe("Lecture 3 \\link{hw2}");
  });

  it("[[ searches every file and folder, like Obsidian, and becomes a \\link; [[name|text gives a label", async () => {
    const { editor, root } = await boot(files, note);
    await waitFor(() => editor()?.state.doc.length);
    const pick = async (typed: string) => {
      editor().dispatch({ selection: { anchor: editor().state.doc.line(3).to } });
      type(editor(), typed);
      await waitFor(() => root.querySelector(".cm-tooltip-autocomplete") && currentCompletions(editor().state).length > 0);
      await settle(100);
      editor().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    };
    await pick(" [[101 hw2");
    expect(editor().state.doc.line(3).text).toBe("Lecture 3 \\link{hw2}");
    await pick(" [[math210|Math");
    expect(editor().state.doc.line(3).text).toBe("Lecture 3 \\link{hw2} \\link[Math]{2-MATH210}");
  });

  it("[[ does nothing in math or after \\[", async () => {
    const { editor, root } = await boot(files, note);
    await waitFor(() => editor()?.state.doc.length);
    for (const typed of [" $[[hw", " \\[[hw"]) {
      editor().dispatch({ selection: { anchor: editor().state.doc.line(3).to } });
      type(editor(), typed);
      await settle(100);
      expect(currentCompletions(editor().state).map((c) => c.label)).not.toContain("hw2");
    }
  });

  it("no suggestions outside a link's braces", async () => {
    const { editor, root } = await boot(files, note);
    await waitFor(() => editor()?.state.doc.length);
    editor().dispatch({ selection: { anchor: editor().state.doc.line(3).to } });
    type(editor(), " hw");
    await settle(100);
    expect(root.querySelector(".cm-tooltip-autocomplete")).toBeNull();
  });

  it("clicking a link in the PDF opens the file it points to", async () => {
    const b = await boot({ ...files, [`${WS}/Fa30/1-CS101/hw/.build/hw2.pdf`]: "%PDF" }, hw);
    const [out] = await waitFor(() => b.pdf.viewers.length >= 1 && b.pdf.viewers);
    await waitFor(() => out.loads.length);
    out.onLink!("lecture3");
    await waitFor(() => b.editor().state.doc.toString().includes("Lecture 3"));
  });
});

describe("Save PDF as…", () => {
  const hw = `${WS}/Fa30/1-CS101/hw/hw2.tex`;
  const built = `${WS}/Fa30/1-CS101/hw/.build/hw2.pdf`;
  const dest = `${WS}/Fa30/1-CS101/submitted.pdf`;
  const files = { ...workspace, [hw]: "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}", [built]: "%PDF v1" };

  it("saves a copy that every build updates, until “Stop updating saved PDF”", async () => {
    const b = await boot(files, hw);
    let n = 1;
    b.host.compile = async () => {
      b.host.files.set(built, `%PDF v${++n}`);
      return { ok: true, cancelled: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1, pdf: built, launchError: null };
    };
    const asked: [string, string][] = [];
    b.host.pickSavePdf = async (dir, name) => { asked.push([dir, name]); return dest; };
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Save PDF as");
    await waitFor(() => b.host.files.get(dest) === "%PDF v1");
    expect(asked).toEqual([[`${WS}/Fa30/1-CS101/hw`, "CS101_hw2.pdf"]]);
    const badge = await waitFor(() => [...b.root.querySelectorAll(".tree-row")].find((r) => r.textContent?.includes("submitted.pdf")));
    expect(badge.textContent).toContain("linked");

    await b.command("Save");
    await waitFor(() => b.host.files.get(dest) === "%PDF v2");

    await b.command("Stop updating saved PDF");
    await waitFor(() => b.status().includes("no longer be updated"));
    await b.command("Save");
    await waitFor(() => b.host.files.get(built) === "%PDF v3");
    expect(b.host.files.get(dest)).toBe("%PDF v2");
  });

  it("nothing is copied next to the source by default", async () => {
    const b = await boot(files, hw);
    b.host.compile = async () => ({ ok: true, cancelled: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1, pdf: built, launchError: null });
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Save");
    await waitFor(() => b.root.querySelector(".buildstatus.build-ok"));
    expect([...b.host.files.keys()].filter((f) => f.endsWith(".pdf") && !f.includes(".build"))).toEqual([`${WS}/Fa30/1-CS101/hw/hw1.pdf`]);
  });
});

describe("menus and toolbar", () => {
  const hw = `${WS}/Fa30/1-CS101/hw/hw2.tex`;
  const files = {
    ...workspace,
    [hw]: "\\documentclass{article}\n\\begin{document}\nSee \\link{hw1} here.\n\\end{document}",
    [`${WS}/Fa30/1-CS101/hw/.build/hw2.pdf`]: "%PDF",
  };

  async function bootWithCompiler() {
    const b = await boot(files, hw);
    const calls: string[] = [];
    b.host.compile = async (req) => {
      calls.push(req.file);
      return { ok: true, cancelled: false, exitCode: 0, stdout: "", stderr: "", durationMs: 5, pdf: `${WS}/Fa30/1-CS101/hw/.build/hw2.pdf`, launchError: null };
    };
    await waitFor(() => b.editor()?.state.doc.length);
    return { ...b, calls };
  }

  it("builds a native menu bar whose items run commands, with shortcuts from [keys]", async () => {
    const { host, root, status } = await bootWithCompiler();
    const sections = await waitFor(() => host.menu.sections.length > 0 && host.menu.sections);
    expect(sections.map((s) => s.label)).toEqual(["TeXdesk", "File", "Edit", "View", "Build", "Go", "Window", "Help"]);
    // Plugins live in Settings, not the menu bar.
    const app = JSON.stringify(sections[0].items);
    expect(app).toContain('"settings"');
    expect(app).not.toMatch(/plugins|reload_snippets|import_latex_suite/);
    const togglePdf = () => host.menu.sections.find((s) => s.label === "View")!.items.find((i) => typeof i === "object" && "id" in i && i.id === "toggle_pdf") as { accelerator: string };
    expect(togglePdf()).toEqual({ id: "toggle_pdf", label: "Show/Hide PDF", accelerator: "CmdOrCtrl+Shift+P" });
    expect(host.menu.sections.flatMap((s) => s.items).some((i) => typeof i === "object" && "id" in i && i.id === "compile")).toBe(false);
    host.menu.select("toggle_pdf");
    await waitFor(() => !pdfPane(root));
    // Commands that can't run here say why instead of doing nothing.
    host.menu.select("set_up");
    await waitFor(() => status().includes("needs a folder that isn't set up yet"));
    host.touch(WSJ, wsJson({}, { keys: { toggle_pdf: "Mod-r" } }));
    await waitFor(() => togglePdf().accelerator === "CmdOrCtrl+R", 2000);
  });

  it("a shortcut the page already handled isn't run again by its menu item", async () => {
    const { host, root, key } = await bootWithCompiler();
    await waitFor(() => host.menu.sections.length > 0 && pdfPane(root));
    key("p", { metaKey: true, shiftKey: true });
    host.menu.select("toggle_pdf"); // what macOS would send for the same keystroke
    await settle(100);
    expect(pdfPane(root)).toBeNull();
    await settle(300);
    host.menu.select("toggle_pdf"); // a real menu click later still works
    await waitFor(() => pdfPane(root));
  });

  it("builds don't reopen the PDF pane once you've hidden it", async () => {
    const { root, calls, command, editor } = await bootWithCompiler();
    await command("Toggle PDF");
    await waitFor(() => !pdfPane(root));
    editor().dispatch({ changes: { from: editor().state.doc.length, insert: "\n% edit" } });
    editor().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ...modKey, bubbles: true, cancelable: true }));
    await waitFor(() => calls.length === 1, 2000);
    await command("Save");
    await waitFor(() => calls.length === 2, 2000);
    await settle(50);
    expect(pdfPane(root)).toBeNull();
  });

  it("pausing typing saves and builds", async () => {
    const b = await boot({ ...files, [WSJ]: wsJson({}, { build: { auto_compile_delay_ms: 40 } }) }, hw);
    const calls: string[] = [];
    b.host.compile = async (req) => { calls.push(req.file); return { ok: true, cancelled: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1, pdf: null, launchError: null }; };
    await waitFor(() => b.editor()?.state.doc.length);
    expect(b.root.querySelector(".tb-compile, .tb-auto")).toBeNull(); // no buttons for it
    type(b.editor(), "x");
    await waitFor(() => calls.length === 1, 2000);
    expect(b.host.files.get(hw)).toContain("x");
  });

  it("the tab bar's PDF button shows/hides the PDF", async () => {
    const { root } = await bootWithCompiler();
    const pdfButton = [...root.querySelectorAll<HTMLButtonElement>(".tb-btn")].find((b) => b.textContent?.includes("PDF"))!;
    expect(pdfPane(root)).not.toBeNull();
    pdfButton.click();
    await waitFor(() => !pdfPane(root));
    pdfButton.click();
    await waitFor(() => pdfPane(root));
  });

  function rightClick(el: Element, x = 5, y = 5) {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }
  const menuItems = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>(".ctx-menu-item")];
  const clickItem = async (root: HTMLElement, label: string) => {
    (await waitFor(() => menuItems(root).find((b) => b.firstChild!.textContent!.startsWith(label))))!.click();
    await settle(20);
  };

  it("the editor's right-click menu copies, pastes and offers LaTeX commands", async () => {
    const { root, editor, host } = await bootWithCompiler();
    const line = editor().state.doc.line(3);
    editor().dispatch({ selection: { anchor: line.from, head: line.from + 3 } });
    editor().posAtCoords = () => line.from + 1; // jsdom has no layout: right-click inside the selection keeps it
    rightClick(root.querySelector(".cm-content")!);
    const labels = (await waitFor(() => menuItems(root).length > 0 && menuItems(root))).map((b) => b.firstChild!.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Cut", "Copy", "Paste", "Insert Link…", "Paste as Code…", "Show in PDF", "Command Palette…"]));
    await clickItem(root, "Copy");
    expect(host.clipboard.text).toBe("See");
    expect(root.querySelector(".ctx-menu")).toBeNull();
    editor().posAtCoords = () => editor().state.doc.line(3).to;
    rightClick(root.querySelector(".cm-content")!);
    await clickItem(root, "Paste");
    await waitFor(() => editor().state.doc.line(3).text === "See \\link{hw1} here.See");
  });

  it("right-clicking a link offers to follow it", async () => {
    const { root, editor } = await bootWithCompiler();
    const view = editor();
    const at = view.state.doc.line(3).from + view.state.doc.line(3).text.indexOf("hw1");
    view.posAtCoords = () => at; // jsdom has no layout
    rightClick(root.querySelector(".cm-content")!);
    await clickItem(root, "Follow Link (hw1)");
    await waitFor(() => editor().state.doc.toString().startsWith("\\documentclass{article}\nText"));
  });

  it("the PDF's right-click menu jumps to source and hides the PDF", async () => {
    const { root } = await bootWithCompiler();
    const pane = await waitFor(() => root.querySelector(".pdf-pane"));
    rightClick(pane);
    const labels = (await waitFor(() => menuItems(root).length > 0 && menuItems(root))).map((b) => b.firstChild!.textContent);
    expect(labels).toEqual(["Jump to Source Here", "Show Cursor in PDF", "Open PDF Externally", "Save PDF As…", "Hide PDF"]);
    await clickItem(root, "Hide PDF");
    await waitFor(() => !pdfPane(root));
  });

  it("tabs have a right-click menu", async () => {
    const { root } = await bootWithCompiler();
    rightClick(await waitFor(() => root.querySelector(".tab.text")));
    const labels = (await waitFor(() => menuItems(root).length > 0 && menuItems(root))).map((b) => b.firstChild!.textContent);
    expect(labels).toEqual(["Close", "Close Others", "Close to the Right", "Split Right", "Split Left", "Reveal in Finder", "Copy Path"]);
  });
});

describe("LaTeX suggestions", () => {
  const doc = `${WS}/Fa30/1-CS101/hw/s.tex`;
  const files = {
    ...workspace,
    [`${WS}/hw.sty`]: "\\newcommand{\\R}{\\mathbb{R}}\n\\newtheorem{claim}{Claim}",
    [doc]: "\\documentclass{article}\n\\usepackage{hw}\n\\begin{document}\nText\n\\[ x \\]\n\\end{document}",
  };
  async function at(line: number, col: number | "end" = "end") {
    const b = await boot(files, doc);
    await waitFor(() => b.editor()?.state.doc.length);
    await settle(30); // macros from hw.sty load
    const l = b.editor().state.doc.line(line);
    b.editor().dispatch({ selection: { anchor: col === "end" ? l.to : l.from + col } });
    return b;
  }
  const labels = (v: EditorView) => currentCompletions(v.state).map((c) => c.label);
  async function accept(v: EditorView, label: string) {
    const list = await waitFor(() => labels(v).length > 0 && labels(v));
    v.dispatch({ effects: setSelectedCompletion(list.indexOf(label)) });
    await settle(100); // the popup ignores keys for a moment after opening
    v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }

  it("\\begin{ suggests environments; Enter writes the \\end and goes inside", async () => {
    const { editor } = await at(4);
    type(editor(), "\n\\begin{it");
    await accept(editor(), "itemize");
    expect(editor().state.doc.toString()).toContain("Text\n\\begin{itemize}\n  \\item \n\\end{itemize}");
    const head = editor().state.selection.main.head;
    expect(editor().state.sliceDoc(head - 6, head)).toBe("\\item ");
  });

  it("your \\newtheorem environments are suggested too", async () => {
    const { editor } = await at(4);
    type(editor(), "\n\\begin{cl");
    const list = await waitFor(() => labels(editor()).length > 0 && labels(editor()));
    expect(list).toContain("claim");
  });

  it("\\bo in math suggests \\boxed{} with the cursor inside", async () => {
    const { editor } = await at(5, 4);
    type(editor(), "\\bo");
    await accept(editor(), "boxed");
    const l = editor().state.doc.line(5).text;
    expect(l).toBe("\\[ x\\boxed{} \\]");
    expect(editor().state.sliceDoc(editor().state.selection.main.head - 7, editor().state.selection.main.head + 1)).toBe("\\boxed{}");
  });

  it("math commands in math, text commands in text, and your own macros", async () => {
    const { editor } = await at(5, 4);
    type(editor(), "\\R");
    expect(await waitFor(() => labels(editor()).length > 0 && labels(editor()))).toContain("R");
    const t = await at(4);
    type(t.editor(), " \\textb");
    expect(await waitFor(() => labels(t.editor()).length > 0 && labels(t.editor()))).toContain("textbf");
    const m = await at(5, 4);
    type(m.editor(), "\\textb");
    await settle(150);
    expect(labels(m.editor())).not.toContain("textbf");
  });

  it("Enter after a whole name like \\alpha is just a newline", async () => {
    const { editor } = await at(5, 4);
    type(editor(), "\\alpha");
    await waitFor(() => labels(editor()).includes("alpha"));
    await settle(100);
    editor().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(editor().state.doc.line(5).text).toBe("\\[ x\\alpha");
  });
});

describe("lists in a homework file", () => {
  const hw = `${WS}/Fa30/1-CS101/hw/hw2.tex`;
  const tpl = "\\documentclass[12pt]{article}\n\\usepackage{hw}\n\\begin{document}\n\\hwheader{CS 101}{Problem Set \\#2}{today}\n\n\\begin{enumerate}\n  \\item \n\\end{enumerate}\n\\end{document}\n";
  const enter = (v: EditorView) => v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const list = (v: EditorView) => { const t = v.state.doc.toString(); return t.slice(t.indexOf("\\begin{enumerate}"), t.indexOf("\\end{document}")); };
  const cursorLine = (v: EditorView) => { const l = v.state.doc.lineAt(v.state.selection.main.head); return l.text.slice(0, v.state.selection.main.head - l.from) + "|" + l.text.slice(v.state.selection.main.head - l.from); };

  it("Enter on an \\item line is a plain newline: list helpers aren't built in (a plugin can add them)", async () => {
    const b = await boot({ ...workspace, [hw]: tpl }, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    const v = b.editor();
    v.dispatch({ selection: { anchor: v.state.doc.line(7).to } });
    type(v, "first");
    enter(v);
    expect(list(v)).toBe("\\begin{enumerate}\n  \\item first\n  \n\\end{enumerate}\n");
    expect(cursorLine(v)).toBe("  |");
  });

  it("Enter on the template's empty first item, then \\item from the suggestions", async () => {
    const b = await boot({ ...workspace, [hw]: tpl }, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    const v = b.editor();
    v.dispatch({ selection: { anchor: v.state.doc.line(7).to } });
    enter(v); // a line inside the first item
    type(v, "\\item");
    await waitFor(() => currentCompletions(v.state).some((c) => c.label === "item"));
    expect(currentCompletions(v.state)[0].label).toBe("item"); // first in a list
    await settle(100);
    enter(v);
    expect(cursorLine(v)).toBe("  \\item |");
    expect(list(v)).toBe("\\begin{enumerate}\n  \\item \n  \\item \n\\end{enumerate}\n");
  });
});

describe("keeping up with the disk", () => {
  const hw1 = `${WS}/Fa30/1-CS101/hw/hw1.tex`;
  const names = (root: HTMLElement) => [...root.querySelectorAll(".tree-row .tree-name")].map((e) => e.textContent);

  it("files added or removed outside TeXdesk show up in the tree", async () => {
    const b = await boot(workspace, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    b.host.touch(`${WS}/Fa30/1-CS101/hw/handout.pdf`, "%PDF");
    await waitFor(() => names(b.root).includes("handout.pdf"));
    b.host.touch(`${WS}/Fa30/1-CS101/hw/handout.pdf`, null);
    await waitFor(() => !names(b.root).includes("handout.pdf"));
  });

  it("the open file reloads when it changes on disk, unless you have unsaved edits", async () => {
    const b = await boot(workspace, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    b.host.touch(hw1, "\\documentclass{article}\nChanged elsewhere");
    await waitFor(() => b.editor().state.doc.toString().includes("Changed elsewhere"));
    expect(b.status()).not.toContain("●");
    type(b.editor(), "mine ");
    b.host.touch(hw1, "\\documentclass{article}\nAgain");
    await settle(100);
    expect(b.editor().state.doc.toString()).toContain("mine");
  });

  it("the tab bar's Save PDF button saves a linked copy and shows it under the .tex", async () => {
    const hw2 = `${WS}/Fa30/1-CS101/hw/hw2.tex`;
    const built = `${WS}/Fa30/1-CS101/hw/.build/hw2.pdf`;
    const b = await boot({ ...workspace, [hw2]: "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}", [built]: "%PDF" }, hw2);
    await waitFor(() => b.editor()?.state.doc.length);
    b.host.pickSavePdf = async (dir, name) => `${dir}/${name}`;
    const button = await waitFor(() => b.root.querySelector<HTMLButtonElement>(".tb-save-pdf"));
    expect(button.classList.contains("on")).toBe(false);
    button.click();
    await waitFor(() => b.host.files.has(`${WS}/Fa30/1-CS101/hw/CS101_hw2.pdf`));
    await waitFor(() => button.classList.contains("on"));
    expect(button.title).toContain("Fa30/1-CS101/hw/CS101_hw2.pdf");
    await waitFor(() => names(b.root).includes("CS101_hw2.pdf")); // the .tex row opened to show it
  });
});

describe("fixes for common build errors", () => {
  const hw = `${WS}/Fa30/1-CS101/hw/hw2.tex`;
  const text = "\\documentclass{article}\n\\begin{document}\nLet $x = \\frac{1}{2$.\n\\end{document}";
  const diagnostics = (v: EditorView) => { const out: { message: string; actions: number }[] = []; forEachDiagnostic(v.state, (d) => out.push({ message: d.message, actions: d.actions?.length ?? 0 })); return out; };

  it("a common error gets its fix in the build panel and on the line; Apply fix repairs it", async () => {
    const b = await boot({ ...workspace, [hw]: text }, hw);
    b.host.compile = async () => ({ ok: false, cancelled: false, exitCode: 1, stdout: "", stderr: "error: hw2.tex:3: Missing } inserted\n", durationMs: 1, pdf: null, launchError: null });
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Save");
    await waitFor(() => diagnostics(b.editor()).some((d) => d.actions === 1));
    b.root.querySelector<HTMLButtonElement>(".buildstatus")!.click();
    (await waitFor(() => b.root.querySelector<HTMLButtonElement>(".fix-apply"))).click();
    expect(b.editor().state.doc.line(3).text).toBe("Let $x = \\frac{1}{2}$.");
  });

  it("an error with no built-in fix just shows the error", async () => {
    const b = await boot({ ...workspace, [hw]: text }, hw);
    b.host.compile = async () => ({ ok: false, cancelled: false, exitCode: 1, stdout: "", stderr: "error: hw2.tex:3: Something's wrong--perhaps a missing \\item\n", durationMs: 1, pdf: null, launchError: null });
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Save");
    await waitFor(() => diagnostics(b.editor()).length > 0);
    expect(diagnostics(b.editor()).every((d) => d.actions === 0)).toBe(true);
    expect(b.root.querySelector(".fix-note")).toBeNull();
  });
});

describe("folder overview", () => {
  const C = `${WS}/Fa30/1-CS101`;
  const files = {
    ...coursework,
    [`${C}/notes/intro.tex`]: "\\documentclass{article}\n\\begin{document}\n\\section*{Introduction}\nSee \\link{flows}.\n\\end{document}",
    [`${C}/notes/flows.tex`]: "\\section*{Max Flow}",
  };
  const rows = (root: HTMLElement) => [...root.querySelectorAll(".overview-pane .ov-row .ov-title")].map((e) => e.textContent);
  const heads = (root: HTMLElement) => [...root.querySelectorAll(".overview-pane .ov-group-name")].map((e) => e.textContent);
  async function open(start = `${C}/hw/hw1.tex`, extra: Record<string, string> = {}, times: Record<string, number> = {}) {
    const b = await boot({ ...files, ...extra }, start);
    for (const [p, t] of Object.entries(times)) b.host.times[p] = { created: t, modified: t };
    await waitFor(() => b.editor()?.state.doc.length);
    const crumb = await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".status-crumb")].find((c) => c.textContent === "1-CS101"));
    crumb.click();
    await waitFor(() => b.root.querySelector(".overview-pane .ov-row"));
    return b;
  }

  it("the breadcrumb opens a class overview: every folder's documents, in the class type's order then oldest first, with titles", async () => {
    const b = await open(undefined, {}, { [`${C}/notes/intro.tex`]: 1, [`${C}/notes/flows.tex`]: 2, [`${C}/hw`]: 1, [`${C}/notes`]: 2, [`${C}/figures`]: 3 });
    expect(b.root.querySelector(".ov-h1")!.textContent).toBe("1-CS101");
    expect(b.root.querySelector(".ov-titlebar .ov-kind")!.textContent).toBe("Class");
    expect([...b.root.querySelectorAll(".ov-titlebar .ov-field")].map((x) => x.textContent)).toEqual(["CS 101"]);
    expect(heads(b.root)).toEqual(["notes", "hw", "figures"]);
    expect(rows(b.root)).toEqual(["Introduction", "Max Flow", "data.zip", "hw1.pdf", "hw1.tex", "hw2.tex"]);
    expect([...b.root.querySelectorAll(".overview-pane .ov-new-btn")].map((x) => x.textContent)).toEqual(["New Homework", "New Note"]);
    const tab = [...b.root.querySelectorAll(".tab")].find((x) => x.textContent?.includes("Overview"));
    expect(tab?.textContent).toContain("1-CS101");
    // \link counts: intro links to flows.
    expect([...b.root.querySelectorAll(".ov-links")].map((x) => x.textContent)).toEqual(["↙0 ↗1", "↙1 ↗0"]);
    [...b.root.querySelectorAll<HTMLElement>(".ov-row")].find((r) => r.textContent?.includes("Max Flow"))!.click();
    await waitFor(() => b.editor().state.doc.toString() === "\\section*{Max Flow}");
  });

  it("going to another folder from an overview happens in its tab; ⌘-click opens a new one", async () => {
    const b = await open();
    const names = () => [...b.root.querySelectorAll(".tab.overview .tab-name")].map((x) => x.textContent);
    expect(names()).toEqual(["1-CS101"]);
    b.root.querySelector<HTMLElement>(".ov-up")!.click();
    await waitFor(() => names().join() === "Fa30");
    await waitFor(() => b.root.querySelector(".overview-pane .ov-h1")?.textContent === "Fa30");
    const cls = await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".overview-pane .ov-sub-row, .overview-pane .ov-group-head")].find((x) => x.textContent?.includes("1-CS101")));
    cls.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true, ctrlKey: true }));
    await waitFor(() => names().join() === "Fa30,1-CS101");
  });

  it("the TeX / PDF / Other toggles hide kinds of files, remembered for the folder", async () => {
    const b = await open();
    const kind = (label: string) => [...b.root.querySelectorAll<HTMLElement>(".ov-kind")].find((x) => x.textContent === label)!;
    kind("PDF").click();
    await waitFor(() => !rows(b.root).includes("hw1.pdf"));
    expect(rows(b.root).sort()).toEqual(["Introduction", "Max Flow", "data.zip", "hw1.tex", "hw2.tex"]);
    kind("TeX").click();
    await waitFor(() => rows(b.root).join() === "data.zip");
    expect(kind("TeX").classList.contains("on")).toBe(false);
    expect(JSON.parse(localStorage.getItem(`texdesk:kinds:${WS}:Fa30/1-CS101`)!)).toEqual({ docs: false, pdfs: false, other: true });
    kind("TeX").click();
    kind("PDF").click();
    await waitFor(() => rows(b.root).includes("hw1.pdf"));
    expect(localStorage.getItem(`texdesk:kinds:${WS}:Fa30/1-CS101`)).toBeNull();
  });

  it("⌥↑ and dragging reorder within a folder, saved as its order in workspace.json", async () => {
    const b = await open(undefined, {}, { [`${C}/notes/intro.tex`]: 1, [`${C}/notes/flows.tex`]: 2 });
    const row = (title: string) => [...b.root.querySelectorAll<HTMLElement>(".overview-pane .ov-row")].find((r) => r.querySelector(".ov-title")!.textContent === title)!;
    const folders = () => JSON.parse(b.host.files.get(WSJ)!).folders;
    row("Max Flow").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
    await waitFor(() => JSON.stringify(folders()["Fa30/1-CS101/notes"]?.order) === '["flows.tex","intro.tex"]');
    await waitFor(() => rows(b.root).slice(0, 2).join() === "Max Flow,Introduction");
    // Drag hw2 above hw1.
    row("hw2.tex").dispatchEvent(new Event("dragstart", { bubbles: true }));
    row("hw1.tex").dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY: 0 }));
    row("hw1.tex").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await waitFor(() => JSON.stringify(folders()["Fa30/1-CS101/hw"]?.order) === '["data.zip","hw1.pdf","hw2.tex","hw1.tex"]');
    await waitFor(() => rows(b.root).slice(2, 6).join() === "data.zip,hw1.pdf,hw2.tex,hw1.tex");
    // Reordering the class's folders keeps its type and fields.
    const hwHead = [...b.root.querySelectorAll<HTMLElement>(".ov-group-head")].find((h) => h.textContent?.startsWith("hw"))!;
    hwHead.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }));
    await waitFor(() => JSON.stringify(folders()["Fa30/1-CS101"].order) === '["notes","figures","hw"]');
    expect(folders()["Fa30/1-CS101"]).toMatchObject({ type: "class", fields: { course: "CS 101" } });
    await waitFor(() => heads(b.root).join() === "notes,figures,hw");
  });

  it("renaming a file in TeXdesk keeps its place", async () => {
    const ws = JSON.parse((files as Record<string, string>)[WSJ]);
    ws.folders["Fa30/1-CS101/notes"] = { order: ["flows.tex", "intro.tex"] };
    const b = await open(`${C}/notes/flows.tex`, { [WSJ]: JSON.stringify(ws) });
    const treeRow = await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".tree-row")].find((r) => r.querySelector(".tree-name")?.textContent === "flows.tex"));
    treeRow.click();
    b.root.querySelector<HTMLElement>(".tree")!.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    const input = await waitFor(() => b.root.querySelector<HTMLInputElement>(".tree-input"));
    input.value = "max-flow.tex";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => JSON.stringify(JSON.parse(b.host.files.get(WSJ)!).folders["Fa30/1-CS101/notes"]?.order) === '["max-flow.tex","intro.tex"]');
  });

  it("a class overview links to its term's overview; the term's has no link up", async () => {
    const b = await open();
    const up = await waitFor(() => b.root.querySelector<HTMLButtonElement>(".overview-pane .ov-up"));
    expect(up.textContent).toContain("Fa30");
    up.click();
    const shown = () => [...b.root.querySelectorAll<HTMLElement>(".overview-pane")].find((p) => p.style.display !== "none")!;
    await waitFor(() => shown().querySelector(".ov-h1")?.textContent === "Fa30");
    expect(shown().querySelector(".ov-up")).toBe(null);
  });

  it("a term overview just links to its classes, with their New buttons", async () => {
    const b = await boot(files, `${C}/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Go to overview");
    await b.palette("Fa30");
    await waitFor(() => b.root.querySelector(".ov-h1")?.textContent === "Fa30");
    expect(heads(b.root)).toEqual(expect.arrayContaining(["1-CS101", "2-MATH210"]));
    expect(heads(b.root)).not.toContain("hw");
    expect(rows(b.root)).toEqual([]);
    const math = () => [...b.root.querySelectorAll<HTMLElement>(".ov-group")].find((g) => g.querySelector(".ov-group-name")!.textContent === "2-MATH210")!;
    [...math().querySelectorAll<HTMLElement>(".ov-new-btn")].find((x) => x.textContent === "New Homework")!.click();
    await waitFor(() => b.host.files.has(`${WS}/Fa30/2-MATH210/hw/hw4.tex`));
    // Clicking a class opens its overview.
    const shown = () => [...b.root.querySelectorAll<HTMLElement>(".overview-pane")].find((p) => p.style.display !== "none")!;
    await b.command("Go to overview");
    await b.palette("Fa30");
    await waitFor(() => shown()?.querySelector(".ov-h1")?.textContent === "Fa30");
    [...shown().querySelectorAll<HTMLElement>(".ov-group-head")].find((h) => h.textContent?.startsWith("1-CS101"))!.click();
    await waitFor(() => shown().querySelector(".ov-h1")?.textContent === "1-CS101");
  });

  it("⌘K finds a class by its folder or course name and opens its overview", async () => {
    const b = await boot(files, `${C}/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    b.key("k", { metaKey: true });
    await b.palette("CS 101");
    await waitFor(() => b.root.querySelector(".ov-h1")?.textContent === "1-CS101");
    b.key("k", { metaKey: true });
    const input = await waitFor(() => b.root.querySelector<HTMLInputElement>(".pal-input"));
    input.value = "210";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle(10);
    const first = b.root.querySelector(".pal-item")!;
    expect(first.querySelector(".pal-label")!.textContent).toBe("2-MATH210");
    expect(first.querySelector(".pal-detail")!.textContent).toBe("Overview · Class · Fa30");
  });

  it("hovering a folder in the tree shows a button that opens its overview", async () => {
    const b = await boot(files, `${C}/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    const row = await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".tree-row.dir")].find((r) => r.querySelector(".tree-name")?.textContent === "notes"));
    row.querySelector<HTMLButtonElement>('.tree-overview[title="Open overview"]')!.click();
    await waitFor(() => b.root.querySelector(".ov-h1")?.textContent === "notes");
  });

  it("\\link to a folder (a note's class name) opens that folder's overview", async () => {
    const note = `${C}/notes/flows.tex`;
    const b = await boot({ ...files, [note]: "\\textit{\\link[CS 101]{1-CS101} \\quad today}" }, note);
    await waitFor(() => b.editor()?.state.doc.length);
    b.editor().dispatch({ selection: { anchor: b.editor().state.doc.toString().indexOf("1-CS101") + 2 } });
    await b.command("Follow link");
    await waitFor(() => b.root.querySelector(".ov-h1")?.textContent === "1-CS101");
    expect(b.status()).not.toContain("Nothing found");
  });

  it("the overview tab comes back on the next launch", async () => {
    const a = await open();
    cleanup.forEach((f) => f()); cleanup = [];
    document.body.innerHTML = "";
    const b = await boot(Object.fromEntries(a.host.files));
    await waitFor(() => b.root.querySelector(".ov-h1")?.textContent === "1-CS101");
  });
});

describe("opening overviews from the file tree", () => {
  const hw1 = `${WS}/Fa30/1-CS101/hw/hw1.tex`;
  const treeRow = (root: HTMLElement, name: string) =>
    waitFor(() => [...root.querySelectorAll<HTMLElement>(".tree .tree-row")].find((r) => r.querySelector(".tree-name")?.textContent === name));
  const overviewTabs = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".tab.overview")].map((t) => `${t.querySelector(".tab-name")!.textContent}${t.classList.contains("preview") ? " (preview)" : ""}`);
  /** How many rows named "hw" are on screen (each class's hw/ shows once the class is open). */
  const hws = (b: { tree: () => (string | null)[] }) => b.tree().filter((n) => n === "hw").length;
  const shown = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".overview-pane")].find((p) => p.style.display !== "none");

  it("clicking a folder's name shows its overview as a preview and opens it; the next folder replaces it", async () => {
    const b = await boot(coursework, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    (await treeRow(b.root, "2-MATH210")).click();
    await waitFor(() => shown(b.root)?.querySelector(".ov-h1")?.textContent === "2-MATH210");
    expect(overviewTabs(b.root)).toEqual(["2-MATH210 (preview)"]);
    expect(hws(b)).toBe(2); // it opened in the tree
    // Clicking it again doesn't close it in the tree; another folder replaces the preview.
    (await treeRow(b.root, "2-MATH210")).click();
    await settle(20);
    expect(hws(b)).toBe(2);
    (await treeRow(b.root, "hw")).click();
    await waitFor(() => overviewTabs(b.root).join() === "hw (preview)");
    // The text tab is still there behind it.
    expect([...b.root.querySelectorAll(".tab.text .tab-name")].map((x) => x.textContent)).toEqual(["hw1.tex"]);
  });

  it("the arrow only opens and closes; double-clicking keeps the overview open", async () => {
    const b = await boot(coursework, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    const math = await treeRow(b.root, "2-MATH210");
    math.querySelector<HTMLElement>(".tree-chevron")!.click();
    await waitFor(() => hws(b) === 2);
    math.querySelector<HTMLElement>(".tree-chevron")!.click();
    await waitFor(() => hws(b) === 1);
    expect(overviewTabs(b.root)).toEqual([]);
    const cse = await treeRow(b.root, "1-CS101");
    cse.click();
    cse.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await waitFor(() => overviewTabs(b.root).join() === "1-CS101");
    (await treeRow(b.root, "2-MATH210")).click();
    await waitFor(() => overviewTabs(b.root).join() === "1-CS101,2-MATH210 (preview)");
    // Double-clicking the tab keeps it too; editing a preview's layout keeps it as well.
    b.root.querySelector<HTMLElement>(".tab.overview.preview")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await waitFor(() => overviewTabs(b.root).join() === "1-CS101,2-MATH210");
    (await treeRow(b.root, "notes")).click();
    await waitFor(() => overviewTabs(b.root).includes("notes (preview)"));
    shown(b.root)!.querySelector<HTMLElement>(".ov-edit-btn")!.click();
    await waitFor(() => overviewTabs(b.root).includes("notes"));
  });

  it("with the setting “Only opens it in the tree”, clicking a folder just opens and closes it", async () => {
    const b = await boot({ ...coursework, [WSJ]: wsJson({ templates: COURSEWORK.templates }, { folder_click: "expand" }) }, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    (await treeRow(b.root, "2-MATH210")).click();
    await waitFor(() => hws(b) === 2);
    (await treeRow(b.root, "2-MATH210")).click();
    await waitFor(() => hws(b) === 1);
    expect(overviewTabs(b.root)).toEqual([]);
  });

  it("the workspace's name opens its home page, whose layout can be edited like any other", async () => {
    const b = await boot(coursework, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    b.root.querySelector<HTMLElement>(".sidebar-name")!.click();
    await waitFor(() => shown(b.root)?.querySelector(".ov-h1")?.textContent === "School");
    expect(b.root.querySelector(".tab.overview .tab-detail")!.textContent).toBe("Home");
    expect([...shown(b.root)!.querySelectorAll(".ov-group-name")].map((x) => x.textContent)).toContain("Fa30");
    expect(shown(b.root)!.querySelector(".ov-pin-btn")).toBe(null);
    shown(b.root)!.querySelector<HTMLElement>(".ov-edit-btn")!.click();
    [...shown(b.root)!.querySelectorAll<HTMLElement>(".ov-editor-add .ov-new-btn")].find((x) => x.textContent === "Subfolders")!.click();
    await waitFor(() => JSON.parse(b.host.files.get(WSJ)!).folders[""]?.overview);
    const key = JSON.parse(b.host.files.get(WSJ)!).folders[""].overview;
    expect(JSON.parse(b.host.files.get(WSJ)!).overviews[key].blocks.map((x: { type: string }) => x.type)).toEqual(["header", "templates", "files", "subfolders"]);
    // The home tab comes back on the next launch.
    const files = Object.fromEntries(b.host.files);
    cleanup.forEach((f) => f()); cleanup = []; document.body.innerHTML = "";
    const c = await boot(files);
    await waitFor(() => c.root.querySelector(".tab.overview .tab-detail")?.textContent === "Home");
  });

  it("folders can be pinned above the tree; pins follow renames", async () => {
    const b = await boot(coursework, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    (await treeRow(b.root, "2-MATH210")).click();
    await waitFor(() => shown(b.root)?.querySelector(".ov-pin-btn"));
    shown(b.root)!.querySelector<HTMLElement>(".ov-pin-btn")!.click();
    const pinnedNames = () => [...b.root.querySelectorAll(".pinned-row .tree-name")].map((x) => x.textContent);
    await waitFor(() => pinnedNames().join() === "2-MATH210");
    expect(shown(b.root)!.querySelector(".ov-pin-btn")!.textContent).toBe("Pinned");
    // From the tree's menu too.
    (await treeRow(b.root, "1-CS101")).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    (await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".ctx-menu-item")].find((x) => x.firstChild!.textContent === "Pin to Sidebar"))).click();
    await waitFor(() => pinnedNames().join() === "2-MATH210,1-CS101");
    // A pinned folder opens its overview (a tab that stays).
    b.root.querySelector<HTMLElement>(".pinned-row")!.click();
    await waitFor(() => overviewTabs(b.root).includes("2-MATH210"));
    // Renamed in TeXdesk: the pin follows.
    (await treeRow(b.root, "2-MATH210")).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    (await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".ctx-menu-item")].find((x) => x.firstChild!.textContent === "Rename…"))).click();
    const input = await waitFor(() => b.root.querySelector<HTMLInputElement>(".tree-input"));
    input.value = "MATH210";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => pinnedNames().join() === "MATH210,1-CS101");
    b.root.querySelector<HTMLElement>(".pinned-row .tree-add")!.click();
    await waitFor(() => pinnedNames().join() === "1-CS101");
  });

  it("⌥⌘O opens the open file's class overview; from an overview it goes up a level", async () => {
    const b = await boot(coursework, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    b.key("o", { metaKey: true, altKey: true });
    await waitFor(() => shown(b.root)?.querySelector(".ov-h1")?.textContent === "1-CS101");
    b.key("o", { metaKey: true, altKey: true });
    await waitFor(() => shown(b.root)?.querySelector(".ov-h1")?.textContent === "Fa30");
    b.key("o", { metaKey: true, altKey: true });
    await waitFor(() => shown(b.root)?.querySelector(".ov-h1")?.textContent === "School");
    expect(b.root.querySelector(".tb-overview")).toBeTruthy();
  });

  it("the tree works from the keyboard: ↑↓ move, → / ← open and close, ⌘↓ opens", async () => {
    const b = await boot(coursework, hw1);
    await waitFor(() => b.editor()?.state.doc.length);
    const tree = b.root.querySelector<HTMLElement>(".tree")!;
    const press = (key: string, mods: KeyboardEventInit = {}) => tree.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
    const selected = () => b.root.querySelector(".tree-row.selected .tree-name")?.textContent;
    await waitFor(() => selected() === "hw1.tex");
    press("ArrowUp");
    expect(selected()).toBe("hw1.pdf");
    press("ArrowLeft"); // to its folder
    expect(selected()).toBe("hw");
    press("ArrowLeft"); // close it
    await waitFor(() => !b.tree().includes("hw1.tex"));
    press("ArrowRight");
    await waitFor(() => b.tree().includes("hw1.tex"));
    press("ArrowDown", { metaKey: true });
    await waitFor(() => shown(b.root)?.querySelector(".ov-h1")?.textContent === "hw");
  });
});

describe("starters, folder types and layouts", () => {
  const W = "/Plain";
  const files = {
    [`${W}/.texdesk/workspace.json`]: JSON.stringify({ version: 1, templates: { article: { label: "Document", body: "article.tex" } } }),
    [`${W}/.texdesk/templates/article.tex`]: "\\documentclass{article}",
    [`${W}/Fa30/1-CS101/hw/hw1.tex`]: "\\documentclass{article}",
    [`${W}/Fa30/1-CS101/figures/.keep`]: "",
    [`${W}/misc/x.tex`]: "",
  };
  const wsOf = (b: { host: { files: Map<string, string> } }) => JSON.parse(b.host.files.get(`${W}/.texdesk/workspace.json`)!);
  const menu = async (b: { root: HTMLElement }, name: string, item: string) => {
    const row = await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".tree-row")].find((r) => r.querySelector(".tree-name")?.textContent === name));
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    (await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".ctx-menu-item")].find((x) => x.firstChild!.textContent === item))).click();
  };

  it("applying the Coursework starter adds its types and templates; typed folders then get New Homework", async () => {
    const b = await boot(files, `${W}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Apply a starter");
    await b.palette("Coursework");
    // The starter's Document template differs from this one: keep it.
    await waitFor(() => b.root.querySelector(".pal-title")?.textContent === "This workspace already has template article");
    await b.palette("Keep mine");
    await waitFor(() => b.status().includes("Added the Coursework starter"));
    expect(Object.keys(wsOf(b).folderTypes)).toEqual(["term", "class"]);
    expect(Object.keys(wsOf(b).templates)).toEqual(["article", "homework", "note"]);
    expect(b.host.files.get(`${W}/.texdesk/templates/article.tex`)).toBe("\\documentclass{article}"); // kept
    expect(b.host.files.get(`${W}/.texdesk/templates/homework.tex`)).toContain("Problem Set");
    await menu(b, "Fa30", "Set Folder Type…");
    await b.palette("Term");
    await waitFor(() => wsOf(b).folders.Fa30?.type === "term");
    await menu(b, "1-CS101", "Set Folder Type…");
    await b.palette("Class");
    await b.palette("CS101");
    await b.palette("CS 101");
    await waitFor(() => wsOf(b).folders["Fa30/1-CS101"]?.fields?.course === "CS 101");
    await b.command("New Homework");
    await waitFor(() => b.host.files.get(`${W}/Fa30/1-CS101/hw/hw2.tex`)?.includes("\\textbf{Course:} CS 101"));
  });

  it("applying a starter again asks before replacing what you've changed", async () => {
    const ws = JSON.parse(files[`${W}/.texdesk/workspace.json`]);
    ws.folderTypes = { class: { label: "My class" } };
    const b = await boot({ ...files, [`${W}/.texdesk/workspace.json`]: JSON.stringify(ws) }, `${W}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Apply a starter");
    await b.palette("Coursework");
    await waitFor(() => b.root.querySelector(".pal-title")?.textContent?.includes("already has folder type class"));
    await b.palette("Keep mine");
    await waitFor(() => wsOf(b).folderTypes.term);
    expect(wsOf(b).folderTypes.class.label).toBe("My class");
  });

  it("Edit layout: blocks can be added, configured and removed; the type's folders all change", async () => {
    const ws = {
      version: 1,
      folderTypes: { class: { label: "Class", overview: "class" } },
      folders: { "Fa30/1-CS101": { type: "class" }, "Wi31/CS201": { type: "class" } },
      overviews: { class: { blocks: [{ type: "header" }, { type: "files" }] } },
    };
    const b = await boot({ ...files, [`${W}/.texdesk/workspace.json`]: JSON.stringify(ws), [`${W}/Wi31/CS201/hw/a.tex`]: "" }, `${W}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    await menu(b, "1-CS101", "Open Overview");
    await waitFor(() => b.root.querySelector(".ov-h1")?.textContent === "1-CS101");
    (await waitFor(() => b.root.querySelector<HTMLElement>(".ov-edit-btn"))).click();
    expect(b.root.querySelector(".ov-editor-note")!.textContent).toContain("this folder and 1 other");
    [...b.root.querySelectorAll<HTMLElement>(".ov-editor-add .ov-new-btn")].find((x) => x.textContent === "Files")!.click();
    await waitFor(() => wsOf(b).overviews.class.blocks.length === 3);
    const title = await waitFor(() => [...b.root.querySelectorAll(".ov-set-row")].find((r) => r.textContent?.startsWith("Title"))?.querySelector<HTMLInputElement>("input"));
    title.value = "Recent";
    title.dispatchEvent(new Event("change"));
    const days = await waitFor(() => [...b.root.querySelectorAll(".ov-set-row")].find((r) => r.textContent?.startsWith("Edited in the last"))?.querySelector<HTMLInputElement>("input"));
    days.value = "7";
    days.dispatchEvent(new Event("change"));
    await waitFor(() => wsOf(b).overviews.class.blocks[2].modifiedDays === 7);
    expect(wsOf(b).overviews.class.blocks[2]).toEqual({ type: "files", title: "Recent", modifiedDays: 7 });
    // Remove the header.
    b.root.querySelector<HTMLElement>(".ov-editor-block .set-icon[title='Remove']")!.click();
    await waitFor(() => wsOf(b).overviews.class.blocks[0].type === "files");
    b.root.querySelector<HTMLElement>(".ov-edit-btn")!.click();
    await waitFor(() => [...b.root.querySelectorAll(".ov-block-title")].some((x) => x.textContent === "Recent"));
    expect(b.root.querySelector(".ov-h1")).toBe(null);
  });

  it("a Header block links to any file or folder: added in the layout editor, ./ relative to the folder", async () => {
    const ws = {
      version: 1,
      folderTypes: { class: { label: "Class", overview: "class" } },
      folders: { "Fa30/1-CS101": { type: "class" } },
      overviews: { class: { blocks: [{ type: "header", links: ["./hw/hw1.tex", "Wi31", "gone.tex"] }] } },
    };
    const b = await boot({ ...files, [`${W}/.texdesk/workspace.json`]: JSON.stringify(ws), [`${W}/Wi31/x.tex`]: "" }, `${W}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    await menu(b, "1-CS101", "Open Overview");
    const links = () => [...b.root.querySelectorAll<HTMLButtonElement>(".ov-hlink")];
    await waitFor(() => links().length === 3);
    expect(links().map((l) => [l.textContent, l.disabled])).toEqual([["hw1", false], ["Wi31", false], ["gone", true]]);
    links()[1].click();
    await waitFor(() => [...b.root.querySelectorAll(".ov-h1")].some((h) => h.textContent === "Wi31"));
    // Adding one in the editor.
    await menu(b, "1-CS101", "Open Overview");
    const page = await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".overview-pane")].find((x) => x.style.display !== "none" && x.querySelector(".ov-h1")?.textContent === "1-CS101"));
    (await waitFor(() => page.querySelector<HTMLElement>(".ov-edit-btn"))).click();
    (await waitFor(() => page.querySelector<HTMLElement>(".ov-editor-block"))).click();
    // Choose… picks from the workspace's files and folders.
    (await waitFor(() => [...page.querySelectorAll<HTMLElement>(".ov-picker .set-button")].find((x) => x.textContent === "Choose…"))).click();
    await b.palette("Wi31 x", true);
    await waitFor(() => wsOf(b).overviews.class.blocks[0].links.length === 4);
    expect(wsOf(b).overviews.class.blocks[0].links[3]).toBe("Wi31/x.tex");
    // Or a path typed in.
    const add = page.querySelector<HTMLInputElement>(".ov-picker input.set-input")!;
    add.value = "./hw/";
    add.dispatchEvent(new Event("change"));
    await waitFor(() => wsOf(b).overviews.class.blocks[0].links.length === 5);
    expect(wsOf(b).overviews.class.blocks[0].links.slice(3)).toEqual(["Wi31/x.tex", "./hw"]);
  });

  it("Customize for this folder only gives it its own copy of the layout", async () => {
    const ws = {
      version: 1,
      folderTypes: { class: { label: "Class", overview: "class" } },
      folders: { "Fa30/1-CS101": { type: "class" }, "Wi31/CS201": { type: "class" } },
      overviews: { class: { blocks: [{ type: "header" }, { type: "files" }] } },
    };
    const b = await boot({ ...files, [`${W}/.texdesk/workspace.json`]: JSON.stringify(ws), [`${W}/Wi31/CS201/hw/a.tex`]: "" }, `${W}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    await menu(b, "1-CS101", "Open Overview");
    (await waitFor(() => b.root.querySelector<HTMLElement>(".ov-edit-btn"))).click();
    [...b.root.querySelectorAll<HTMLElement>(".ov-editor-note .set-link")].find((x) => x.textContent === "Customize for this folder only")!.click();
    await waitFor(() => wsOf(b).folders["Fa30/1-CS101"].overview);
    const own = wsOf(b).folders["Fa30/1-CS101"].overview;
    expect(wsOf(b).overviews[own]).toEqual({ blocks: [{ type: "header" }, { type: "files" }] });
    await waitFor(() => b.root.querySelector(".ov-editor-note")?.textContent?.includes("Only this folder uses this layout"));
    b.root.querySelector<HTMLElement>(".ov-editor-block .set-icon[title='Remove']")!.click();
    await waitFor(() => wsOf(b).overviews[own].blocks.length === 1);
    expect(wsOf(b).overviews.class.blocks.length).toBe(2);
    [...b.root.querySelectorAll<HTMLElement>(".ov-editor-note .set-link")].find((x) => x.textContent?.startsWith("Use its type's layout"))!.click();
    await waitFor(() => !wsOf(b).folders["Fa30/1-CS101"].overview);
    expect(wsOf(b).overviews[own]).toBeUndefined();
  });

  it("a Subfolders block lists typed folders with counts, or shows each in full", async () => {
    const ws = {
      version: 1,
      folderTypes: { term: { label: "Term", overview: "term", children: ["class"] }, class: { label: "Class" } },
      folders: { Fa30: { type: "term" }, "Fa30/1-CS101": { type: "class", fields: { course: "CS 101" } } },
      overviews: { term: { blocks: [{ type: "header" }, { type: "subfolders", counts: ["hw"] }] } },
    };
    const b = await boot({ ...files, [`${W}/.texdesk/workspace.json`]: JSON.stringify(ws) }, `${W}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.editor()?.state.doc.length);
    await menu(b, "Fa30", "Open Overview");
    await waitFor(() => b.root.querySelector(".ov-h1")?.textContent === "Fa30");
    const row = await waitFor(() => b.root.querySelector<HTMLElement>(".ov-sub-row"));
    expect(row.textContent).toContain("1-CS101");
    expect(row.textContent).toContain("CS 101");
    expect(row.querySelector(".ov-counts")!.textContent).toBe("hw 1");
    row.click();
    const shown = () => [...b.root.querySelectorAll<HTMLElement>(".overview-pane")].find((p) => p.style.display !== "none");
    await waitFor(() => shown()?.querySelector(".ov-h1")?.textContent === "1-CS101");
  });

  it("an upgrade from the old setup files is offered once, and keeps everything working", async () => {
    const old = {
      [`${W}/.texdesk/config.toml`]: '[vars]\nauthor = "Ada"\n',
      [`${W}/.texdesk/templates/homework.tex`]: '%% label = "Homework"\n%% in = "course"\n%% dir = "hw"\n%% name = "hw{{n}}.tex"\n% {{course}} by {{author}} #{{n}}\n',
      [`${W}/Fa30/1-CS101/.texdesk.toml`]: 'kind = "course"\nfigures_dir = "figures"\n[vars]\ncourse = "CS 101"',
      [`${W}/Fa30/1-CS101/hw/hw1.tex`]: "\\documentclass{article}",
    };
    const b = await boot(old, `${W}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.root.querySelector(".pal-title")?.textContent?.includes("Upgrade to one workspace.json?"));
    expect(b.root.querySelector(".pal-item .pal-detail")!.textContent).toContain("1 folder type (Course), 1 folder, 1 template");
    await b.palette("Upgrade now");
    await waitFor(() => b.status().includes("Upgraded Plain to workspace.json"));
    expect(b.host.files.has(`${W}/.texdesk/config.toml`)).toBe(false);
    expect(b.host.trashed).toEqual(expect.arrayContaining([`${W}/.texdesk/config.toml`, `${W}/Fa30/1-CS101/.texdesk.toml`]));
    expect(wsOf(b).settings).toEqual({ vars: { author: "Ada" } });
    await b.command("New Homework");
    await waitFor(() => b.host.files.get(`${W}/Fa30/1-CS101/hw/hw2.tex`) === "% CS 101 by Ada #2\n");
  });

  it("folders that moved outside TeXdesk can be found again", async () => {
    const ws = { version: 1, folderTypes: { class: { label: "Class" } }, folders: { "Fa30/CS101": { type: "class", fields: { course: "CS 101" } } } };
    const b = await boot({ ...files, [`${W}/.texdesk/workspace.json`]: JSON.stringify(ws) }, `${W}/Fa30/1-CS101/hw/hw1.tex`);
    await waitFor(() => b.root.querySelector(".pal-title")?.textContent?.includes("is gone"));
    await b.palette("Find where they went");
    await b.palette("1-CS101");
    await waitFor(() => wsOf(b).folders["Fa30/1-CS101"]);
    expect(wsOf(b).folders).toEqual({ "Fa30/1-CS101": { type: "class", fields: { course: "CS 101" } } });
  });
});

describe("plugins", () => {
  const U = "/home/.config/texdesk/plugins";
  const hw = `${WS}/Fa30/1-CS101/hw/hw2.tex`;
  const open = async (extra: Record<string, string> = {}) => {
    const b = await boot({ ...workspace, ...extra }, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    await b.command("Plugins");
    await waitFor(() => b.root.querySelector(".plg"));
    return b;
  };
  const pluginRow = (b: { root: HTMLElement }, name: string) => waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".plg-row")].find((r) => r.querySelector(".set-label")?.textContent?.startsWith(name)));

  it("Settings → Plugins lists yours and the built-in ones; a built-in one can be turned on", async () => {
    const b = await open({
      [`${U}/latex-snippets/plugin.json`]: '{ "name": "LaTeX snippets" }',
      [`${U}/latex-snippets/b.ts`]: 'import { s } from "texdesk"; export default [s("qq", "Q", { auto: true })];',
      [`${U}/latex-snippets/a-functions.ts`]: "export const fn1 = () => 1;",
    });
    expect([...b.root.querySelectorAll(".plg-row .set-label")].map((x) => x.firstChild!.textContent!.trim())).toEqual(["LaTeX snippets", "Gilles Castel's snippets", "Markdown shortcuts", "Bullet lists", "Matrix & align keys", "TikZ diagrams"]);
    expect((await pluginRow(b, "LaTeX snippets")).textContent).toContain("1 snippet");
    // Open goes to the main file, not a helper that sorts first.
    [...(await pluginRow(b, "LaTeX snippets")).querySelectorAll<HTMLElement>(".plg-links .set-link")].find((x) => x.textContent === "Open")!.click();
    await waitFor(() => b.editor()?.state.doc.toString().includes('s("qq"'));
    await b.command("Plugins");
    // This workspace's on/off is a choice; switch to Global for the plain switch.
    [...b.root.querySelectorAll<HTMLElement>(".set-scope-btn")].find((x) => x.textContent === "Global")!.click();
    (await pluginRow(b, "Bullet lists")).querySelector<HTMLElement>(".set-toggle")!.click();
    await waitFor(() => JSON.parse(b.host.files.get("/home/.config/texdesk/settings.json") ?? "{}").plugins?.["bullet-lists"] === true);
    await waitFor(() => [...b.root.querySelectorAll(".plg-row")].find((r) => r.querySelector(".set-label")?.textContent?.startsWith("Bullet lists"))?.textContent?.includes("1 snippet"));
  });

  it("a plugin can be turned off for just this workspace", async () => {
    const b = await open({ [`${U}/latex-snippets/a.ts`]: 'import { s } from "texdesk"; export default [s("qq", "Q", { auto: true })];' });
    const sel = (await pluginRow(b, "latex-snippets")).querySelector<HTMLSelectElement>("select")!;
    sel.value = "off";
    sel.dispatchEvent(new Event("change"));
    await waitFor(() => JSON.parse(b.host.files.get(WSJ)!).settings?.plugins?.["latex-snippets"] === false);
    await waitFor(() => b.status().includes("0 snippets"));
  });

  it("Duplicate to edit copies a built-in plugin into yours, where it replaces the built-in one", async () => {
    const b = await open();
    [...(await pluginRow(b, "Bullet lists")).querySelectorAll<HTMLElement>(".set-link")].find((x) => x.textContent === "Duplicate to edit")!.click();
    await waitFor(() => b.host.files.has(`${U}/bullet-lists/bullet-lists.ts`));
    await waitFor(() => b.editor()?.state.doc.toString().includes("Bullet lists"));
    await b.command("Plugins");
    await waitFor(() => [...b.root.querySelectorAll(".plg-row.plg-replaced .set-label")].some((x) => x.textContent?.startsWith("Bullet lists")));
    expect((await pluginRow(b, "Bullet lists")).textContent).toContain("1 snippet"); // yours, on
  });

  it("while a plugin's file is open, the sidebar lists all its files, with counts, and can add one", async () => {
    const b = await open({
      [`${U}/latex-snippets/plugin.json`]: '{ "name": "LaTeX Suite snippets" }',
      [`${U}/latex-snippets/main.ts`]: 'import { s } from "texdesk"; import { fn1 } from "./main-functions"; export default [s("qq", "Q", { auto: true }), s("ww", "W", { auto: true })];',
      [`${U}/latex-snippets/main-functions.ts`]: "export const fn1 = () => 1;",
      [`${U}/latex-snippets/keys.ts`]: 'import { key } from "texdesk"; export const keys = [key("Tab", () => false)];',
    });
    [...(await pluginRow(b, "LaTeX Suite snippets")).querySelectorAll<HTMLElement>(".plg-links .set-link")].find((x) => x.textContent === "Open")!.click();
    await waitFor(() => b.editor()?.state.doc.toString().includes('s("qq"'));
    const rows = () => [...b.root.querySelectorAll(".plugin-panel .plugin-file")].map((r) => `${r.querySelector(".tree-name")!.textContent}: ${r.querySelector(".plugin-file-detail")!.textContent}${r.classList.contains("active") ? " *" : ""}`);
    await waitFor(() => rows().length === 4);
    expect(b.root.querySelector(".plugin-title")!.textContent).toBe("Plugin · LaTeX Suite snippets");
    expect(rows()).toEqual(["keys.ts: 1 key", "main-functions.ts: helpers", "main.ts: 2 snippets *", "plugin.json: name, description"]);
    // The workspace's tree is still there underneath.
    expect(b.tree()).toContain("Fa30");
    [...b.root.querySelectorAll<HTMLElement>(".plugin-panel .plugin-file")].find((r) => r.textContent?.startsWith("keys.ts"))!.click();
    await waitFor(() => b.editor()?.state.doc.toString().includes('key("Tab"'));
    b.root.querySelector<HTMLElement>(".plugin-head .tree-add")!.click();
    await b.palette("greek");
    await waitFor(() => b.host.files.has(`${U}/latex-snippets/greek.ts`));
    await waitFor(() => rows().includes("greek.ts:  *") || rows().some((r) => r.startsWith("greek.ts") && r.endsWith("*")));
    // Back in a workspace file, the panel goes away.
    b.key("k", { metaKey: true });
    await b.palette("101 hw2");
    await waitFor(() => !b.root.querySelector(".plugin-panel"));
  });

  it("New plugin makes a folder with a starter file and opens it", async () => {
    const b = await open();
    [...b.root.querySelectorAll<HTMLElement>(".plg-actions .set-button")].find((x) => x.textContent === "New plugin…")!.click();
    await b.palette("Greek letters");
    await waitFor(() => b.host.files.has(`${U}/greek-letters/snippets.ts`));
    expect(JSON.parse(b.host.files.get(`${U}/greek-letters/plugin.json`)!).name).toBe("Greek letters");
    await waitFor(() => b.editor()?.state.doc.toString().includes("export default snippets"));
  });

  it("your old global snippets become the LaTeX snippets plugin on first launch", async () => {
    const b = await boot({ ...workspace, "/home/.config/texdesk/snippets/mine.ts": 'import { s } from "texdesk"; export default [s("qq", "Q", { auto: true })];', "/home/.config/texdesk/snippets/README.md": "" }, hw);
    await waitFor(() => b.editor()?.state.doc.length);
    expect(b.host.files.get(`${U}/latex-snippets/mine.ts`)).toContain('s("qq"');
    expect(b.host.files.has("/home/.config/texdesk/snippets/mine.ts")).toBe(false);
    await waitFor(() => b.status().includes("1 snippet"));
  });
});

describe("workspace trust", () => {
  const doc = `${WS}/Fa30/1-CS101/hw/hw1.tex`;
  const files = {
    ...workspace,
    [`${WS}/.texdesk/plugins/greet/greet.ts`]: 'import { snippets, s } from "texdesk";\nexport default snippets([s("hii", "HELLO", { mode: "text", auto: true })]);',
    [WSJ]: wsJson({}, { tectonic: "/tmp/not-tectonic" }),
  };

  it("a workspace with its own code asks once; until you allow it, its plugins and Tectonic path aren't used", async () => {
    localStorage.removeItem(`texdesk:trust:${WS}`);
    const b = await boot(files, doc);
    const calls: (string | null)[] = [];
    b.host.compile = async (req) => { calls.push(req.tectonic ?? null); return { ok: true, cancelled: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1, pdf: null, launchError: null }; };
    const title = await waitFor(() => b.root.querySelector(".pal-title")?.textContent);
    expect(title).toContain("snippet plugin (greet) and its own Tectonic path");
    await b.palette("Don't allow");
    expect(localStorage.getItem(`texdesk:trust:${WS}`)).toBe("false");
    await waitFor(() => b.editor()?.state.doc.length);
    const v = b.editor();
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    type(v, " hii");
    expect(v.state.doc.toString().endsWith(" hii")).toBe(true);
    await b.command("Save");
    await waitFor(() => calls.length > 0);
    expect(calls[0]).toBeNull();
    // Allowed from Settings → Plugins: the plugin loads.
    await b.command("Settings");
    (await waitFor(() => [...b.root.querySelectorAll<HTMLElement>(".set-nav-item, .set-nav button")].find((x) => x.textContent?.includes("Plugins"))))!.click();
    (await waitFor(() => [...b.root.querySelectorAll<HTMLButtonElement>(".plg-trust button")].find((x) => x.textContent?.includes("Allow"))))!.click();
    await waitFor(() => localStorage.getItem(`texdesk:trust:${WS}`) === "true");
    await waitFor(() => b.status().includes("snippet"));
  });

  it("a workspace without its own code doesn't ask", async () => {
    localStorage.removeItem(`texdesk:trust:${WS}`);
    const b = await boot(workspace, doc);
    await waitFor(() => b.editor()?.state.doc.length);
    await settle(50);
    expect(b.root.querySelector(".pal")).toBeNull();
  });
});

describe("welcome tour", () => {
  it("shows once on the first workspace, is skippable, and comes back from the command palette", async () => {
    localStorage.removeItem("texdesk:tourDone");
    const b = await boot(workspace, `${WS}/Fa30/1-CS101/hw/hw1.tex`);
    const tip = await waitFor(() => b.root.querySelector(".tour-tip"));
    expect(tip.querySelector(".tour-title")!.textContent).toBe("Welcome to TeXdesk");
    b.root.querySelector<HTMLElement>(".tour-btn.primary")!.click();
    await waitFor(() => b.root.querySelector(".tour-title")?.textContent === "Your files");
    b.root.querySelector<HTMLElement>(".tour-skip")!.click();
    await waitFor(() => !b.root.querySelector(".tour"));
    expect(localStorage.getItem("texdesk:tourDone")).toBe("true");
    await b.command("Show the welcome tour");
    await waitFor(() => b.root.querySelector(".tour-tip"));
    b.key("Escape");
    await waitFor(() => !b.root.querySelector(".tour"));
  });
});

describe("spelling", () => {
  const hw = `${WS}/Fa30/1-CS101/hw/hw2.tex`;
  const text = "\\documentclass{article}\n\\begin{document}\nThe probabilty of $evnt$ is hihg.\n\\end{document}";
  const spellDiags = (v: EditorView) => {
    const out: { text: string; actions: string[] }[] = [];
    forEachDiagnostic(v.state, (d, from, to) => { if (d.source === "spelling") out.push({ text: v.state.sliceDoc(from, to), actions: d.actions!.map((a) => a.name) }); });
    return out;
  };
  async function open(misspelled: Record<string, string[]>, corrections: Record<string, string> = {}) {
    const b = await boot({ ...workspace, [hw]: text }, hw, null, (h) => { h.spelling.misspelled = misspelled; h.spelling.corrections = corrections; });
    await waitFor(() => b.editor()?.state.doc.length);
    return b;
  }

  it("misspellings are underlined as soon as the file opens, prose only, each word asked about once", async () => {
    const b = await open({ probabilty: ["probability", "probabilities"], hihg: ["high"], evnt: ["event"] });
    await waitFor(() => spellDiags(b.editor()).length === 2);
    expect(spellDiags(b.editor())).toEqual([
      { text: "probabilty", actions: ["probability", "probabilities", "Add to dictionary"] },
      { text: "hihg", actions: ["high", "Add to dictionary"] },
    ]);
    expect(b.host.spelling.asked[0]).toEqual(["The", "probabilty", "of", "is", "hihg"]);
    // Typing re-checks just the new words.
    const v = b.editor();
    v.dispatch({ changes: { from: v.state.doc.line(3).to, insert: " Anew wrod here" }, selection: { anchor: 0 } });
    b.host.spelling.misspelled!.wrod = ["word"];
    await waitFor(() => spellDiags(v).some((d) => d.text === "wrod"));
    expect(b.host.spelling.asked.at(-1)).toEqual(["Anew", "wrod", "here"]);
  });

  it("the word being typed isn't underlined until the cursor leaves it", async () => {
    const b = await open({ teh: ["the"] });
    const v = b.editor();
    v.focus();
    const end = v.state.doc.line(3).to;
    v.dispatch({ changes: { from: end, insert: " teh" }, selection: { anchor: end + 4 } });
    await waitFor(() => b.host.spelling.asked.some((w) => w.includes("teh")));
    await new Promise((r) => setTimeout(r, 50));
    expect(spellDiags(v).some((d) => d.text === "teh")).toBe(false);
    v.dispatch({ selection: { anchor: 0 } });
    await waitFor(() => spellDiags(v).some((d) => d.text === "teh"));
  });

  const pressIn = (v: EditorView, k: string) => v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const picker = (v: EditorView) => [...v.dom.querySelectorAll(".cm-spellfix-option")].map((e) => e.textContent);

  it("⌘L goes to the last misspelling, numbers its suggestions best first, and a number fixes it and comes back", async () => {
    const b = await open({ probabilty: ["probabilities", "probability", "probably"], hihg: ["high"] }, { probabilty: "probability" });
    const v = b.editor();
    await waitFor(() => spellDiags(v).length === 2);
    const line = () => v.state.doc.line(3).text;
    const from = v.state.doc.line(3).from;
    v.dispatch({ selection: { anchor: from + 20 } }); // after "of"
    b.key("l", { metaKey: true });
    await waitFor(() => picker(v).length === 3);
    expect(v.state.selection.main.head).toBe(from + 4); // at the word, not changed yet
    expect(line()).toBe("The probabilty of $evnt$ is hihg.");
    expect(v.dom.querySelector(".cm-spellfix-word")?.textContent).toBe("probabilty");
    expect(picker(v)).toEqual(["1probability", "2probabilities", "3probably"]); // the autocorrection first
    pressIn(v, "3");
    expect(line()).toBe("The probably of $evnt$ is hihg.");
    expect(v.state.selection.main.head).toBe(from + 18); // back after "of"
    expect(v.dom.querySelector(".cm-spellfix-word")).toBeNull();
    undo(v);
    expect(line()).toBe("The probabilty of $evnt$ is hihg.");
  });

  it("⌘L again goes to the one before, and a pick still comes back to where you started", async () => {
    const b = await open({ probabilty: ["probability"], hihg: ["high", "hip"] });
    const v = b.editor();
    await waitFor(() => spellDiags(v).length === 2);
    const end = v.state.doc.line(3).to;
    v.dispatch({ selection: { anchor: end } }); // after "hihg."
    b.key("l", { metaKey: true });
    await waitFor(() => v.dom.querySelector(".cm-spellfix-word")?.textContent === "hihg");
    expect(picker(v)).toEqual(["1high", "2hip"]);
    b.key("l", { metaKey: true });
    await waitFor(() => v.dom.querySelector(".cm-spellfix-word")?.textContent === "probabilty");
    pressIn(v, "1");
    expect(v.state.doc.line(3).text).toBe("The probability of $evnt$ is hihg.");
    expect(v.state.selection.main.head).toBe(v.state.doc.line(3).to);
    b.key("l", { metaKey: true });
    await waitFor(() => v.dom.querySelector(".cm-spellfix-word")?.textContent === "hihg");
    b.key("l", { metaKey: true });
    await waitFor(() => b.status().includes("No misspellings before the cursor"));
  });

  it("Esc puts the cursor back without a change; another key leaves it at the word", async () => {
    const b = await open({ hihg: ["high"] });
    const v = b.editor();
    await waitFor(() => spellDiags(v).length === 1);
    const end = v.state.doc.line(3).to;
    v.dispatch({ selection: { anchor: end } });
    b.key("l", { metaKey: true });
    await waitFor(() => v.dom.querySelector(".cm-spellfix-word"));
    pressIn(v, "Escape");
    expect(v.state.selection.main.head).toBe(end);
    expect(v.dom.querySelector(".cm-spellfix-word")).toBeNull();
    b.key("l", { metaKey: true });
    await waitFor(() => v.dom.querySelector(".cm-spellfix-word"));
    pressIn(v, "x");
    expect(v.dom.querySelector(".cm-spellfix-word")).toBeNull();
    pressIn(v, "1"); // picker gone: not a pick
    expect(v.state.doc.line(3).text).toBe("The probabilty of $evnt$ is hihg.");
  });

  it("Space picks the selected suggestion, which ←→↑↓ and j/k move (stopping at the ends)", async () => {
    const b = await open({ hihg: ["high", "hip", "hug"] });
    const v = b.editor();
    await waitFor(() => spellDiags(v).length === 1);
    const end = v.state.doc.line(3).to;
    v.dispatch({ selection: { anchor: end } });
    b.key("l", { metaKey: true });
    await waitFor(() => picker(v).length === 3);
    const selected = () => v.dom.querySelector(".cm-spellfix-selected")?.textContent;
    expect(selected()).toBe("1high");
    pressIn(v, "k");
    expect(selected()).toBe("1high");
    pressIn(v, "j");
    pressIn(v, "ArrowRight");
    pressIn(v, "ArrowDown");
    expect(selected()).toBe("3hug");
    pressIn(v, "ArrowLeft");
    pressIn(v, "ArrowUp");
    pressIn(v, "j");
    expect(selected()).toBe("2hip");
    expect(v.state.doc.line(3).text).toBe("The probabilty of $evnt$ is hihg.");
    pressIn(v, " ");
    expect(v.state.doc.line(3).text).toBe("The probabilty of $evnt$ is hip.");
    expect(v.state.selection.main.head).toBe(v.state.doc.line(3).to);
    expect(v.dom.querySelector(".cm-spellfix-word")).toBeNull();
  });

  it("⌘L only looks before the cursor (or the word it's in)", async () => {
    const b = await open({ probabilty: ["probability"], hihg: ["high"] });
    const v = b.editor();
    await waitFor(() => spellDiags(v).length === 2);
    const from = v.state.doc.line(3).from;
    v.dispatch({ selection: { anchor: from + 8 } }); // inside "probabilty"
    b.key("l", { metaKey: true });
    await waitFor(() => v.dom.querySelector(".cm-spellfix-word")?.textContent === "probabilty");
    pressIn(v, "1");
    expect(v.state.doc.line(3).text).toBe("The probability of $evnt$ is hihg.");
    expect(v.state.selection.main.head).toBe(from + 4 + "probability".length); // was inside it: after it
  });

  it("a suggestion replaces the word; Add to dictionary keeps it out of later checks", async () => {
    const b = await open({ probabilty: ["probability"], hihg: ["high"] });
    const v = b.editor();
    await waitFor(() => spellDiags(v).length === 2);
    const at = (word: string) => { let r: { from: number; to: number; actions: readonly { name: string; apply: (v: EditorView, f: number, t: number) => void }[] } | null = null; forEachDiagnostic(v.state, (d, from, to) => { if (v.state.sliceDoc(from, to) === word) r = { from, to, actions: d.actions! }; }); return r!; };
    const p = at("probabilty");
    p.actions[0].apply(v, p.from, p.to);
    expect(v.state.doc.line(3).text).toBe("The probability of $evnt$ is hihg.");
    const h = at("hihg");
    h.actions.find((a) => a.name === "Add to dictionary")!.apply(v, h.from, h.to);
    await waitFor(() => b.host.files.get(`${WS}/.texdesk/words.txt`)?.endsWith("hihg\n"));
    await waitFor(() => !spellDiags(v).some((d) => d.text === "hihg"));
    v.dispatch({ changes: { from: v.state.doc.line(3).to, insert: " hihg" } });
    await new Promise((r) => setTimeout(r, 400));
    expect(spellDiags(v).some((d) => d.text === "hihg")).toBe(false);
  });

  it("with Spellcheck off in Settings nothing is underlined, but ⌘L still works", async () => {
    const b = await boot({ ...workspace, [WSJ]: wsJson({}, { editor: { spellcheck: false } }), [hw]: text }, hw, null, (h) => { h.spelling.misspelled = { hihg: ["high"] }; });
    await waitFor(() => b.editor()?.state.doc.length);
    await new Promise((r) => setTimeout(r, 400));
    expect(b.host.spelling.asked).toEqual([]);
    const v = b.editor();
    v.dispatch({ selection: { anchor: v.state.doc.line(3).to } });
    b.key("l", { metaKey: true });
    await waitFor(() => picker(v).length === 1);
    pressIn(v, "1");
    expect(v.state.doc.line(3).text.endsWith("is high.")).toBe(true);
  });
});

describe("beg + environment suggestions", () => {
  const doc = `${WS}/Fa30/1-CS101/hw/b.tex`;
  const files = {
    ...workspace,
    [`${WS}/.texdesk/plugins/beg/beg.ts`]: `import { snippets, s } from "texdesk";
export default snippets([
  s(/^(\\s*)beg$/, (ctx) => \`\${ctx.match![1]}\\\\begin{$1}\\n\\t$2\\n\\\\end{$1}\`, { mode: "text", auto: true }),
]);`,
    [doc]: "\\documentclass{article}\n\\begin{document}\n\n\\end{document}",
  };

  it("picking the environment from the suggestions fills in the existing \\end instead of adding one", async () => {
    const b = await boot(files, doc);
    await waitFor(() => b.editor()?.state.doc.length);
    await waitFor(() => b.status().includes("1 snippet"));
    const v = b.editor();
    v.dispatch({ selection: { anchor: v.state.doc.line(3).from } });
    type(v, "beg");
    expect(v.state.doc.toString()).toContain("\\begin{}\n  \n\\end{}");
    type(v, "ali");
    const list = await waitFor(() => currentCompletions(v.state).length > 0 && currentCompletions(v.state).map((c) => c.label));
    v.dispatch({ effects: setSelectedCompletion(list.indexOf("align*")) });
    await settle(100);
    v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const text = v.state.doc.toString();
    expect(text.match(/\\end\{align\*\}/g)).toHaveLength(1);
    expect(text).toContain("\\begin{align*}\n  \n\\end{align*}");
    expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(4); // inside, on the body line
  });
});

describe("PDF pane bar", () => {
  const C = `${WS}/Fa30/1-CS101`;
  const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}`;
  const files = { ...coursework, [`${C}/hw/hw2.tex`]: doc("two"), [`${C}/hw/hw3.tex`]: doc("three"), [`${C}/hw/preamble.tex`]: "\\usepackage{amsmath}" };
  const bar = (root: HTMLElement) => pdfPane(root)?.querySelector<HTMLElement>(".pdf-nav") ?? null;
  const crumbs = (root: HTMLElement) => [...bar(root)!.querySelectorAll(".pdf-nav-crumb")].map((x) => x.textContent);
  const docs = (root: HTMLElement) => [...bar(root)!.querySelectorAll("option")].map((x) => x.textContent);
  const button = (root: HTMLElement, cls: string) => bar(root)!.querySelector<HTMLButtonElement>(cls)!;

  it("shows the document's folders and steps through the documents next to it, in the folder's order", async () => {
    // Oldest first: hw3, hw1, hw2 (not by name).
    const b = await boot(files, `${C}/hw/hw1.tex`, null, (h) => {
      h.times[`${C}/hw/hw3.tex`] = { created: 1, modified: 1 };
      h.times[`${C}/hw/hw1.tex`] = { created: 2, modified: 2 };
      h.times[`${C}/hw/hw2.tex`] = { created: 3, modified: 3 };
    });
    await waitFor(() => bar(b.root) && docs(b.root).length === 3);
    expect(crumbs(b.root)).toEqual(["Fa30", "1-CS101", "hw"]);
    // Documents only: not preamble.tex (no \documentclass), the PDF or the zip.
    expect(docs(b.root)).toEqual(["hw3", "hw1", "hw2"]);

    button(b.root, ".pdf-nav-next").click();
    await waitFor(() => b.editor().state.doc.toString().includes("two"));
    await waitFor(() => button(b.root, ".pdf-nav-next").disabled);

    const select = bar(b.root)!.querySelector<HTMLSelectElement>("select")!;
    select.value = `${C}/hw/hw3.tex`;
    select.dispatchEvent(new Event("change"));
    await waitFor(() => b.editor().state.doc.toString().includes("three"));
    await waitFor(() => button(b.root, ".pdf-nav-prev").disabled);

    [...bar(b.root)!.querySelectorAll<HTMLElement>(".pdf-nav-crumb")].find((x) => x.textContent === "1-CS101")!.click();
    await waitFor(() => b.root.querySelector(".overview-pane .ov-h1")?.textContent === "1-CS101");
  });
});
