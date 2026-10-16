// Settings → Plugins: every plugin (this workspace's, yours, built-in) with an on/off switch,
// its snippet count and problems, and actions. On/off is saved for every workspace (Global)
// or just this one (This workspace), following the switch at the top of Settings.

import { For, Show } from "solid-js";
import { BUILTIN_PLUGINS, type Plugin } from "../plugins/plugins";
import type { SnippetProblem } from "../snippets/runtime";

export interface PluginsPaneProps {
  plugins: () => Plugin[];
  /** Snippet problems (file names start with "<plugin id>/"). */
  problems: () => SnippetProblem[];
  /** Snippets and key handlers loaded from a plugin. */
  counts: (id: string) => { snippets: number; keys: number };
  scope: () => "global" | "workspace";
  /** This workspace's own on/off for a plugin, if it sets one. */
  workspaceSetting: (id: string) => boolean | undefined;
  /** The global on/off for a plugin, if set. */
  globalSetting: (id: string) => boolean | undefined;
  hasWorkspace: () => boolean;
  /** Whether code from this workspace may run (null: not decided yet). */
  trust: () => boolean | null;
  onTrust(on: boolean): void;
  /** Sets on/off for every workspace or this one (undefined: back to the default / the global setting). */
  onToggle(id: string, on: boolean | undefined, scope: "global" | "workspace"): void;
  /** Opens a plugin's main file, or `file` in it. */
  onOpen(p: Plugin, file?: string): void;
  onReveal(p: Plugin): void;
  onDuplicate(p: Plugin): void;
  onDelete(p: Plugin): void;
  onNew(where: "user" | "workspace"): void;
  onImport(): void;
  onReload(): void;
}

const GROUPS: { source: Plugin["source"]; title: string; desc: string }[] = [
  { source: "workspace", title: "This workspace", desc: "In .texdesk/plugins/ — only for this workspace" },
  { source: "user", title: "Yours", desc: "In ~/.config/texdesk/plugins/ — available in every workspace" },
  { source: "built-in", title: "Built-in", desc: "Shipped with TeXdesk; off until you turn them on. Duplicate one to edit your own copy." },
];

export function PluginsPane(props: PluginsPaneProps) {
  const problemsOf = (id: string) => props.problems().filter((p) => p.file.startsWith(`${id}/`));
  const defaultOn = (p: Plugin) => props.globalSetting(p.id) ?? p.source !== "built-in";

  return (
    <div class="plg">
      <div class="set-desc plg-intro">
        Plugins add snippets and keys to the editor. Each is a folder of <code>.ts</code> snippet files; edit them and they reload as you save.
        A workspace plugin with the same folder name as one of yours replaces it in that workspace.
      </div>
      <div class="plg-actions">
        <button class="set-button" onClick={() => props.onNew("user")}>New plugin…</button>
        <Show when={props.hasWorkspace()}><button class="set-button" onClick={() => props.onNew("workspace")}>New workspace plugin…</button></Show>
        <button class="set-button" onClick={props.onImport}>Import LaTeX Suite snippets…</button>
        <span class="ov-spacer" />
        <button class="set-link" onClick={props.onReload}>Reload</button>
      </div>
      <For each={GROUPS}>
        {(g) => (
          <Show when={props.plugins().some((p) => p.source === g.source)}>
            <h3 class="plg-group">{g.title}<span class="set-desc"> — {g.desc}</span></h3>
            <Show when={g.source === "workspace"}>
              <div class={`plg-trust ${props.trust() === true ? "" : "off"}`}>
                <Show when={props.trust() === true} fallback={
                  <>
                    <span>These plugins are off: they're code from this folder, and you haven't allowed it{props.trust() === false ? "" : " yet"}. Its Tectonic path, if it sets one, isn't used either.</span>
                    <button class="set-button" onClick={() => props.onTrust(true)}>Allow code from this folder</button>
                  </>
                }>
                  <span>Code from this folder is allowed.</span>
                  <button class="set-link" onClick={() => props.onTrust(false)}>Stop allowing</button>
                </Show>
              </div>
            </Show>
            <For each={props.plugins().filter((p) => p.source === g.source)}>
              {(p) => {
                const n = () => props.counts(p.id);
                const probs = () => problemsOf(p.id);
                return (
                  <div class={`set-row plg-row ${p.replacedBy ? "plg-replaced" : ""}`}>
                    <div class="set-info">
                      <div class="set-label">{p.name} <span class="plg-id">{p.id}</span></div>
                      <Show when={p.description}><div class="set-desc">{p.description}</div></Show>
                      <Show when={p.forkedFrom}>{(f) => <div class="set-desc plg-fork">Fork of {BUILTIN_PLUGINS.find((b) => b.id === f())?.name ?? f()} (built-in)</div>}</Show>
                      <Show when={p.replacedBy}><div class="set-desc">Replaced here by the {p.replacedBy === "workspace" ? "workspace's" : "your"} plugin with the same name</div></Show>
                      <Show when={p.enabled && !p.replacedBy}>
                        <div class="set-desc">
                          {n().snippets} snippet{n().snippets === 1 ? "" : "s"}{n().keys ? ` · ${n().keys} key${n().keys === 1 ? "" : "s"}` : ""}
                        </div>
                      </Show>
                      <Show when={p.error}><div class="set-error">{p.error}</div></Show>
                      <For each={probs()}>{(x) => <div class="set-error">{x.file.slice(p.id.length + 1)}{x.label ? ` (${x.label})` : ""}: {x.message}</div>}</For>
                      <div class="plg-links">
                        <Show when={p.dir}><button class="set-link" onClick={() => props.onOpen(p)}>Open</button></Show>
                        <Show when={p.dir}><button class="set-link" onClick={() => props.onReveal(p)}>Reveal in Finder</button></Show>
                        <Show when={p.source !== "workspace"}><button class="set-link" onClick={() => props.onDuplicate(p)}>{p.source === "built-in" ? "Duplicate to edit" : "Copy to this workspace"}</button></Show>
                        <Show when={p.dir}><button class="set-link wsp-danger" onClick={() => props.onDelete(p)}>Delete</button></Show>
                      </div>
                    </div>
                    <div class="set-control">
                      <Show when={props.scope() === "workspace" && props.hasWorkspace()} fallback={
                        <button
                          class={`set-toggle ${defaultOn(p) ? "on" : ""}`} role="switch" aria-checked={defaultOn(p)} aria-label={`${p.name} on in every workspace`}
                          disabled={!!p.replacedBy} onClick={() => { const on = !defaultOn(p); props.onToggle(p.id, on === (p.source !== "built-in") ? undefined : on, "global"); }}
                        ><span /></button>
                      }>
                        <select class="set-input plg-select" aria-label={`${p.name} in this workspace`} value={props.workspaceSetting(p.id) === undefined ? "" : props.workspaceSetting(p.id) ? "on" : "off"}
                          disabled={!!p.replacedBy}
                          onChange={(e) => props.onToggle(p.id, e.currentTarget.value === "" ? undefined : e.currentTarget.value === "on", "workspace")}>
                          <option value="">Global setting ({defaultOn(p) ? "on" : "off"})</option>
                          <option value="on">On here</option>
                          <option value="off">Off here</option>
                        </select>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
          </Show>
        )}
      </For>
    </div>
  );
}
