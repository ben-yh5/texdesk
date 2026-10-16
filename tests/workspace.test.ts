import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SnippetRuntime } from "../src/snippets/runtime";
import { watchSnippets } from "../src/snippets/watch";
import { PLUGINS_README, SNIPPETS_TSCONFIG, texdeskDts } from "../src/workspace/seed";
import {
  applyStarter, createFolderOfType, createFromTemplate, ensureSupportFiles, fileInfoFor, findWorkspace, folderQuestions, readWorkspace, seedWorkspace,
  writeStarterBodies,
} from "../src/workspace/workspace";
import {
  WorkspaceFile, emptyWorkspace, formatWorkspace, layoutFor, missingFolders, moveFolderEntries, nearestOfType, parseWorkspace, removeFolderEntries,
  renameField, renameFieldInText, renameType, renameTypeInText, scopeFor,
} from "../src/workspace/model";
import { STARTERS, starterById } from "../src/workspace/starters";
import { BUILTIN_PLUGINS, createPlugin, ensurePluginsFolder, listPlugins, snippetFolders } from "../src/plugins/plugins";
import { applyGlobalMigration, applyMigration, hasLegacySetup, planGlobalMigration, planMigration } from "../src/workspace/migrate";
import { editor, fixtureFiles, memoryHost, settle, show, type } from "./helpers";
import { fuzzyFilter, fuzzyScore } from "../src/workspace/fuzzy";
import { findTemplate, listTemplates, numberPattern, promptsFor, renderTemplate } from "../src/workspace/templates";
import { Raw, defaultConfig } from "../src/workspace/config";

const wsJson = (w: Partial<WorkspaceFile>) => formatWorkspace({ ...emptyWorkspace(), ...w });

/** A workspace with terms and classes, as the Coursework starter makes them. */
const SCHOOL: Partial<WorkspaceFile> = {
  settings: { vars: { author: "Ada" } },
  folderTypes: {
    term: { label: "Term", children: ["class"] },
    class: {
      label: "Class", name: "{{code}}", fields: [{ key: "code", label: "Course code", required: true }, { key: "course", label: "Course name" }],
      settings: { figures_dir: "figs", pdf_name: "{{code}}_{{stem}}.pdf", vars: { dept: "CS" } },
    },
  },
  folders: {
    Fa30: { type: "term", fields: { course: "outer" } },
    "Fa30/1-CS101": { type: "class", fields: { code: "CS101", course: "CS 101" } },
  },
};

