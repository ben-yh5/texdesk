// The Settings window: every setting with a control, grouped into sections, plus Plugins and
// (in a set-up workspace) the workspace's folder types and templates. A switch at the top picks
// where a change is saved: Global (~/.config/texdesk/settings.json, every workspace) or This
// workspace (.texdesk/workspace.json, on top of the global settings). A setting this workspace
// overrides is marked, with a button to go back to the global value.

import { For, JSX, Show, createSignal, onCleanup } from "solid-js";
import { CommandId, DEFAULT_KEYS, Raw, WorkspaceConfig, defaultConfig, hasSettingKey } from "../workspace/config";
import { formatKey, isMac } from "./keys";
import { PluginsPane, PluginsPaneProps } from "./PluginsPane";
import { WorkspacePane, WorkspacePaneProps } from "./WorkspacePane";

type Value = boolean | number | string | string[];

export interface Setting {
  /** Settings table ("" = top level) and key, as in settings.json. */
  table: string;
  key: string;
  label: string;
  desc?: string;
  type: "toggle" | "number" | "text" | "select" | "list";
  options?: { value: string; label: string }[];
  placeholder?: string;
  get: (c: WorkspaceConfig) => Value;
  /** The value as saved (default: as shown). */
  save?: (v: Value) => unknown;
}

const ed = <K extends keyof WorkspaceConfig["editor"]>(k: K) => ({ get: (c: WorkspaceConfig) => c.editor[k] as Value });
const build = <K extends keyof WorkspaceConfig["build"]>(k: K) => ({ get: (c: WorkspaceConfig) => c.build[k] as Value });
const top = <K extends keyof WorkspaceConfig>(k: K) => ({ get: (c: WorkspaceConfig) => c[k] as Value });

export const SECTIONS: { id: string; label: string; settings: Setting[] }[] = [
  {
    id: "editor", label: "Editor", settings: [
      { table: "editor", key: "theme", label: "Theme", type: "select", options: [{ value: "system", label: "Match system" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }], ...ed("theme") },
      { table: "editor", key: "font_size", label: "Font size", desc: "In pixels.", type: "number", ...ed("fontSize") },
      { table: "editor", key: "font_family", label: "Font", desc: "A monospace font installed on this Mac. Empty uses the default.", type: "text", placeholder: "JetBrains Mono", ...ed("fontFamily") },
      { table: "editor", key: "line_numbers", label: "Line numbers", type: "toggle", ...ed("lineNumbers") },
      { table: "editor", key: "relative_line_numbers", label: "Relative line numbers", desc: "Count lines up and down from the cursor, as in Vim.", type: "toggle", ...ed("relativeLineNumbers") },
      { table: "editor", key: "line_wrapping", label: "Wrap long lines", type: "toggle", ...ed("lineWrapping") },
      { table: "editor", key: "math_preview", label: "Math preview", desc: "A rendered preview of the math under the cursor.", type: "toggle", ...ed("mathPreview") },
      { table: "editor", key: "spellcheck", label: "Spellcheck", desc: "Underline misspellings in the prose as you type. ⌘L fixes the last one before the cursor.", type: "toggle", ...ed("spellcheck") },
      { table: "editor", key: "auto_pair_brackets", label: "Auto-pair brackets", desc: "{ becomes {} in text and \\{ becomes \\{\\}; typing a closer that's already there steps over it.", type: "toggle", ...ed("autoPairBrackets") },
      { table: "editor", key: "auto_enlarge_brackets", label: "Auto-enlarge brackets", desc: "( … ) around \\frac, \\sum, \\int… becomes \\left( … \\right) when you close it.", type: "toggle", ...ed("autoEnlargeBrackets") },
      { table: "editor", key: "vim", label: "Vim mode", desc: "Vim keybindings: normal, insert and visual modes, :w saves.", type: "toggle", ...ed("vim") },
    ],
  },
  {
    id: "build", label: "Build & PDF", settings: [
      { table: "build", key: "auto_compile_delay_ms", label: "Pause before building", desc: "Documents build by themselves: after this many milliseconds without typing, and on every save.", type: "number", ...build("autoCompileDelayMs") },
      { table: "build", key: "debounce_ms", label: "Save debounce", desc: "Milliseconds to wait after a save before building.", type: "number", ...build("debounceMs") },
      { table: "editor", key: "follow_edits", label: "PDF follows the editor", desc: "Double-clicking a line, and each build after an edit, scroll the PDF to that line. Also switched on the PDF itself.", type: "toggle", ...ed("followEdits") },
      { table: "", key: "export_pdf", label: "Copy PDF next to the source", desc: "After every build, copy the PDF next to its .tex file under the name below.", type: "toggle", ...top("exportPdf") },
      { table: "", key: "pdf_name", label: "Exported PDF name", desc: "{{stem}} (the file name) and template variables like {{course}} are filled in.", type: "text", ...top("pdfName") },
      {
        table: "", key: "tectonic", label: "Tectonic path", desc: "Only needed if Tectonic isn't found automatically.", type: "text", placeholder: "/opt/homebrew/bin/tectonic",
        get: (c) => c.tectonic ?? "",
      },
    ],
  },
  {
    id: "files", label: "Files & folders", settings: [
      { table: "vars", key: "author", label: "Your name", desc: "Templates fill it in as {{author}}.", type: "text", placeholder: "Ada Lovelace", get: (c) => c.vars.author ?? "" },
      {
        table: "", key: "figures_dir", label: "Figures folder", desc: "Where pasted images go, relative to the workspace. Empty puts them in a figures folder next to each file. A folder type can set its own.",
        type: "text", placeholder: "figures", get: (c) => c.figuresDir ?? "",
      },
      {
        table: "", key: "folder_click", label: "Clicking a folder's name", desc: "In the file tree. The arrow next to a folder always just opens or closes it.",
        type: "select", options: [{ value: "overview", label: "Shows its overview" }, { value: "expand", label: "Only opens it in the tree" }], ...top("folderClick"),
      },
      { table: "", key: "ignore", label: "Hidden files", desc: "Hidden from the file tree and ⌘K. One gitignore pattern per line.", type: "list", ...top("ignore") },
    ],
  },
];

