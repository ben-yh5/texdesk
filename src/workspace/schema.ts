// JSON Schema for workspace.json, written beside it (`.texdesk/workspace.schema.json`) so
// editors like VS Code autocomplete and check it when it's opened as text.

const str = { type: "string" };
const strList = { type: "array", items: str };
const bool = { type: "boolean" };

const settings = {
  type: "object",
  description: "Settings for this workspace, on top of your global ones (~/.config/texdesk/settings.json).",
  properties: {
    vars: { type: "object", additionalProperties: str, description: "Template variables, e.g. author." },
    export_pdf: bool,
    pdf_name: str,
    figures_dir: str,
    ignore: strList,
    tectonic: str,
    editor: { type: "object" },
    build: { type: "object" },
    ai: { type: "object" },
    keys: { type: "object", additionalProperties: str },
    plugins: { type: "object", additionalProperties: bool, description: "Plugin id → on/off in this workspace." },
  },
};

const block = {
  type: "object",
  required: ["type"],
  properties: {
    type: { enum: ["header", "templates", "files", "subfolders"] },
    title: str, fields: strList, up: bool, links: strList, templates: strList, folders: strList,
    subfolder: str, inType: str, docs: bool, pdfs: bool, other: bool, name: str, modifiedDays: { type: "number" },
    groupBy: { enum: ["subfolder", "typed", "none"] }, sort: { enum: ["order", "name", "title", "created", "modified"] }, desc: bool,
    showTitle: bool, showDate: bool, showLinks: bool, showPdf: bool, limit: { type: "number" },
    folderType: str, display: { enum: ["compact", "full"] }, counts: strList,
  },
};

export const WORKSPACE_SCHEMA = JSON.stringify({
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "TeXdesk workspace",
  type: "object",
  properties: {
    $schema: str,
    version: { const: 1 },
    settings,
    folderTypes: {
      type: "object",
      description: "Kinds of folders (Term, Class, Project…), by key. The key is used in variables like {{class_folder}}.",
      additionalProperties: {
        type: "object",
        required: ["label"],
        properties: {
          label: str,
          name: { type: "string", description: "Folder name pattern, e.g. {{code}}." },
          fields: { type: "array", items: { type: "object", required: ["key"], properties: { key: str, label: str, required: bool } } },
          children: strList,
          scaffold: { type: "array", items: { anyOf: [str, { type: "object", required: ["path"], properties: { path: str, template: str } }] } },
          order: strList,
          sort: { enum: ["created", "modified", "name"] },
          settings: { type: "object" },
          overview: str,
        },
      },
    },
    folders: {
      type: "object",
      description: "Workspace-relative folder path → its type and field values.",
      additionalProperties: {
        type: "object",
        properties: { type: str, fields: { type: "object", additionalProperties: str }, order: strList, sort: { enum: ["created", "modified", "name"] }, settings: { type: "object" }, overview: str },
      },
    },
    templates: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["body"],
        properties: { label: str, body: str, in: str, dir: str, name: str, prompt: { type: "object", additionalProperties: str } },
      },
    },
    overviews: { type: "object", additionalProperties: { type: "object", required: ["blocks"], properties: { blocks: { type: "array", items: block } } } },
  },
}, null, 2) + "\n";