describe("workspace discovery", () => {
  it("walks up to the nearest .texdesk", async () => {
    const host = memoryHost({ "/School/.texdesk/workspace.json": "{}", "/School/Fa30/1-CS101/hw/hw1.tex": "" });
    expect(await findWorkspace(host, "/School/Fa30/1-CS101/hw/hw1.tex")).toBe("/School");
    expect(await findWorkspace(host, "/Elsewhere/x.tex")).toBe(null);
  });

  it("typed folders cascade: fields, type settings and variables, nearest winning", () => {
    const ws = parseWorkspace(wsJson(SCHOOL), []);
    const cfg = { ...defaultConfig, vars: { author: "Ada" } };
    const scope = scopeFor("/W", cfg, ws, "/W/Fa30/1-CS101/hw");
    expect(scope.errors).toEqual([]);
    expect(scope.vars).toEqual({
      author: "Ada", course: "CS 101", "term.course": "outer", term_folder: "Fa30",
      dept: "CS", code: "CS101", "class.code": "CS101", "class.course": "CS 101", class_folder: "1-CS101",
    });
    expect(scope.folders).toEqual([{ path: "/W/Fa30", kind: "term" }, { path: "/W/Fa30/1-CS101", kind: "class" }]);
    expect(scope.figuresDir).toBe("/W/Fa30/1-CS101/figs");
    expect(scope.config.pdfName).toBe("{{code}}_{{stem}}.pdf");
    expect(nearestOfType(scope, "term")).toBe("/W/Fa30");
    expect(nearestOfType(scope, "project")).toBe(null);
    expect(fileInfoFor("/W/Fa30/1-CS101/hw/hw1.tex", "/W", cfg, ws).vars.course).toBe("CS 101");
    expect(scopeFor("/W", cfg, ws, "/W").figuresDir).toBe(null);
  });

  it("a folder type can't set workspace-wide settings", () => {
    const ws = parseWorkspace(wsJson({ folderTypes: { a: { label: "A", settings: { editor: { theme: "dark" }, vars: { x: "1" } } } }, folders: { a: { type: "a" } } }), []);
    const scope = scopeFor("/W", defaultConfig, ws, "/W/a/b");
    expect(scope.config.editor.theme).toBe(defaultConfig.editor.theme);
    expect(scope.vars.x).toBe("1");
    expect(scope.errors).toEqual(["folder type a: editor can only be set for the whole workspace"]);
  });

  it("workspace.json problems are reported and the rest still works", () => {
    const errors: string[] = [];
    const ws = parseWorkspace(JSON.stringify({
      version: 1, bogus: 1,
      folderTypes: { "bad key": { label: "X" }, ok: { label: "OK", fields: [{ key: "a b" }, { key: "a" }], sort: "size" } },
      folders: { "/abs": {}, "x/../y": {}, "z": { type: "nope" } },
      templates: { t: { label: "T" }, u: { body: "u.tex", in: "ok" } },
      overviews: { o: { blocks: [{ type: "files", groupBy: "weird", limit: "3" }, { type: "chart" }] } },
    }), errors);
    expect(Object.keys(ws.folderTypes)).toEqual(["ok"]);
    expect(ws.folderTypes.ok.fields).toEqual([{ key: "a", label: "a" }]);
    expect(Object.keys(ws.folders)).toEqual(["z"]);
    expect(Object.keys(ws.templates)).toEqual(["u"]);
    expect(ws.overviews.o.blocks).toEqual([{ type: "files" }]);
    expect(errors).toEqual([
      "workspace.json: unknown key bogus",
      "folder type bad key: the key must be letters, digits and _",
      "folder type ok: fields[0] needs a key (letters, digits and _)",
      'folder type ok: sort must be "created", "modified", "name"',
      'folders: "/abs" isn\'t a relative folder path',
      'folders: "x/../y" isn\'t a relative folder path',
      "template t: needs a body (a file in .texdesk/templates)",
      "overview o, block 1: limit has the wrong type",
      'overview o, block 1: groupBy must be "subfolder", "typed" or "none"',
      "overview o, block 2: each block needs a type: header, templates, files, subfolders",
      'folder z: there\'s no folder type "nope"',
    ]);
    expect(parseWorkspace("{ nope", errors)).toEqual(emptyWorkspace());
  });

  it("formats with a schema link and stable order, and parses back to the same thing", () => {
    const text = wsJson(SCHOOL);
    expect(text.startsWith('{\n  "$schema": "./workspace.schema.json",\n  "version": 1,')).toBe(true);
    expect(formatWorkspace(parseWorkspace(text, []))).toBe(text);
  });

  it("writes the app's support files (texdesk.sty, the schema)", async () => {
    const host = memoryHost({});
    await ensureSupportFiles(host, "/W");
    expect(host.files.has("/W/.texdesk/tex/texdesk.sty")).toBe(true);
    expect(JSON.parse(host.files.get("/W/.texdesk/workspace.schema.json")!).title).toBe("TeXdesk workspace");
  });
});

describe("changes to workspace.json", () => {
  const ws = parseWorkspace(wsJson({
    ...SCHOOL,
    templates: { hw: { label: "Homework", body: "hw.tex", in: "class" } },
    overviews: { cls: { blocks: [{ type: "header", fields: ["course"] }, { type: "files", inType: "class" }, { type: "templates", folders: ["class"] }] } },
  }), []);
  it("renaming a type follows it everywhere", () => {
    const next = renameType({ ...ws, folderTypes: { ...ws.folderTypes, class: { ...ws.folderTypes.class, overview: "cls" } } }, "class", "course");
    expect(Object.keys(next.folderTypes)).toEqual(["term", "course"]);
    expect(next.folderTypes.term.children).toEqual(["course"]);
    expect(next.folders["Fa30/1-CS101"].type).toBe("course");
    expect(next.templates.hw.in).toBe("course");
    expect(next.overviews.cls.blocks).toEqual([{ type: "header", fields: ["course"] }, { type: "files", inType: "course" }, { type: "templates", folders: ["course"] }]);
    expect(() => renameType(ws, "class", "term")).toThrow("already a folder type");
    expect(() => renameType(ws, "class", "a b")).toThrow("letters");
    expect(renameTypeInText("\\link[{{course}}]{{{course_folder}}} {{course.code}} {{courses_folder}}", "course", "class")).toBe("\\link[{{course}}]{{{class_folder}}} {{class.code}} {{courses_folder}}");
  });
  it("renaming a field renames its values, the name pattern and layout uses", () => {
    const next = renameField(ws, "class", "code", "number");
    expect(next.folderTypes.class.fields!.map((f) => f.key)).toEqual(["number", "course"]);
    expect(next.folderTypes.class.name).toBe("{{number}}");
    expect(next.folders["Fa30/1-CS101"].fields).toEqual({ number: "CS101", course: "CS 101" });
    expect(next.folders.Fa30.fields).toEqual({ course: "outer" }); // another type's folder
    expect(() => renameField(ws, "class", "code", "course")).toThrow("already has a field");
    expect(renameFieldInText("{{code}} {{class.code}} {{codes}}", "class", "code", "number")).toBe("{{number}} {{class.number}} {{codes}}");
  });
  it("moving and deleting folders carries their entries; gone folders are found", () => {
    const withOrder = { ...ws, folders: { ...ws.folders, Fa30: { ...ws.folders.Fa30, order: ["1-CS101", "x"] } } };
    const moved = moveFolderEntries(withOrder, "Fa30/1-CS101", "Fa30/CS101");
    expect(Object.keys(moved.folders).sort()).toEqual(["Fa30", "Fa30/CS101"]);
    expect(moved.folders.Fa30.order).toEqual(["CS101", "x"]);
    expect(Object.keys(moveFolderEntries(ws, "Fa30", "Wi31").folders).sort()).toEqual(["Wi31", "Wi31/1-CS101"]);
    expect(Object.keys(removeFolderEntries(ws, "Fa30").folders)).toEqual([]);
    expect(missingFolders(ws, new Set(["Fa30"]))).toEqual(["Fa30/1-CS101"]);
  });
  it("a folder's layout: its own, its type's, or the default", () => {
    const w = { ...ws, folderTypes: { ...ws.folderTypes, class: { ...ws.folderTypes.class, overview: "cls" } } };
    expect(layoutFor(w, "Fa30/1-CS101").key).toBe("cls");
    expect(layoutFor(w, "Fa30").key).toBe(null);
    expect(layoutFor(w, "Fa30").layout.blocks.map((b) => b.type)).toEqual(["header", "templates", "files"]);
  });
});

