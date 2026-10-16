// Settings → Workspace: this workspace's folder types and templates, edited in place. Every
// change is saved to .texdesk/workspace.json as you make it (text boxes when you leave them).

import { For, Show, createSignal } from "solid-js";
import type { FieldDef, FolderType, ScaffoldEntry, TemplateDef, WorkspaceFile } from "../workspace/model";
import { keyFor } from "../workspace/model";
import type { Raw } from "../workspace/config";

export interface WorkspacePaneProps {
  ws: () => WorkspaceFile;
  errors: () => string[];
  /** Applies a change to workspace.json (read fresh, changed, written back). */
  update: (fn: (ws: WorkspaceFile) => WorkspaceFile) => Promise<void>;
  /** Renames a type's key everywhere, template bodies too; an error message or null. */
  renameType: (from: string, to: string) => Promise<string | null>;
  renameField: (type: string, from: string, to: string) => Promise<string | null>;
  /** How many folders have this type. */
  folderCount: (type: string) => number;
  /** Opens a template's body in the editor (closing Settings). */
  editBody: (key: string) => void;
  /** Creates a template (entry and body); its key. */
  newTemplate: (label: string) => Promise<string | null>;
  /** Renames a template's body file; an error message or null. */
  renameBody: (key: string, name: string) => Promise<string | null>;
  /** Where a template's next file would go, e.g. "Fa30/CS150/hw/hw5.tex" (null if there's no example). */
  examplePath: (key: string) => string | null;
  /** A folder name a type's pattern makes, with made-up field values. */
  exampleName: (type: FolderType) => string;
  applyStarter: () => void;
  openFile: () => void;
  /** Asks a yes/no question (the app's own dialog). */
  confirm: (title: string, yes: string) => Promise<boolean>;
}

const Field = (p: { label: string; desc?: string; children: unknown }) => (
  <div class="wsp-row">
    <div class="wsp-label">{p.label}<Show when={p.desc}><div class="set-desc">{p.desc}</div></Show></div>
    <div class="wsp-control">{p.children as never}</div>
  </div>
);

