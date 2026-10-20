import { describe, expect, it } from "vitest";
import { DEFAULT_KEYS, defaultConfig, globalDir, hasSettingKey, loadGlobalConfig, setSettingKey, workspaceConfig } from "../src/workspace/config";
import { readWorkspace } from "../src/workspace/workspace";
import { formatKey, matchesKey, parseKey, toAccelerator } from "../src/app/keys";
import { SECTIONS, keySpec } from "../src/app/Settings";
import { figureName, insertFigure, saveFigure } from "../src/editor/images";
import { editor, memoryHost, runtimeFrom, show } from "./helpers";
import { undo } from "@codemirror/commands";

/** A workspace whose workspace.json has these settings. */
const wsWith = (settings: Record<string, unknown>) => JSON.stringify({ version: 1, settings });

async function load(files: Record<string, string>) {
  const host = memoryHost(files);
  const g = await loadGlobalConfig(host, globalDir("/home"));
  const { ws, errors: wsErrors } = await readWorkspace(host, "/W");
  const errors = [...g.errors, ...wsErrors];
  const config = workspaceConfig(g.config, ws.settings, errors);
  return { config, errors, global: g.config };
}

describe("settings", () => {
  it("with no settings files, everything is the default", async () => {
    const { config, errors } = await load({});
    expect(errors).toEqual([]);
    expect(config).toEqual(defaultConfig);
  });

  it("the global settings.json applies under the workspace's", async () => {
    const { config, errors, global } = await load({
      "/home/.config/texdesk/settings.json": JSON.stringify({ editor: { font_size: 20, line_numbers: false } }),
      "/W/.texdesk/workspace.json": wsWith({ editor: { font_size: 16 } }),
    });
    expect(errors).toEqual([]);
    expect(global.editor.fontSize).toBe(20);
    expect(config.editor).toEqual({ ...defaultConfig.editor, fontSize: 16, lineNumbers: false });
  });

  it("reads editor, build, keys and plugins, keeping defaults for anything unset", async () => {
    const { config, errors } = await load({
      "/W/.texdesk/workspace.json": wsWith({ editor: { theme: "dark", font_size: 16 }, build: { debounce_ms: 50 }, keys: { toggle_pdf: "Mod-r" }, plugins: { "markdown-shortcuts": true } }),
    });
    expect(errors).toEqual([]);
    expect(config.editor).toEqual({ ...defaultConfig.editor, theme: "dark", fontSize: 16 });
    expect(config.build).toEqual({ ...defaultConfig.build, debounceMs: 50 });
    expect(config.keys).toEqual({ ...DEFAULT_KEYS, toggle_pdf: "Mod-r" });
    expect(config.plugins).toEqual({ "markdown-shortcuts": true });
  });

  it("a workspace's ignore patterns add to the global ones", async () => {
    const { config } = await load({
      "/home/.config/texdesk/settings.json": JSON.stringify({ ignore: [".git", "build"] }),
      "/W/.texdesk/workspace.json": wsWith({ ignore: ["drafts"] }),
    });
    expect(config.ignore).toEqual([".git", "build", "drafts"]);
  });

  it("settings for things that no longer exist (the compile and Add problem commands, list editing) are ignored, not errors", async () => {
    const { config, errors } = await load({
      "/W/.texdesk/workspace.json": wsWith({ build: { compile_on_save: false }, keys: { compile: "Mod-Shift-b", add_problem: "Mod-Enter" }, editor: { list_editing: true } }),
    });
    expect(errors).toEqual([]);
    expect(config).toEqual(defaultConfig);
  });

  it("reports bad values clearly", async () => {
    const { config, errors } = await load({
      "/W/.texdesk/workspace.json": wsWith({ editor: { theme: "blue", font_size: "big" }, ai: { effort: "max" }, keys: { bogus: "Mod-x", toggle_pdf: 3 }, plugins: { x: "yes" } }),
    });
    expect(errors).toEqual([
      'workspace.json settings: editor.theme must be "system", "light" or "dark"',
      "workspace.json settings: editor.font_size must be a number",
      'workspace.json settings: ai.effort must be "low", "medium" or "high"',
      "workspace.json settings: unknown command in keys: bogus",
      "workspace.json settings: keys.toggle_pdf must be a string",
      "workspace.json settings: plugins.x must be true or false",
    ]);
    expect(config.editor).toEqual(defaultConfig.editor);
  });

  it("an unreadable settings.json is reported, and the defaults apply", async () => {
    const { config, errors } = await load({ "/home/.config/texdesk/settings.json": "{ nope" });
    expect(errors[0]).toMatch(/^~\/\.config\/texdesk\/settings\.json: /);
    expect(config).toEqual(defaultConfig);
  });
});