describe("hot reload", () => {
  it("a new .ts file takes effect without restarting; edits and deletions too", async () => {
    const dir = "/home/.config/texdesk/plugins/mine";
    const host = memoryHost({ [`${dir}/plugin.json`]: "{}" });
    const rt = new SnippetRuntime();
    const stop = await watchSnippets(host, [{ dir, prefix: "mine/" }], rt);
    const v = editor("|", rt);

    type(v, "mk");
    expect(show(v)).toBe("mk|");

    host.touch(`${dir}/basics.ts`, fixtureFiles("snippets", ["basics.ts"])[0].code);
    host.touch(`${dir}/shared.ts`, fixtureFiles("snippets", ["shared.ts"])[0].code);
    await settle();
    expect(rt.loadErrors).toEqual([]);
    type(v, " mk");
    expect(show(v)).toBe("mk \\(|\\)");

    host.touch(`${dir}/basics.ts`, 'import { snippets, s } from "texdesk";\nexport default snippets([s("mk", "MATH", { auto: true })]);');
    await settle();
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    type(v, " mk");
    expect(v.state.doc.toString().endsWith(" MATH")).toBe(true);

    host.touch(`${dir}/broken.ts`, "export default [;");
    await settle();
    expect(rt.loadErrors.map((e) => e.file)).toEqual(["mine/broken.ts"]);
    expect(rt.set.snippets.length).toBe(1);

    host.touch(`${dir}/basics.ts`, null);
    host.touch(`${dir}/broken.ts`, null);
    await settle();
    expect(rt.set.snippets.length).toBe(0);
    expect(rt.loadErrors).toEqual([]);
    stop();
  });

  it("ignores non-snippet files in the folder", async () => {
    const dir = "/p/mine";
    const host = memoryHost({ [`${dir}/a.ts`]: 'import { s } from "texdesk"; export default [s("q", "Q", { auto: true })];' });
    const rt = new SnippetRuntime();
    let reloads = 0;
    rt.subscribe(() => reloads++);
    await watchSnippets(host, [{ dir, prefix: "" }], rt);
    const before = reloads;
    host.touch(`${dir}/plugin.json`, "changed");
    host.touch(`${dir}/texdesk.d.ts`, "changed");
    await settle();
    expect(reloads).toBe(before);
  });
});

