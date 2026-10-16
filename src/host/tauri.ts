import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readImage, readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { rgbaToPng } from "./png";
import type { CompileResult, DirEntry, FileTimes, Host, MenuEntry, Misspelling, WalkEntry } from "./types";

const NATIVE = {
  cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "SelectAll", services: "Services", hide: "Hide", hideOthers: "HideOthers",
  showAll: "ShowAll", quit: "Quit", minimize: "Minimize", fullscreen: "Fullscreen", closeWindow: "CloseWindow", bringAllToFront: "BringAllToFront",
} as const;

type NativeItem = MenuItem | Submenu | PredefinedMenuItem;

async function buildItems(entries: MenuEntry[], onSelect: (id: string) => void): Promise<NativeItem[]> {
  const out: NativeItem[] = [];
  for (const e of entries) {
    if (e === "separator") out.push(await PredefinedMenuItem.new({ item: "Separator" }));
    else if ("native" in e) out.push(await PredefinedMenuItem.new({ item: e.native === "about" ? { About: null } : NATIVE[e.native] }));
    else if ("submenu" in e) out.push(await Submenu.new({ text: e.label, items: await buildItems(e.submenu, onSelect) }));
    else out.push(await MenuItem.new({ id: e.id, text: e.label, accelerator: e.accelerator ?? undefined, action: () => onSelect(e.id) }));
  }
  return out;
}

interface FsChange { id: number; paths: string[] }

export function tauriHost(): Host {
  const handlers = new Map<number, (paths: string[]) => void>();
  const ready = listen<FsChange>("fs-change", (e) => handlers.get(e.payload.id)?.(e.payload.paths));

  return {
    kind: "tauri",
    readText: (path) => invoke<string>("read_text", { path }),
    writeText: (path, content) => invoke<void>("write_text", { path, content }),
    createText: (path, content) => invoke<void>("create_text", { path, content }),
    exists: (path) => invoke<boolean>("path_exists", { path }),
    trash: (path) => invoke<void>("trash_path", { path }),
    move: (from, to) => invoke<void>("move_path", { from, to }),
    readDir: (path) => invoke<DirEntry[]>("read_dir", { path }),
    mkdirAll: (path) => invoke<void>("mkdir_all", { path }),
    listFiles: (root, ignore) => invoke<WalkEntry[]>("list_files", { root, ignore }),
    openExternal: (path) => invoke<void>("open_external", { path }),
    async watchTree(root, ignore, onChange) {
      await ready;
      const id = await invoke<number>("watch_tree", { root, ignore });
      handlers.set(id, onChange);
      return () => {
        handlers.delete(id);
        void invoke("unwatch", { id });
      };
    },
    async watch(dir, onChange) {
      await ready;
      const id = await invoke<number>("watch_dir", { path: dir });
      handlers.set(id, onChange);
      return () => {
        handlers.delete(id);
        void invoke("unwatch", { id });
      };
    },
    homeDir: () => invoke<string>("home_dir"),
    initialFile: () => invoke<string | null>("initial_file"),
    pickFile: () => invoke<string | null>("pick_file"),
    pickFolder: () => invoke<string | null>("pick_folder"),
    pickSavePdf: (dir, name) => invoke<string | null>("pick_save_pdf", { dir, name }),
    setTitle: (title) => void getCurrentWindow().setTitle(title),
    readClipboardText: () => readText(),
    writeClipboardText: (text) => writeText(text),
    async setMenu(sections, onSelect) {
      const items = await Promise.all(sections.map(async (s) => Submenu.new({ text: s.label, items: await buildItems(s.items, onSelect) })));
      await (await Menu.new({ items })).setAsAppMenu();
    },
    compile: (req) => invoke<CompileResult>("compile", { req }),
    cancelCompile: (file) => invoke<void>("cancel_compile", { file }),
    sha256: (path) => invoke<string | null>("file_sha256", { path }),
    fileTimes: (paths) => invoke<(FileTimes | null)[]>("file_times", { paths }),
    checkSpelling: (words) => invoke<Misspelling[] | null>("check_spelling", { words }),
    copyFile: (src, dest) => invoke<void>("copy_file", { src, dest }),
    readBinary: (path) => invoke<ArrayBuffer>("read_binary", { path }),
    readGzipText: (path) => invoke<string>("read_gzip_text", { path }),
    createBinary: (path, data) => invoke<void>("create_binary", new Uint8Array(data), { headers: { path: encodeURIComponent(path) } }),
    async readClipboardImage() {
      let img;
      try { img = await readImage(); } catch { return null; }
      const { width, height } = await img.size();
      const rgba = await img.rgba();
      return rgbaToPng(rgba, width, height);
    },
  };
}