export function WorkspacePane(props: WorkspacePaneProps) {
  const [pane, setPane] = createSignal<"types" | "templates">("types");
  const [type, setType] = createSignal<string | null>(Object.keys(props.ws().folderTypes)[0] ?? null);
  const [template, setTemplate] = createSignal<string | null>(Object.keys(props.ws().templates)[0] ?? null);
  const [error, setError] = createSignal<string | null>(null);

  const types = () => Object.entries(props.ws().folderTypes);
  const templates = () => Object.entries(props.ws().templates);
  const current = () => { const k = type(); return k ? props.ws().folderTypes[k] : undefined; };
  const currentTemplate = () => { const k = template(); return k ? props.ws().templates[k] : undefined; };

  const setTypeKey = (patch: Partial<FolderType>) => {
    const k = type();
    if (!k) return;
    void props.update((ws) => {
      const t = ws.folderTypes[k];
      if (!t) return ws;
      const next = Object.fromEntries(Object.entries({ ...t, ...patch }).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as unknown as FolderType;
      return { ...ws, folderTypes: { ...ws.folderTypes, [k]: next } };
    });
  };
  const setTemplateKey = (patch: Partial<TemplateDef>) => {
    const k = template();
    if (!k) return;
    void props.update((ws) => {
      const t = ws.templates[k];
      if (!t) return ws;
      const next = Object.fromEntries(Object.entries({ ...t, ...patch }).filter(([, v]) => v !== undefined && v !== "")) as unknown as TemplateDef;
      return { ...ws, templates: { ...ws.templates, [k]: next } };
    });
  };
  const setTypeSetting = (key: string, value: unknown) => {
    const t = current();
    if (!t) return;
    const s: Raw = { ...(t.settings ?? {}) };
    if (value === undefined || value === "") delete s[key]; else s[key] = value;
    setTypeKey({ settings: Object.keys(s).length ? s : undefined });
  };

  const addType = () => {
    const label = "New type";
    const key = keyFor(label, Object.keys(props.ws().folderTypes));
    void props.update((ws) => ({ ...ws, folderTypes: { ...ws.folderTypes, [key]: { label } } })).then(() => setType(key));
  };
  const deleteType = async (k: string) => {
    const n = props.folderCount(k);
    const label = props.ws().folderTypes[k]?.label ?? k;
    if (n && !(await props.confirm(`Delete the ${label} type? ${n} folder${n === 1 ? "" : "s"} will become plain folders (nothing on disk changes)`, `Delete ${label}`))) return;
    await props.update((ws) => {
      const folderTypes: WorkspaceFile["folderTypes"] = {};
      for (const [key, t] of Object.entries(ws.folderTypes)) {
        if (key !== k) folderTypes[key] = t.children?.includes(k) ? { ...t, children: t.children.filter((c) => c !== k) } : t;
      }
      const folders: WorkspaceFile["folders"] = {};
      for (const [p, f] of Object.entries(ws.folders)) {
        if (f.type !== k) { folders[p] = f; continue; }
        const { type: _, ...rest } = f;
        if (Object.keys(rest).length) folders[p] = rest;
      }
      return { ...ws, folderTypes, folders };
    });
    setType(Object.keys(props.ws().folderTypes)[0] ?? null);
  };

  const fields = () => current()?.fields ?? [];
  const setFields = (f: FieldDef[]) => setTypeKey({ fields: f });
  const scaffold = () => current()?.scaffold ?? [];
  const setScaffold = (s: ScaffoldEntry[]) => setTypeKey({ scaffold: s });

  return (
    <div class="wsp">
      <div class="wsp-tabs">
        <button class={`wsp-tab ${pane() === "types" ? "active" : ""}`} onClick={() => setPane("types")}>Folder types</button>
        <button class={`wsp-tab ${pane() === "templates" ? "active" : ""}`} onClick={() => setPane("templates")}>Templates</button>
        <span class="ov-spacer" />
        <button class="set-link" onClick={props.applyStarter}>Apply a starter…</button>
        <button class="set-link" onClick={props.openFile}>Open workspace.json</button>
      </div>
      <Show when={props.errors().length}><div class="set-error wsp-errors">{props.errors().join("; ")}</div></Show>
      <Show when={error()}><div class="set-error wsp-errors">{error()}</div></Show>

      <Show when={pane() === "types"}>
        <div class="set-desc wsp-intro">
          Folder types are kinds of folders — like Term and Class, or Project and Chapter. A typed folder asks for its fields when you make it,
          gets its subfolders made for it, and has an overview page. Give a folder a type by making it with “New …”, or right-click it → Set folder type.
        </div>
        <div class="wsp-split">
          <div class="wsp-list">
            <For each={types()}>{([k, t]) => <button class={`wsp-item ${type() === k ? "active" : ""}`} onClick={() => setType(k)}>{t.label}<span class="wsp-item-detail">{props.folderCount(k)} folder{props.folderCount(k) === 1 ? "" : "s"}</span></button>}</For>
            <Show when={!types().length}><div class="ov-empty">No folder types yet</div></Show>
            <button class="ov-new-btn wsp-add" onClick={addType}>+ Folder type</button>
          </div>
          <Show when={current()} fallback={<div class="wsp-form ov-empty">Add a folder type to get started.</div>}>
            {(t) => (
              <div class="wsp-form">
                <Field label="Name"><input class="set-input" value={t().label} onChange={(e) => setTypeKey({ label: e.currentTarget.value.trim() || type()! })} /></Field>
                <Field label="Key" desc={`Used in template variables: {{${type()}_folder}} is a folder's name, {{${type()}.field}} one of its fields`}>
                  <input class="set-input" value={type()!} spellcheck={false} onChange={async (e) => {
                    const to = e.currentTarget.value.trim();
                    const err = await props.renameType(type()!, to);
                    setError(err);
                    if (err) e.currentTarget.value = type()!; else setType(to);
                  }} />
                </Field>
                <Field label="Fields" desc="Asked for when a folder of this type is made, and usable in templates as {{key}}">
                  <div class="wsp-fields">
                    <Show when={fields().length}><div class="wsp-field wsp-field-head"><span class="wsp-key">Key</span><span class="wsp-grow">Question</span><span title="Required">Req.</span></div></Show>
                    <For each={fields()}>
                      {(f, i) => (
                        <div class="wsp-field">
                          <input class="set-input wsp-key" value={f.key} spellcheck={false} title="Key (letters, digits and _)" onChange={async (e) => {
                            const err = await props.renameField(type()!, f.key, e.currentTarget.value.trim());
                            setError(err);
                            if (err) e.currentTarget.value = f.key;
                          }} />
                          <input class="set-input" value={f.label} placeholder="Question, e.g. Course name" onChange={(e) => setFields(fields().map((x, j) => (j === i() ? { ...x, label: e.currentTarget.value.trim() || x.key } : x)))} />
                          <label class="ov-check wsp-req" title="Required: must be filled in"><input type="checkbox" aria-label="Required" checked={!!f.required} onChange={(e) => setFields(fields().map((x, j) => (j === i() ? { ...x, required: e.currentTarget.checked || undefined } : x)))} /></label>
                          <button class="set-icon" title="Move up" disabled={i() === 0} onClick={() => { const a = [...fields()]; [a[i() - 1], a[i()]] = [a[i()], a[i() - 1]]; setFields(a); }}>↑</button>
                          <button class="set-icon" title="Remove" onClick={() => setFields(fields().filter((_, j) => j !== i()))}>✕</button>
                        </div>
                      )}
                    </For>
                    <button class="set-link" onClick={() => setFields([...fields(), { key: keyFor("field", fields().map((f) => f.key)), label: "New field" }])}>+ Field</button>
                  </div>
                </Field>
                <Field label="Folder name" desc={t().name ? `e.g. ${props.exampleName(t())}` : "Empty: asked for each time"}>
                  <input class="set-input" value={t().name ?? ""} placeholder={fields().length ? `e.g. {{${fields()[0].key}}}` : "(ask)"} spellcheck={false} onChange={(e) => setTypeKey({ name: e.currentTarget.value.trim() || undefined })} />
                </Field>
                <Field label="Can contain" desc="Folder types that can be made inside it (a New button on its overview)">
                  <div class="ov-picker">
                    <For each={types()}>{([k, x]) => (
                      <label class="ov-check"><input type="checkbox" checked={!!t().children?.includes(k)} onChange={(e) => setTypeKey({ children: e.currentTarget.checked ? [...(t().children ?? []), k] : (t().children ?? []).filter((c) => c !== k) })} /> {x.label}</label>
                    )}</For>
                  </div>
                </Field>
                <Field label="Starts with" desc="Made inside each new folder: “notes/” is a folder; a file can start from a template">
                  <div class="wsp-fields">
                    <For each={scaffold()}>
                      {(s, i) => {
                        const path = () => (typeof s === "string" ? s : s.path);
                        const tpl = () => (typeof s === "string" ? "" : s.template ?? "");
                        const put = (p: string, tp: string) => setScaffold(scaffold().map((x, j) => (j === i() ? (tp && !p.endsWith("/") ? { path: p, template: tp } : p) : x)));
                        return (
                          <div class="wsp-field">
                            <input class="set-input" value={path()} spellcheck={false} onChange={(e) => put(e.currentTarget.value.trim(), tpl())} />
                            <Show when={!path().endsWith("/")}>
                              <select class="set-input wsp-narrow" value={tpl()} onChange={(e) => put(path(), e.currentTarget.value)}>
                                <option value="">Empty file</option>
                                <For each={templates()}>{([k, x]) => <option value={k}>From {x.label ?? k}</option>}</For>
                              </select>
                            </Show>
                            <button class="set-icon" title="Remove" onClick={() => setScaffold(scaffold().filter((_, j) => j !== i()))}>✕</button>
                          </div>
                        );
                      }}
                    </For>
                    <span>
                      <button class="set-link" onClick={() => setScaffold([...scaffold(), "folder/"])}>+ Subfolder</button>{"  "}
                      <button class="set-link" onClick={() => setScaffold([...scaffold(), "README.tex"])}>+ File</button>
                    </span>
                  </div>
                </Field>
                <Field label="Overview order" desc="Names listed first on its overview, e.g. notes, hw — the rest follow">
                  <input class="set-input" value={(t().order ?? []).join(", ")} placeholder="(by date)" onChange={(e) => setTypeKey({ order: e.currentTarget.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
                </Field>
                <Field label="Then sorted by">
                  <select class="set-input" value={t().sort ?? "created"} onChange={(e) => setTypeKey({ sort: e.currentTarget.value === "created" ? undefined : e.currentTarget.value as FolderType["sort"] })}>
                    <option value="created">Date created</option><option value="modified">Date edited</option><option value="name">Name</option>
                  </select>
                </Field>
                <Field label="Figures folder" desc="Where pasted images go, inside each folder of this type (also searched by builds)">
                  <input class="set-input" value={(t().settings?.figures_dir as string) ?? ""} placeholder="(next to each file)" onChange={(e) => setTypeSetting("figures_dir", e.currentTarget.value.trim())} />
                </Field>
                <Field label="Exported PDF name" desc="When PDFs are copied next to their source; {{stem}} is the file name">
                  <input class="set-input" value={(t().settings?.pdf_name as string) ?? ""} placeholder="(workspace default)" onChange={(e) => setTypeSetting("pdf_name", e.currentTarget.value.trim())} />
                </Field>
                <Field label="Overview layout" desc="Open a folder's overview and click Edit layout to change it">
                  <span class="set-desc">{t().overview ? `“${t().overview}”` : "Default (header, New buttons, files)"}</span>
                </Field>
                <div class="wsp-foot"><button class="set-link wsp-danger" onClick={() => void deleteType(type()!)}>Delete this folder type</button></div>
              </div>
            )}
          </Show>
        </div>
      </Show>

      <Show when={pane() === "templates"}>
        <div class="set-desc wsp-intro">
          Templates are the documents new files start from. A template can get its own “New …” button and command, and say which folder its files go in.
          {" {{date}} {{title}} {{n}}"}, your variables and folder fields are filled in; $0 is where the cursor goes.
        </div>
        <div class="wsp-split">
          <div class="wsp-list">
            <For each={templates()}>{([k, t]) => <button class={`wsp-item ${template() === k ? "active" : ""}`} onClick={() => setTemplate(k)}>{t.label ?? k}<span class="wsp-item-detail">{t.body}</span></button>}</For>
            <Show when={!templates().length}><div class="ov-empty">No templates yet</div></Show>
            <button class="ov-new-btn wsp-add" onClick={async () => { const k = await props.newTemplate("New template"); if (k) setTemplate(k); }}>+ Template</button>
          </div>
          <Show when={currentTemplate()} fallback={<div class="wsp-form ov-empty">Add a template to get started.</div>}>
            {(t) => (
              <div class="wsp-form">
                <Field label="Name" desc="Its button and command are “New <name>”">
                  <input class="set-input" value={t().label ?? ""} placeholder={template()!} onChange={(e) => setTemplateKey({ label: e.currentTarget.value.trim() || undefined })} />
                </Field>
                <Field label="Body" desc="Its file in .texdesk/templates">
                  <div class="wsp-body">
                    <input class="set-input" value={t().body} spellcheck={false} aria-label="Template file name" onChange={async (e) => {
                      const input = e.currentTarget;
                      const err = await props.renameBody(template()!, input.value);
                      setError(err);
                      if (err) input.value = t().body;
                    }} />
                    <button class="set-button" onClick={() => props.editBody(template()!)}>Edit template…</button>
                  </div>
                </Field>
                <Field label="Goes in" desc="The nearest folder of this type above the open file (or one you pick)">
                  <select class="set-input" value={t().in ?? ""} onChange={(e) => setTemplateKey({ in: e.currentTarget.value || undefined })}>
                    <option value="">The open file's folder</option>
                    <For each={types()}>{([k, x]) => <option value={k}>{x.label} folder</option>}</For>
                  </select>
                </Field>
                <Field label="Subfolder" desc="e.g. hw — made if it doesn't exist">
                  <input class="set-input" value={t().dir ?? ""} placeholder="(none)" spellcheck={false} onChange={(e) => setTemplateKey({ dir: e.currentTarget.value.trim().replace(/^\/+|\/+$/g, "") || undefined })} />
                </Field>
                <Field label="File name" desc={`{{n}} numbers files (hw{{n}}.tex → hw4.tex); other variables are asked for${props.examplePath(template()!) ? ` — next: ${props.examplePath(template()!)}` : ""}`}>
                  <input class="set-input" value={t().name ?? ""} placeholder="{{title}}.tex" spellcheck={false} onChange={(e) => setTemplateKey({ name: e.currentTarget.value.trim() || undefined })} />
                </Field>
                <Field label="Also ask for" desc="Variables to ask for before creating, and the question for each">
                  <div class="wsp-fields">
                    <For each={Object.entries(t().prompt ?? {})}>
                      {([name, q]) => (
                        <div class="wsp-field">
                          <input class="set-input wsp-key" value={name} spellcheck={false} onChange={(e) => {
                            const nn = e.currentTarget.value.trim();
                            const entries = Object.entries(t().prompt ?? {}).map(([k, v]) => (k === name ? [nn, v] : [k, v])).filter(([k]) => k);
                            setTemplateKey({ prompt: entries.length ? Object.fromEntries(entries) as Record<string, string> : undefined });
                          }} />
                          <input class="set-input" value={q} onChange={(e) => setTemplateKey({ prompt: { ...t().prompt, [name]: e.currentTarget.value } })} />
                          <button class="set-icon" title="Remove" onClick={() => { const p = { ...t().prompt }; delete p[name]; setTemplateKey({ prompt: Object.keys(p).length ? p : undefined }); }}>✕</button>
                        </div>
                      )}
                    </For>
                    <button class="set-link" onClick={() => setTemplateKey({ prompt: { ...t().prompt, [keyFor("topic", Object.keys(t().prompt ?? {}))]: "Topic" } })}>+ Question</button>
                  </div>
                </Field>
                <div class="wsp-foot">
                  <button class="set-link wsp-danger" onClick={() => {
                    const k = template()!;
                    void props.update((ws) => { const templates = { ...ws.templates }; delete templates[k]; return { ...ws, templates }; })
                      .then(() => setTemplate(Object.keys(props.ws().templates)[0] ?? null));
                  }}>Remove this template</button>
                  <span class="set-desc"> (its file stays in .texdesk/templates)</span>
                </div>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