describe("plugins", () => {
  const user = "/home/.config/texdesk/plugins", wsp = "/W/.texdesk/plugins";
  const files = {
    [`${wsp}/mine/a.ts`]: 'import { s } from "texdesk"; export default [s("qq", "WORKSPACE", { auto: true })];',
    [`${wsp}/shared/a.ts`]: 'import { s } from "texdesk"; export default [s("ss", "WS SHARED", { auto: true })];',
    [`${user}/shared/plugin.json`]: '{ "name": "Shared", "description": "d" }',
    [`${user}/shared/a.ts`]: 'import { s } from "texdesk"; export default [s("ss", "USER SHARED", { auto: true })];',
    [`${user}/latex/plugin.json`]: '{ "name": "LaTeX snippets" }',
    [`${user}/latex/a.ts`]: 'import { s } from "texdesk"; import { X } from "./b"; export default [s("qq", "GLOBAL", { auto: true }), s("gg", X, { auto: true })];',
    [`${user}/latex/b.ts`]: 'export const X = "FROM B";',
    [`${user}/latex/broken.ts`]: 'import { Y } from "../mine/a"; export default [Y];',
    [`${user}/off/a.ts`]: "export default [];",
    [`${user}/bad/plugin.json`]: "{ nope",
    [`${user}/README.md`]: "",
  };

  it("lists the workspace's, yours and the built-in ones; same id replaces; built-ins start off", async () => {
    const host = memoryHost(files);
    const list = await listPlugins(host, user, wsp, { off: false, "matrix-keys": true });
    expect(list.map((p) => [p.id, p.source, p.enabled, p.replacedBy])).toEqual([
      ["mine", "workspace", true, null],
      ["shared", "workspace", true, null],
      ["bad", "user", true, null],
      ["latex", "user", true, null],
      ["off", "user", false, null],
      ["shared", "user", false, "workspace"],
      ["castel", "built-in", false, null],
      ["markdown-shortcuts", "built-in", false, null],
      ["bullet-lists", "built-in", false, null],
      ["matrix-keys", "built-in", true, null],
    ]);
    expect(list.find((p) => p.id === "latex")!.name).toBe("LaTeX snippets");
    expect(list.find((p) => p.id === "bad")!.error).toMatch(/^plugin\.json: /);
  });

  it("a workspace that isn't allowed has its plugins listed but off, and they don't replace yours", async () => {
    const host = memoryHost(files);
    const list = await listPlugins(host, user, wsp, {}, false);
    expect(list.filter((p) => p.source === "workspace").map((p) => [p.id, p.enabled, p.blocked])).toEqual([["mine", false, true], ["shared", false, true]]);
    expect(list.find((p) => p.id === "shared" && p.source === "user")).toMatchObject({ enabled: true, replacedBy: null });
  });

  it("a plugin made with Duplicate to edit records what it was forked from", async () => {
    const host = memoryHost({});
    await createPlugin(host, user, "castel", { name: "Gilles Castel's snippets", forkedFrom: "castel" }, [{ name: "castel.ts", code: "export default [];" }]);
    expect(JSON.parse(host.files.get(`${user}/castel/plugin.json`)!).forkedFrom).toBe("castel");
    const list = await listPlugins(host, user, null, {});
    expect(list.find((p) => p.source === "user")).toMatchObject({ id: "castel", forkedFrom: "castel", enabled: true });
    expect(list.find((p) => p.source === "built-in" && p.id === "castel")!.replacedBy).toBe("user");
  });

  it("enabled plugins load in that order, workspace first, each importing only its own files", async () => {
    const host = memoryHost(files);
    const rt = new SnippetRuntime();
    const stop = await watchSnippets(host, snippetFolders(await listPlugins(host, user, wsp, {})), rt);
    expect(rt.loadErrors.map((e) => e.file)).toEqual(["latex/broken.ts"]);
    const v = editor("|", rt);
    type(v, "qq gg ss");
    expect(show(v)).toBe("WORKSPACE FROM B WS SHARED|");
    expect([...new Set(rt.set.snippets.map((e) => e.file))]).toEqual(["mine/a.ts", "shared/a.ts", "latex/a.ts"]);
    stop();
  });

  it("built-in plugins load from the app when turned on", async () => {
    const host = memoryHost({});
    const rt = new SnippetRuntime();
    await watchSnippets(host, snippetFolders(await listPlugins(host, null, null, { "bullet-lists": true })), rt);
    expect(rt.loadErrors).toEqual([]);
    expect(rt.set.snippets.map((e) => e.file)).toEqual(["bullet-lists/bullet-lists.ts"]);
    expect(BUILTIN_PLUGINS.map((b) => b.id)).toEqual(["castel", "markdown-shortcuts", "bullet-lists", "matrix-keys"]);
  });

  it("a plugins folder gets the shared support files, without overwriting the README", async () => {
    const host = memoryHost({ [`${user}/README.md`]: "my notes", [`${user}/texdesk.d.ts`]: "stale" });
    await ensurePluginsFolder(host, user);
    expect(host.files.get(`${user}/README.md`)).toBe("my notes");
    expect(host.files.get(`${user}/texdesk.d.ts`)).toBe(texdeskDts());
    expect(host.files.get(`${user}/tsconfig.json`)).toBe(SNIPPETS_TSCONFIG);
    const dir = await createPlugin(host, user, "greek", { name: "Greek" }, [{ name: "g.ts", code: "export default [];" }]);
    expect(JSON.parse(host.files.get(`${dir}/plugin.json`)!)).toEqual({ name: "Greek", description: "", version: "1" });
    await expect(createPlugin(host, user, "greek", { name: "Again" })).rejects.toThrow("already exists");
  });

  it("a folder that doesn't exist is skipped", async () => {
    const rt = new SnippetRuntime();
    await watchSnippets(memoryHost({}), [{ dir: "/nope", prefix: "" }], rt);
    expect(rt.loadErrors).toEqual([]);
    expect(rt.set.snippets).toEqual([]);
  });
});