/** Where a change is saved. */
export type SettingsScope = "global" | "workspace";

/** "Mod-Shift-k" from a key event, or null for a lone modifier. */
export function keySpec(e: KeyboardEvent, mac = isMac): string | null {
  if (["Meta", "Control", "Shift", "Alt", "CapsLock", "Fn"].includes(e.key)) return null;
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (mac && e.ctrlKey) parts.push("Ctrl");
  if (!mac && e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  // With Alt or Shift held, e.key is the shifted symbol; e.code gives the key itself.
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (key.length === 1) key = key.toLowerCase();
  if (key === " ") key = "Space";
  return [...parts, key].join("-");
}

export interface SettingsProps {
  /** The settings in effect in this workspace (global ones with the workspace's on top). */
  config: () => WorkspaceConfig;
  /** The global settings alone. */
  globalConfig: () => WorkspaceConfig;
  /** This workspace's own settings (null when no workspace is set up). */
  workspaceSettings: () => Raw | null;
  /** False when there's no global settings folder (nothing to save global settings to). */
  canSaveGlobal: () => boolean;
  /** Saves one setting (undefined removes it: the workspace goes back to the global value, the global one to the default). */
  onChange: (scope: SettingsScope, table: string, key: string, value: unknown) => void;
  /** Commands with a configurable shortcut, for the Hotkeys section. */
  commands: { id: CommandId; label: string }[];
  /** Section to open at. */
  initialSection?: string;
  plugins: Omit<PluginsPaneProps, "scope">;
  /** Null outside a set-up workspace. */
  workspace: () => WorkspacePaneProps | null;
  onOpenSettingsFile: (scope: SettingsScope) => void;
  onClose: () => void;
}

export function SettingsView(props: SettingsProps) {
  const [section, setSection] = createSignal(props.initialSection ?? "editor");
  const [scope, setScope] = createSignal<SettingsScope>(props.workspaceSettings() ? "workspace" : "global");
  const [recording, setRecording] = createSignal<CommandId | null>(null);
  const [filter, setFilter] = createSignal("");

  const shownConfig = () => (scope() === "global" ? props.globalConfig() : props.config());
  const overridden = (table: string, key: string) => {
    const w = props.workspaceSettings();
    return scope() === "workspace" && !!w && hasSettingKey(w, table, key);
  };
  const canSave = () => (scope() === "global" ? props.canSaveGlobal() : !!props.workspaceSettings());

  const change = (s: Setting, v: Value) => props.onChange(scope(), s.table, s.key, s.save ? s.save(v) : v);
  const setKey = (id: CommandId, spec: string) => props.onChange(scope(), "keys", id, spec);

  // Escape closes (or cancels recording); while recording, the next key combo is the shortcut.
  const onKey = (e: KeyboardEvent) => {
    const id = recording();
    if (id) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return void setRecording(null);
      const spec = keySpec(e);
      if (!spec) return;
      setKey(id, spec);
      setRecording(null);
      return;
    }
    if (e.key === "Escape" && !document.querySelector(".pal-backdrop")) { e.preventDefault(); props.onClose(); }
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const control = (s: Setting): JSX.Element => {
    const v = () => s.get(shownConfig());
    const disabled = () => !canSave();
    switch (s.type) {
      case "toggle":
        return (
          <button
            class={`set-toggle ${v() ? "on" : ""}`} role="switch" aria-checked={!!v()} aria-label={s.label} disabled={disabled()}
            onClick={() => change(s, !v())}
          ><span /></button>
        );
      case "select":
        return (
          <select class="set-input" value={v() as string} disabled={disabled()} onChange={(e) => change(s, e.currentTarget.value)}>
            <For each={s.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
          </select>
        );
      case "number":
        return (
          <input
            class="set-input set-number" type="number" value={v() as number} disabled={disabled()}
            onChange={(e) => { const n = Number(e.currentTarget.value); if (Number.isFinite(n) && n >= 0) change(s, n); else e.currentTarget.value = String(v()); }}
          />
        );
      case "list":
        return (
          <textarea
            class="set-input set-list" rows={4} value={(v() as string[]).join("\n")} disabled={disabled()} spellcheck={false}
            onChange={(e) => change(s, e.currentTarget.value.split("\n").map((x) => x.trim()).filter(Boolean))}
          />
        );
      default:
        return (
          <input
            class="set-input" value={v() as string} placeholder={s.placeholder ?? ""} disabled={disabled()} spellcheck={false}
            onChange={(e) => change(s, e.currentTarget.value)}
          />
        );
    }
  };

  const NAV = () => [
    ...SECTIONS.map((s) => ({ id: s.id, label: s.label })),
    { id: "keys", label: "Hotkeys" },
    { id: "plugins", label: "Plugins" },
    ...(props.workspace() ? [{ id: "workspace", label: "Workspace" }] : []),
  ];
  const matches = (label: string, desc = "") => {
    const q = filter().trim().toLowerCase();
    return !q || `${label} ${desc}`.toLowerCase().includes(q);
  };
  const visible = () => {
    if (filter().trim()) return SECTIONS.flatMap((sec) => sec.settings.filter((s) => matches(s.label, s.desc)));
    return SECTIONS.find((sec) => sec.id === section())?.settings ?? [];
  };
  const visibleKeys = () => props.commands.filter((c) => filter().trim() ? matches(c.label, "shortcut hotkey") : section() === "keys");
  /** Plugins and Workspace aren't plain settings; the scope switch only matters for Plugins. */
  const special = () => !filter().trim() && (section() === "plugins" || section() === "workspace");

  const conflict = (id: CommandId) => {
    const spec = shownConfig().keys[id];
    if (!spec) return null;
    const other = props.commands.find((c) => c.id !== id && shownConfig().keys[c.id] === spec);
    return other ? `Also used by ${other.label}` : null;
  };

  const Reset = (p: { table: string; k: string }) => (
    <Show when={overridden(p.table, p.k)}>
      <button class="set-icon set-override" title="This workspace sets its own value — click to use the global one" onClick={() => props.onChange("workspace", p.table, p.k, undefined)}>
        this workspace ↺
      </button>
    </Show>
  );

  return (
    <div class="set-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="set" role="dialog" aria-label="Settings">
        <nav class="set-nav">
          <input class="set-search" placeholder="Search settings" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} spellcheck={false} />
          <For each={NAV()}>
            {(s) => (
              <button class={`set-nav-item ${!filter().trim() && section() === s.id ? "active" : ""}`} onClick={() => { setFilter(""); setSection(s.id); }}>
                {s.label}
              </button>
            )}
          </For>
          <div class="set-nav-foot">
            <button class="set-link" onClick={() => props.onOpenSettingsFile(scope())} disabled={!canSave()}>
              Open {scope() === "global" ? "settings.json" : "workspace.json"}
            </button>
          </div>
        </nav>
        <div class="set-body">
          <div class="set-head">
            <h2>{filter().trim() ? "Search results" : NAV().find((s) => s.id === section())?.label}</h2>
            <span class="ov-spacer" />
            <Show when={section() !== "workspace" || filter().trim()}>
              <div class="set-scope" role="radiogroup" aria-label="Save changes for">
                <button class={`set-scope-btn ${scope() === "global" ? "active" : ""}`} role="radio" aria-checked={scope() === "global"} onClick={() => setScope("global")} title="Saved in ~/.config/texdesk/settings.json, for every workspace">Global</button>
                <button class={`set-scope-btn ${scope() === "workspace" ? "active" : ""}`} role="radio" aria-checked={scope() === "workspace"} disabled={!props.workspaceSettings()} onClick={() => setScope("workspace")} title="Saved in this workspace's .texdesk/workspace.json, on top of the global settings">This workspace</button>
              </div>
            </Show>
            <button class="set-close" aria-label="Close" onClick={props.onClose}>✕</button>
          </div>
          <Show when={scope() === "workspace" && !special()}>
            <div class="set-note">Changes here apply to this workspace only. Settings it doesn't change follow your global settings.</div>
          </Show>
          <Show when={!canSave() && !special()}>
            <div class="set-note">{scope() === "global" ? "There's no global settings folder, so settings can't be saved." : "This folder isn't set up with TeXdesk, so its settings can't be saved."}</div>
          </Show>
          <Show when={!special()}>
            <For each={visible()}>
              {(s) => (
                <div class="set-row">
                  <div class="set-info">
                    <div class="set-label">{s.label}</div>
                    <Show when={s.desc}><div class="set-desc">{s.desc}</div></Show>
                  </div>
                  <div class="set-control"><Reset table={s.table} k={s.key} />{control(s)}</div>
                </div>
              )}
            </For>
            <For each={visibleKeys()}>
              {(c) => (
                <div class="set-row">
                  <div class="set-info">
                    <div class="set-label">{c.label}</div>
                    <Show when={conflict(c.id)}>{(msg) => <div class="set-error">{msg()}</div>}</Show>
                  </div>
                  <div class="set-control set-keys">
                    <Reset table="keys" k={c.id} />
                    <button class={`set-key ${recording() === c.id ? "recording" : ""}`} disabled={!canSave()} onClick={() => setRecording(recording() === c.id ? null : c.id)}>
                      {recording() === c.id ? "Press keys…" : shownConfig().keys[c.id] ? formatKey(shownConfig().keys[c.id]) : "None"}
                    </button>
                    <Show when={shownConfig().keys[c.id] !== DEFAULT_KEYS[c.id]}>
                      <button class="set-icon" title={`Reset to ${formatKey(DEFAULT_KEYS[c.id]) || "none"}`} disabled={!canSave()} onClick={() => setKey(c.id, DEFAULT_KEYS[c.id])}>↺</button>
                    </Show>
                    <Show when={shownConfig().keys[c.id]}>
                      <button class="set-icon" title="Remove shortcut" disabled={!canSave()} onClick={() => setKey(c.id, "")}>✕</button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Show>
          <Show when={!filter().trim() && section() === "plugins"}>
            <PluginsPane {...props.plugins} scope={scope} />
          </Show>
          <Show when={!filter().trim() && section() === "workspace" && props.workspace()}>
            {(w) => <WorkspacePane {...w()} />}
          </Show>
          <Show when={filter().trim() && !visible().length && !visibleKeys().length}>
            <div class="set-empty">No settings match.</div>
          </Show>
          <Show when={!filter().trim() && scope() === "global" && SECTIONS.some((x) => x.id === section())}>
            <div class="set-foot">
              <button class="set-link" disabled={!canSave()} onClick={() => {
                for (const s of SECTIONS.find((x) => x.id === section())!.settings)
                  if (JSON.stringify(s.get(defaultConfig)) !== JSON.stringify(s.get(props.globalConfig()))) props.onChange("global", s.table, s.key, undefined);
              }}>Restore defaults for this section</button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