describe("Settings window", () => {
  const sample = (s: (typeof SECTIONS)[number]["settings"][number], d: unknown): unknown => {
    switch (s.type) {
      case "toggle": return !d;
      case "number": return (d as number) + 1;
      case "select": return s.options![1].value;
      case "list": return ["a", "b c"];
      default: return "some value";
    }
  };

  it("every control writes a key the loader reads back", async () => {
    for (const sec of SECTIONS) {
      for (const s of sec.settings) {
        const v = sample(s, s.get(defaultConfig));
        const settings = setSettingKey({}, s.table, s.key, s.save ? s.save(v as never) : v);
        const { config, errors } = await load({ "/home/.config/texdesk/settings.json": JSON.stringify(settings) });
        expect(errors, `${s.table}.${s.key}`).toEqual([]);
        expect(s.get(config), `${s.table}.${s.key}`).toEqual(v);
      }
    }
  });

  it("setting and removing keys", () => {
    const a = setSettingKey({}, "editor", "font_size", 16);
    expect(a).toEqual({ editor: { font_size: 16 } });
    expect(setSettingKey(a, "", "pdf_name", "x.pdf")).toEqual({ editor: { font_size: 16 }, pdf_name: "x.pdf" });
    expect(setSettingKey(a, "editor", "font_size", undefined)).toEqual({});
    expect(hasSettingKey(a, "editor", "font_size")).toBe(true);
    expect(hasSettingKey(a, "editor", "theme")).toBe(false);
  });

  it("records shortcuts from key events", () => {
    const ev = (key: string, code: string, m: Partial<KeyboardEventInit> = {}) => new KeyboardEvent("keydown", { key, code, ...m });
    expect(keySpec(ev("K", "KeyK", { metaKey: true, shiftKey: true }), true)).toBe("Mod-Shift-k");
    expect(keySpec(ev("Enter", "Enter", { metaKey: true }), true)).toBe("Mod-Enter");
    expect(keySpec(ev("å", "KeyA", { altKey: true, ctrlKey: true }), true)).toBe("Ctrl-Alt-a");
    expect(keySpec(ev("b", "KeyB", { ctrlKey: true }), false)).toBe("Mod-b");
    expect(keySpec(ev("Shift", "ShiftLeft", { shiftKey: true }), true)).toBe(null);
  });
});

describe("key specs", () => {
  const ev = (key: string, m: Partial<KeyboardEventInit> = {}) => new KeyboardEvent("keydown", { key, ...m });
  it("Mod is ⌘ on macOS and Ctrl elsewhere", () => {
    expect(matchesKey("Mod-Shift-b", ev("B", { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matchesKey("Mod-Shift-b", ev("b", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(matchesKey("Mod-Shift-b", ev("b", { metaKey: true }), true)).toBe(false);
    expect(matchesKey("Mod-b", ev("b", { metaKey: true, shiftKey: true }), true)).toBe(false);
  });
  it("special keys and odd characters", () => {
    expect(matchesKey("Mod-Shift-Enter", ev("Enter", { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matchesKey("Mod-\\", ev("\\", { metaKey: true }), true)).toBe(true);
    expect(matchesKey("Mod--", ev("-", { metaKey: true }), true)).toBe(true);
    expect(parseKey("Hyper-x")).toBe(null);
    expect(matchesKey("", ev("x"), true)).toBe(false);
  });
  it("formats for display", () => {
    expect(formatKey("Mod-Shift-b", true)).toBe("⇧⌘B");
    expect(formatKey("Mod-Shift-Enter", true)).toBe("⇧⌘↩");
    expect(formatKey("Mod-Shift-b", false)).toBe("Ctrl+Shift+B");
    expect(formatKey("Ctrl-Alt-k", true)).toBe("⌃⌥K");
  });
});

describe("paste image", () => {
  const png = new Uint8Array([137, 80, 78, 71]).buffer;
  const now = new Date(2026, 9, 6, 14, 5, 9);

  it("timestamped names", () => {
    expect(figureName("hw3", now)).toBe("hw3-20261006-140509.png");
  });

  it("saves into the class figures folder and references it by bare name", async () => {
    const host = memoryHost({ "/W/Fa30/1-CS101/hw/hw3.tex": "" });
    const r = await saveFigure(host, "/W/Fa30/1-CS101/hw/hw3.tex", "/W/Fa30/1-CS101/figures", png, now);
    expect(r).toEqual({ path: "/W/Fa30/1-CS101/figures/hw3-20261006-140509.png", include: "hw3-20261006-140509.png" });
    expect(host.files.has(r.path)).toBe(true);
  });

  it("outside a class it uses figures/ next to the file", async () => {
    const host = memoryHost({ "/tmp/x/notes.tex": "" });
    const r = await saveFigure(host, "/tmp/x/notes.tex", null, png, now);
    expect(r.include).toBe("figures/notes-20261006-140509.png");
  });

  it("never overwrites an existing image", async () => {
    const host = memoryHost({ "/F/hw3-20261006-140509.png": "old" });
    const r = await saveFigure(host, "/W/hw3.tex", "/F", png, now);
    expect(r.path).toBe("/F/hw3-20261006-140509-2.png");
    expect(host.files.get("/F/hw3-20261006-140509.png")).toBe("old");
  });

  it("inserts a figure block on its own lines, as one undo step", () => {
    const v = editor("  See below: |more", runtimeFrom([]));
    insertFigure(v, "shot.png");
    expect(show(v)).toBe("  See below: \n  \\begin{figure}[H]\n    \\centering\n    \\includegraphics[width=0.6\\linewidth]{shot.png}\n  \\end{figure}|\n  more");
    undo(v);
    expect(show(v)).toBe("  See below: |more");
  });
});

describe("native menu accelerators", () => {
  it("converts CodeMirror key syntax", () => {
    expect(toAccelerator("Mod-Shift-b")).toBe("CmdOrCtrl+Shift+B");
    expect(toAccelerator("Mod-\\")).toBe("CmdOrCtrl+Backslash");
    expect(toAccelerator("Mod-Alt-Enter")).toBe("CmdOrCtrl+Alt+Enter");
    expect(toAccelerator("Mod-,")).toBe("CmdOrCtrl+Comma");
    expect(toAccelerator("Ctrl-Shift-ArrowUp")).toBe("Ctrl+Shift+ArrowUp");
    expect(toAccelerator("")).toBeNull();
    expect(toAccelerator("Hyper-x")).toBeNull();
  });
});