describe("texdesk.d.ts", () => {
  it("the acceptance fixtures typecheck against the generated declarations, laid out as a plugin", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "texdesk-dts-"));
    fs.writeFileSync(path.join(tmp, "texdesk.d.ts"), texdeskDts());
    fs.writeFileSync(path.join(tmp, "tsconfig.json"), SNIPPETS_TSCONFIG);
    fs.mkdirSync(path.join(tmp, "fixtures"));
    for (const f of [...fixtureFiles("snippets"), fixtureFiles("broken", ["async.ts"])[0]]) fs.writeFileSync(path.join(tmp, "fixtures", f.name), f.code);
    const tsc = path.join(__dirname, "..", "node_modules", ".bin", "tsc");
    const r = spawnSync(tsc, ["-p", tmp, "--pretty", "false", "--listFilesOnly"], { encoding: "utf8" });
    expect(r.stdout).toContain("fixtures/basics.ts");
    const check = spawnSync(tsc, ["-p", tmp, "--pretty", "false"], { encoding: "utf8" });
    fs.rmSync(tmp, { recursive: true });
    const diags = (check.stdout + check.stderr).split("\n").filter(Boolean).map((l) => l.replace(tmp + "/", ""));
    expect(diags).toEqual([]);
  });

  it("README documents the API without leftover escaping mistakes", () => {
    expect(PLUGINS_README).toContain('s("mk", "\\\\($0\\\\)", { mode: "text", auto: true })');
    expect(PLUGINS_README).toContain("`$$` is always a literal `$`");
  });
});

describe("templates", () => {
  const ws = parseWorkspace(wsJson({
    templates: {
      homework: { label: "Homework", body: "homework.tex", in: "class", dir: "hw", name: "hw{{n}}.tex" },
      lab: { body: "lab.tex", prompt: { code: "Course code" }, name: "{{n}}-{{topic}}.tex" },
      gone: { body: "missing.tex" },
    },
  }), []);

  it("substitutes the variables it's given (dotted ones too), leaves other double braces, and finds $0", () => {
    const r = renderTemplate("\\hwheader{{{course}}}{\\#{{n}}}{{{class.code}}} {{unknown}} \\item $0 end", { course: "CS 101", n: "3", "class.code": "CS101" });
    expect(r.text).toBe("\\hwheader{CS 101}{\\#3}{CS101} {{unknown}} \\item  end");
    expect(r.text.slice(r.cursor)).toBe(" end");
  });

  it("lists entries with their bodies, other .tex files there, and the built-in article", async () => {
    const host = memoryHost({ "/W/.texdesk/templates/homework.tex": "HW", "/W/.texdesk/templates/lab.tex": "LAB", "/W/.texdesk/templates/memo.tex": "MEMO", "/W/.texdesk/templates/README.md": "" });
    const list = await listTemplates(host, "/W", ws);
    expect(list.map((t) => [t.key, t.file, t.scope, t.header.label])).toEqual([
      ["article", "article.tex", "built-in", null],
      ["homework", "homework.tex", "workspace", "Homework"],
      ["lab", "lab.tex", "workspace", null],
      ["memo", "memo.tex", "workspace", null],
    ]);
    expect((await findTemplate(host, "/W", ws, "homework")).body).toBe("HW");
    expect((await findTemplate(host, "/W", ws, "article")).body).toContain("\\maketitle");
    await expect(findTemplate(host, "/W", ws, "gone")).rejects.toThrow("no template");
  });

  it("numbers come from the name pattern", () => {
    const re = numberPattern("{{code}}_hw{{n}}.tex")!;
    expect(re.exec("CS101_hw12.tex")?.[1]).toBe("12");
    expect(re.exec("hw12.tex")).toBe(null);
    expect(re.exec("CS101_hw12.texx")).toBe(null);
    expect(numberPattern("{{title}}.tex")).toBe(null);
  });

  it("asks for its prompts and for unknown variables in its name", async () => {
    const host = memoryHost({ "/W/.texdesk/templates/lab.tex": "" });
    const t = await findTemplate(host, "/W", ws, "lab");
    expect(promptsFor(t, {}).map((p) => p.question)).toEqual(["Course code", "Topic"]);
    expect(promptsFor(t, { code: "x", topic: "y" })).toEqual([]);
  });
});

