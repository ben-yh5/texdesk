// Starters: ready-made setups a workspace can begin with (or add later with "Apply starter…").
// A starter is only data — folder types, templates and overview layouts for workspace.json,
// plus template bodies. Nothing in the app depends on which one was used.

import type { FolderType, OverviewLayout, TemplateDef } from "./model";

export interface Starter {
  id: string;
  label: string;
  detail: string;
  folderTypes: Record<string, FolderType>;
  templates: Record<string, TemplateDef>;
  overviews: Record<string, OverviewLayout>;
  /** Template body file name → text. */
  bodies: Record<string, string>;
}

const ARTICLE = `\\documentclass[11pt]{article}
\\usepackage{preamble}
\\title{{{title}}}
\\author{{{author}}}
\\date{{{date}}}
\\begin{document}
\\maketitle

$0
\\end{document}
`;

const HOMEWORK = `\\documentclass[12pt]{article}
\\usepackage{preamble}
\\setlist[enumerate,1]{label=\\textbf{Question \\arabic*:}, wide=0em}
\\setlist[enumerate,2]{label=(\\alph*), leftmargin=2em}
\\setlist[enumerate,3]{label=(\\roman*), leftmargin=2em}
\\begin{document}
\\noindent\\textbf{Name:} {{author}} \\\\
\\textbf{Course:} {{course}} \\\\
\\textbf{Date:} {{date}} \\\\
\\textbf{Assignment:} Problem Set \\#{{n}}\\par\\medskip

\\begin{enumerate}
  \\item $0
\\end{enumerate}
\\end{document}
`;

const NOTE = `\\documentclass[12pt]{article}
\\usepackage{preamble}
\\begin{document}
\\section*{{{title}}}
\\textit{\\link[{{course}}]{{{class_folder}}} \\quad {{date}}}

$0
\\end{document}
`;

const DOCUMENT: TemplateDef = { label: "Document", body: "article.tex", name: "{{title}}.tex" };

export const STARTERS: Starter[] = [
  {
    id: "blank",
    label: "Blank",
    detail: "a Document template and a shared preamble — set up your own folder types later",
    folderTypes: {},
    templates: { article: DOCUMENT },
    overviews: {},
    bodies: { "article.tex": ARTICLE },
  },
  {
    id: "coursework",
    label: "Coursework",
    detail: "Blank, plus Term and Class folders with Homework and Note templates",
    folderTypes: {
      term: { label: "Term", children: ["class"], overview: "term" },
      class: {
        label: "Class",
        fields: [
          { key: "code", label: "Course code, e.g. CS101", required: true },
          { key: "course", label: "Course name, e.g. CS 101" },
        ],
        name: "{{code}}",
        scaffold: ["notes/", "hw/", "figures/"],
        order: ["notes", "hw", "figures"],
        settings: { figures_dir: "figures" },
        overview: "class",
      },
    },
    templates: {
      article: DOCUMENT,
      homework: { label: "Homework", body: "homework.tex", in: "class", dir: "hw", name: "hw{{n}}.tex" },
      note: { label: "Note", body: "note.tex", in: "class", dir: "notes", name: "{{title}}.tex" },
    },
    overviews: {
      term: { blocks: [{ type: "header" }, { type: "templates" }, { type: "files" }] },
      class: { blocks: [{ type: "header", fields: ["course"] }, { type: "templates" }, { type: "files" }] },
    },
    bodies: { "article.tex": ARTICLE, "homework.tex": HOMEWORK, "note.tex": NOTE },
  },
];

export const starterById = (id: string) => STARTERS.find((s) => s.id === id);
