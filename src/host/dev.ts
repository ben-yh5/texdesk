// Browser host backed by the Vite dev server (see vite/dev-fs.ts). Development only.

import type { CompileResult, DirEntry, Host, WalkEntry } from "./types";

async function call<T>(op: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/__texdesk/fs/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${op}: ${await res.text()}`);
  return (await res.json()) as T;
}

export function devHost(): Host {
  const handlers = new Map<number, (paths: string[]) => void>();
  import.meta.hot?.on("texdesk:fs-change", (d: { id: number; paths: string[] }) => handlers.get(d.id)?.(d.paths));

  return {
    kind: "dev",
    readText: (path) => call<string>("read", { path }),
    writeText: (path, content) => call<void>("write", { path, content }),
    createText: (path, content) => call<void>("create", { path, content }),
    exists: (path) => call<boolean>("exists", { path }),
    trash: (path) => call<void>("trash", { path }),
    move: (from, to) => call<void>("move", { from, to }),
    readDir: (path) => call<DirEntry[]>("list", { path }),
    mkdirAll: (path) => call<void>("mkdir", { path }),
    listFiles: (root, ignore) => call<WalkEntry[]>("walk", { path: root, ignore }),
    openExternal: async (path) => { window.open(/^(https?|mailto):/i.test(path) ? path : `/__texdesk/fs/raw?path=${encodeURIComponent(path)}`, "_blank"); },
    async watchTree(root, ignore, onChange) {
      const id = await call<number>("watch-tree", { path: root, ignore });
      handlers.set(id, onChange);
      return () => { handlers.delete(id); void call("unwatch", { id }); };
    },
    async watch(dir, onChange) {
      const id = await call<number>("watch", { path: dir });
      handlers.set(id, onChange);
      return () => { handlers.delete(id); void call("unwatch", { id }); };
    },
    homeDir: () => call<string>("home", {}),
    async initialFile() {
      return new URLSearchParams(location.search).get("file");
    },
    async pickFile() {
      return prompt("Path of a file to open:");
    },
    async pickSavePdf(dir, name) {
      return prompt("Save PDF as:", `${dir}/${name}`);
    },
    async pickFolder() {
      return prompt("Path of a folder to open:", await call<string>("root", {}));
    },
    setTitle: (title) => { document.title = title; },
    readClipboardText: () => navigator.clipboard.readText(),
    writeClipboardText: (text) => navigator.clipboard.writeText(text),
    setMenu: async () => {}, // no native menu in the browser; the palette has every command
    compile: (req) => call<CompileResult>("compile", req as unknown as Record<string, unknown>),
    cancelCompile: (file) => call<void>("cancel-compile", { file }),
    sha256: (path) => call<string | null>("sha256", { path }),
    fileTimes: (paths) => call("times", { paths }),
    // The browser has no spellchecker to ask.
    checkSpelling: async () => null,
    // The API key lives in the macOS Keychain, which only the desktop app reaches.
    aiHasKey: async () => false,
    aiSetKey: async () => { throw new Error("AI features need the desktop app"); },
    aiMessages: async () => { throw new Error("AI features need the desktop app"); },
    copyFile: (src, dest) => call<void>("copy", { src, dest }),
    async readBinary(path) {
      const res = await fetch(`/__texdesk/fs/raw?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(await res.text());
      return res.arrayBuffer();
    },
    readGzipText: (path) => call<string>("gunzip", { path }),
    async createBinary(path, data) {
      const res = await fetch(`/__texdesk/fs/create-binary?path=${encodeURIComponent(path)}`, { method: "POST", body: data });
      if (!res.ok) throw new Error(await res.text());
    },
    async readClipboardImage() {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) return (await item.getType(type)).arrayBuffer();
      }
      return null;
    },
  };
}