describe("creating files and folders", () => {
  const now = new Date(2026, 3, 2);
  const ws = parseWorkspace(wsJson({ templates: { homework: { body: "homework.tex", in: "course", dir: "hw", name: "hw{{n}}.tex" }, note: { body: "note.tex" } } }), []);
  const homework = "\\hwheader{{{course}}}{Problem Set \\#{{n}}}{{{date}}} {{title}}\n$0";

  it("numbers files by the template's name, counting only matching files directly in the folder", async () => {
    const host = memoryHost({
      "/W/.texdesk/templates/homework.tex": homework,
      "/C/hw/hw1.tex": "", "/C/hw/hw7.pdf": "", "/C/hw/hw3-code/solve.py": "", "/C/hw/hw12.tex": "", "/C/hw/notes.tex": "", "/C/hw/sub/hw40.tex": "",
    });
    const t = await findTemplate(host, "/W", ws, "homework");
    const c = await createFromTemplate(host, t, "/C/hw", { course: "CS 101" }, { now });
    expect(c).toEqual({ path: "/C/hw/hw13.tex", cursor: expect.any(Number), isDir: false });
    expect(host.files.get(c.path)).toBe("\\hwheader{CS 101}{Problem Set \\#13}{April 2, 2026} hw13\n");
    expect(c.cursor).toBe(host.files.get(c.path)!.length);
  });

  it("a typed name is used as is, and its number fills {{n}}", async () => {
    const host = memoryHost({ "/W/.texdesk/templates/homework.tex": homework, "/C/hw/hw1.tex": "" });
    const t = await findTemplate(host, "/W", ws, "homework");
    const c = await createFromTemplate(host, t, "/C/hw", { title: "Final" }, { name: "hw9.tex", now });
    expect(host.files.get(c.path)).toContain("Problem Set \\#9");
    expect(host.files.get(c.path)).toContain("} Final");
    await expect(createFromTemplate(host, t, "/C/hw", {}, { name: "hw1.tex" })).rejects.toThrow("hw1.tex already exists");
  });

  it("a name with a title is cleaned up into a file name", async () => {
    const host = memoryHost({ "/W/.texdesk/templates/note.tex": "\\section*{{{title}}}" });
    const t = await findTemplate(host, "/W", ws, "note");
    const c = await createFromTemplate(host, t, "/C/notes", { title: " a/b: c " });
    expect(c.path).toBe("/C/notes/a-b- c.tex");
    expect(host.files.get(c.path)).toBe("\\section*{ a/b: c }");
  });

  it("a folder of a type is named from its fields and starts with its scaffold", async () => {
    const w = parseWorkspace(wsJson({
      folderTypes: {
        course: {
          label: "Class", name: "{{n}}-{{code}}", fields: [{ key: "code", label: "Code" }, { key: "course", label: "Name" }, { key: "room", label: "Room" }],
          scaffold: ["notes/", "hw/", { path: "notes/intro.tex", template: "note" }, "README.md"],
        },
      },
      templates: { note: { body: "note.tex" } },
    }), []);
    const host = memoryHost({ "/W/Fa30/1-CS100/x": "", "/W/Fa30/notes.txt": "" });
    const made = await createFolderOfType(host, "/W", w, "/W/Fa30", "course", { code: "CS101", course: 'CS "101"', room: "" }, {
      now, config: defaultConfig, templateBody: async (k) => (k === "note" ? "% {{course}} {{class_folder}}{{course_folder}} {{title}} {{date}}" : null),
    });
    expect(made).toEqual({ path: "/W/Fa30/2-CS101", rel: "Fa30/2-CS101", entry: { type: "course", fields: { code: "CS101", course: 'CS "101"' } } });
    expect(await host.exists("/W/Fa30/2-CS101/hw")).toBe(true);
    expect(host.files.get("/W/Fa30/2-CS101/notes/intro.tex")).toBe('% CS "101" {{class_folder}}2-CS101 intro April 2, 2026');
    expect(host.files.get("/W/Fa30/2-CS101/README.md")).toBe("");
    await expect(createFolderOfType(host, "/W", w, "/W/Fa30", "course", { code: "CS100" }, { now, config: defaultConfig })).resolves.toMatchObject({ rel: "Fa30/3-CS100" });
  });

  it("asks for a folder's name when its type has no name pattern; fields in the pattern are required", () => {
    expect(folderQuestions({ label: "Term" })).toEqual([{ key: "name", label: "Name of the new Term", required: true }]);
    expect(folderQuestions({ label: "Class", name: "{{code}}", fields: [{ key: "code", label: "Code" }, { key: "course", label: "Name" }] }))
      .toEqual([{ key: "code", label: "Code", required: true }, { key: "course", label: "Name", required: false }]);
  });
});

describe("starters", () => {
  it("seeding writes workspace.json from a starter and never overwrites", async () => {
    const host = memoryHost({ "/W/preamble.sty": "mine", "/W/.texdesk/templates/article.tex": "my template" });
    const created = await seedWorkspace(host, "/W");
    expect(host.files.get("/W/preamble.sty")).toBe("mine");
    expect(host.files.get("/W/.texdesk/templates/article.tex")).toBe("my template");
    expect(created).toContain("/W/.texdesk/workspace.json");
    expect(created).not.toContain("/W/preamble.sty");
    const { ws } = await readWorkspace(host, "/W");
    expect(ws.templates).toEqual({ article: { label: "Document", body: "article.tex", name: "{{title}}.tex" } });
    expect(ws.folderTypes).toEqual({});
  });

  it("the Coursework starter makes classes, homework and notes, with nothing about courses in the app", async () => {
    const host = memoryHost({});
    await seedWorkspace(host, "/W", "coursework");
    let { ws } = await readWorkspace(host, "/W");
    expect(Object.keys(ws.folderTypes)).toEqual(["term", "class"]);
    const term = await createFolderOfType(host, "/W", ws, "/W", "term", { name: "Fa30" }, { config: defaultConfig });
    ws = { ...ws, folders: { ...ws.folders, [term.rel]: term.entry } };
    const cls = await createFolderOfType(host, "/W", ws, term.path, "class", { code: "CS101", course: "CS 101" }, { config: defaultConfig });
    ws = { ...ws, folders: { ...ws.folders, [cls.rel]: cls.entry } };
    expect(cls.path).toBe("/W/Fa30/CS101");
    for (const sub of ["notes", "hw", "figures"]) expect(await host.exists(`/W/Fa30/CS101/${sub}`)).toBe(true);
    const scope = scopeFor("/W", defaultConfig, ws, "/W/Fa30/CS101/hw");
    expect(nearestOfType(scope, "class")).toBe("/W/Fa30/CS101");
    expect(scope.figuresDir).toBe("/W/Fa30/CS101/figures");
    const hw = await findTemplate(host, "/W", ws, "homework");
    const made = await createFromTemplate(host, hw, "/W/Fa30/CS101/hw", scope.vars, { now: new Date(2026, 9, 9) });
    expect(made.path).toBe("/W/Fa30/CS101/hw/hw1.tex");
    expect(host.files.get(made.path)).toContain("\\textbf{Course:} CS 101 \\\\");
    expect(host.files.get(made.path)).toContain("Problem Set \\#1");
    // A note's class name links to the class folder (\link opens its overview).
    const note = await findTemplate(host, "/W", ws, "note");
    const n = await createFromTemplate(host, note, "/W/Fa30/CS101/notes", { ...scope.vars, title: "Flows" });
    expect(host.files.get(n.path)).toContain("\\textit{\\link[CS 101]{CS101} \\quad");
  });

  it("applying a starter adds what's missing and reports what it would replace", async () => {
    const coursework = starterById("coursework")!;
    const base = { ...emptyWorkspace(), folderTypes: { class: { label: "My class" } }, templates: { mine: { body: "mine.tex" } } };
    const kept = applyStarter(base, coursework);
    expect(kept.conflicts).toEqual(["folder type class"]);
    expect(kept.ws.folderTypes.class.label).toBe("My class");
    expect(Object.keys(kept.ws.templates).sort()).toEqual(["article", "homework", "mine", "note"]);
    expect(applyStarter(base, coursework, new Set(["folder type class"])).ws.folderTypes.class.label).toBe("Class");
    const host = memoryHost({ "/W/.texdesk/templates/homework.tex": "mine" });
    expect(await writeStarterBodies(host, "/W", coursework)).toEqual(["/W/.texdesk/templates/article.tex", "/W/.texdesk/templates/note.tex"]);
    expect(host.files.get("/W/.texdesk/templates/homework.tex")).toBe("mine");
    expect(STARTERS.map((st) => st.id)).toEqual(["blank", "coursework"]);
  });
});

describe("upgrading from the old setup files", () => {
  it("personal settings move to the global settings unless they're set there; a workspace's own snippets become a plugin", async () => {
    const host = memoryHost({
      "/W/.texdesk/config.toml": 'pdf_name = "x-{{stem}}.pdf"\n[vars]\nauthor = "Ada"\n[editor]\nfont_size = 18\ntheme = "dark"\nlist_editing = true\n[keys]\nadd_problem = "Mod-p"\ntoggle_pdf = "Mod-r"',
      "/W/.texdesk/snippets/mine.ts": "export default [];",
      "/W/.texdesk/snippets/texdesk.d.ts": "",
      "/W/a/.texdesk.toml": 'bogus = 1\nsort = "name"',
    });
    const plan = await planMigration(host, "/W", await host.listFiles("/W", []), { editor: { theme: "light" } });
    expect(plan.globalSettings).toEqual({ editor: { font_size: 18 }, keys: { toggle_pdf: "Mod-r" } });
    expect(plan.ws.settings).toEqual({ pdf_name: "x-{{stem}}.pdf", vars: { author: "Ada" }, editor: { theme: "dark" } });
    expect(plan.ws.folders).toEqual({ a: { sort: "name" } });
    expect(plan.notes).toEqual(["a/.texdesk.toml: bogus isn't a folder setting any more; it was left out"]);
    let added: unknown = null;
    await applyMigration(host, "/W", plan, async (raw) => { added = raw; });
    expect(added).toEqual(plan.globalSettings);
    expect(host.files.get("/W/.texdesk/plugins/workspace-snippets/mine.ts")).toBe("export default [];");
    expect(JSON.parse(host.files.get("/W/.texdesk/plugins/workspace-snippets/plugin.json")!).name).toBe("Workspace snippets");
  });

  it("the global config.toml becomes settings.json, and the global snippets the LaTeX snippets plugin", async () => {
    const g = "/home/.config/texdesk";
    const host = memoryHost({
      [`${g}/config.toml`]: '[editor]\nfont_size = 16\nlist_editing = true',
      [`${g}/snippets/imported-latex-suite.ts`]: 'import * as js from "./imported-latex-suite-functions"; export default [];',
      [`${g}/snippets/imported-latex-suite-functions.ts`]: "export const x = 1;",
      [`${g}/snippets/matrix-keys.ts`]: "export const keys = [];",
      [`${g}/snippets/README.md`]: "", [`${g}/snippets/texdesk.d.ts`]: "", [`${g}/snippets/tsconfig.json`]: "",
    });
    const m = await planGlobalMigration(host, g);
    await applyGlobalMigration(host, g, m, {});
    expect(JSON.parse(host.files.get(`${g}/settings.json`)!)).toEqual({ editor: { font_size: 16 } });
    expect(JSON.parse(host.files.get(`${g}/plugins/latex-snippets/plugin.json`)!).name).toBe("LaTeX Suite snippets");
    expect([...host.files.keys()].filter((f) => f.startsWith(`${g}/plugins/latex-snippets/`) && !f.endsWith("/.keep")).sort()).toEqual([
      `${g}/plugins/latex-snippets/imported-latex-suite-functions.ts`, `${g}/plugins/latex-snippets/imported-latex-suite.ts`,
      `${g}/plugins/latex-snippets/matrix-keys.ts`, `${g}/plugins/latex-snippets/plugin.json`,
    ]);
    expect(host.trashed.sort()).toEqual([`${g}/config.toml`, `${g}/snippets`]);
    const rt = new SnippetRuntime();
    await watchSnippets(host, snippetFolders(await listPlugins(host, `${g}/plugins`, null, {})), rt);
    expect(rt.loadErrors).toEqual([]);
    // Nothing to do the next time.
    const again = await planGlobalMigration(host, g);
    expect(again).toEqual({ settings: null, moves: [], manifest: null, trash: [], notes: [] });
  });
});

describe("fuzzy file matching", () => {
  const files = ["Fa30/1-CS101/hw/hw3.tex", "Fa30/1-CS101/hw/hw1.tex", "Fa30/2-MATH210/hw/hw3.tex", "Sp30/1-CS101/notes/hw3 review.tex"];
  it("matches path segments in any order", () => {
    expect(fuzzyFilter("101 hw3", files, (f) => f)[0]).toBe("Fa30/1-CS101/hw/hw3.tex");
    expect(fuzzyFilter("hw3 210", files, (f) => f)[0]).toBe("Fa30/2-MATH210/hw/hw3.tex");
    expect(fuzzyScore("101 hw3", "Fa30/1-CS101/hw/hw1.tex")).toBe(null);
  });
  it("prefers the file name", () => {
    expect(fuzzyFilter("hw1", files, (f) => f)[0]).toBe("Fa30/1-CS101/hw/hw1.tex");
  });
});
