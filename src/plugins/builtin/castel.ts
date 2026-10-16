// Gilles Castel's LaTeX snippets (a built-in TeXdesk plugin; Duplicate it in Settings →
// Plugins to make your own fork to edit).
//
// Ported from https://github.com/gillescastel/latex-snippets (tex.snippets, UltiSnips), the
// setup behind "How I'm able to take notes in mathematics lectures using LaTeX and Vim"
// (https://castel.dev/post/lecture-notes-1/).
//
//   Copyright (c) 2019 Gilles Castel. MIT License:
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following
//   conditions: The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
//   WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
//
// How the UltiSnips options map: A → auto, w → wordBoundary, b → only at the start of a
// line, context "math()" → mode: "math". Differences from the original:
// - Snippets whose output only works in math (\le, \cdot, \R, \sum…) fire only in math here;
//   in the original some fired anywhere.
// - sympy / Mathematica blocks (they run Python / wolframscript) aren't included.
// - Tab stops don't nest (uuu, nnn, nn, prod have one flat stop where the original nested two).
// - mk doesn't add a space after the closing $ by itself; table and fig don't derive the
//   column separators / label from what you type (UltiSnips transformations).
// - The template uses English instead of Dutch babel.

import { snippets, s, type Context } from "texdesk";

const MATH = { mode: "math" } as const;
const AUTO_MATH = { mode: "math", auto: true } as const;

/** Escapes text so it's inserted literally ($1 etc. are tab stops). */
const lit = (t: string) => t.replace(/\$/g, "$$$$");
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A "b" snippet: only when the trigger is all there is on the line (keeping its indentation). */
const atLineStart = (trigger: string, body: string, opts: { auto?: boolean; description?: string } = {}) =>
  s(new RegExp(`^(\\s*)${esc(trigger)}$`), (ctx: Context) => ctx.match![1] + body, { mode: "text", ...opts });

/** `( … )/` → \frac{ … }{…}: the parenthesized group before the slash becomes the numerator. */
function parenFrac(ctx: Context) {
  const stripped = ctx.match![0].slice(0, -1);
  let depth = 0;
  let i = stripped.length - 1;
  for (; i >= 0; i--) {
    if (stripped[i] === ")") depth++;
    if (stripped[i] === "(") depth--;
    if (depth === 0) break;
  }
  if (i < 0) return false;
  return `${lit(stripped.slice(0, i))}\\frac{${lit(stripped.slice(i + 1, -1))}}{$1}$0`;
}

export default snippets([
  // ---- structure ------------------------------------------------------------------
  atLineStart("template", "\\documentclass[a4paper]{article}\n\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{textcomp}\n\\usepackage[english]{babel}\n\\usepackage{amsmath, amssymb}\n\n% figure support\n\\usepackage{import}\n\\usepackage{xifthen}\n\\pdfminorversion=7\n\\usepackage{pdfpages}\n\\usepackage{transparent}\n\\newcommand{\\incfig}[1]{%\n\t\\def\\svgwidth{\\columnwidth}\n\t\\import{./figures/}{#1.pdf_tex}\n}\n\n\\pdfsuppresswarningpagegroup=1\n\n\\begin{document}\n\t$0\n\\end{document}", { description: "Basic template" }),
  atLineStart("beg", "\\begin{$1}\n\t$0\n\\end{$1}", { auto: true, description: "begin{} / end{}" }),
  s("...", "\\ldots", { auto: true, priority: 100 }),
  atLineStart("table", "\\begin{table}[${1:htpb}]\n\t\\centering\n\t\\caption{${2:caption}}\n\t\\label{tab:${3:label}}\n\t\\begin{tabular}{${4:c}}\n\t$0\n\t\\end{tabular}\n\\end{table}", { description: "Table environment" }),
  atLineStart("fig", "\\begin{figure}[${1:htpb}]\n\t\\centering\n\t\\includegraphics[width=0.8\\textwidth]{$2}\n\t\\caption{$3}\n\t\\label{fig:$4}\n\\end{figure}", { description: "Figure environment" }),
  atLineStart("enum", "\\begin{enumerate}\n\t\\item $0\n\\end{enumerate}", { auto: true, description: "Enumerate" }),
  atLineStart("item", "\\begin{itemize}\n\t\\item $0\n\\end{itemize}", { auto: true, description: "Itemize" }),
  atLineStart("desc", "\\begin{description}\n\t\\item[$1] $0\n\\end{description}", { description: "Description" }),
  atLineStart("pac", "\\usepackage[${1:options}]{${2:package}}$0", { description: "Package" }),
  atLineStart("ali", "\\begin{align*}\n\t$1\n.\\end{align*}", { auto: true, description: "Align" }),

  // ---- entering math ----------------------------------------------------------------
  s("mk", "$$$1$$$0", { mode: "text", auto: true, wordBoundary: true, description: "Inline math" }),
  s("dm", "\\[\n$1\n.\\] $0", { mode: "text", auto: true, wordBoundary: true, description: "Display math" }),

  // ---- logic & relations ------------------------------------------------------------
  s("=>", "\\implies", { ...AUTO_MATH }),
  s("=<", "\\impliedby", { ...AUTO_MATH }),
  s("iff", "\\iff", { ...AUTO_MATH }),
  s("==", "&= $1 \\\\", { ...AUTO_MATH }),
  s("!=", "\\neq ", { ...AUTO_MATH }),
  s("<=", "\\le ", { ...AUTO_MATH }),
  s(">=", "\\ge ", { ...AUTO_MATH }),
  s(">>", "\\gg", { ...AUTO_MATH }),
  s("<<", "\\ll", { ...AUTO_MATH }),
  s("~~", "\\sim ", { ...AUTO_MATH }),
  s("EE", "\\exists ", { ...AUTO_MATH }),
  s("AA", "\\forall ", { ...AUTO_MATH }),

  // ---- fractions --------------------------------------------------------------------
  s("//", "\\frac{$1}{$2}$0", { ...AUTO_MATH, description: "Fraction" }),
  s("/", (ctx) => `\\frac{${lit(ctx.selection)}}{$1}$0`, { ...MATH, visual: true, description: "Selection as a fraction's numerator" }),
  s(/((\d+)|(\d*)(\\)?([A-Za-z]+)((\^|_)(\{\d+\}|\d))*)\/$/, (ctx) => `\\frac{${lit(ctx.match![1])}}{$1}$0`, { ...AUTO_MATH, wordBoundary: true, description: "symbol frac" }),
  s(/^.*\)\/$/, parenFrac, { ...AUTO_MATH, priority: 1000, description: "() frac" }),

  // ---- sub- and superscripts --------------------------------------------------------
  s(/([A-Za-z])(\d)$/, (ctx) => `${ctx.match![1]}_${ctx.match![2]}`, { ...AUTO_MATH, wordBoundary: true, description: "auto subscript" }),
  s(/([A-Za-z])_(\d\d)$/, (ctx) => `${ctx.match![1]}_{${ctx.match![2]}}`, { ...AUTO_MATH, wordBoundary: true, description: "auto subscript2" }),
  s("sr", "^2", { ...AUTO_MATH }),
  s("cb", "^3", { ...AUTO_MATH }),
  s("td", "^{$1}$0", { ...AUTO_MATH, description: "to the … power" }),
  s("rd", "^{($1)}$0", { ...AUTO_MATH, description: "to the (…) power" }),
  s("__", "_{$1}$0", { ...AUTO_MATH, description: "subscript" }),
  s("invs", "^{-1}", { ...AUTO_MATH }),
  s("compl", "^{c}", { ...AUTO_MATH }),
  s(/(?<!i)sts$/, "_\\text{$1} $0", { ...AUTO_MATH, description: "text subscript" }),
  s("xnn", "x_{n}", { ...AUTO_MATH }),
  s("ynn", "y_{n}", { ...AUTO_MATH }),
  s("xii", "x_{i}", { ...AUTO_MATH }),
  s("yii", "y_{i}", { ...AUTO_MATH }),
  s("xjj", "x_{j}", { ...AUTO_MATH }),
  s("yjj", "y_{j}", { ...AUTO_MATH }),
  s("xp1", "x_{n+1}", { ...AUTO_MATH }),
  s("xmm", "x_{m}", { ...AUTO_MATH }),

  // ---- brackets ---------------------------------------------------------------------
  s("ceil", "\\left\\lceil $1 \\right\\rceil $0", { ...AUTO_MATH }),
  s("floor", "\\left\\lfloor $1 \\right\\rfloor$0", { ...AUTO_MATH }),
  s("()", "\\left( $1 \\right) $0", { ...AUTO_MATH }),
  s("lr", "\\left( $1 \\right) $0", { ...MATH }),
  s("lr(", "\\left( $1 \\right) $0", { ...MATH }),
  s("lr|", "\\left| $1 \\right| $0", { ...MATH }),
  s("lr{", "\\left\\{ $1 \\right\\} $0", { ...MATH }),
  s("lrb", "\\left\\{ $1 \\right\\} $0", { ...MATH }),
  s("lr[", "\\left[ $1 \\right] $0", { ...MATH }),
  s("lra", "\\left<$1 \\right>$0", { ...AUTO_MATH }),
  s("norm", "\\|$1\\|$0", { ...AUTO_MATH }),
  s("set", "\\{$1\\} $0", { ...AUTO_MATH, wordBoundary: true }),

  // ---- matrices & cases -------------------------------------------------------------
  s("pmat", "\\begin{pmatrix} $1 \\end{pmatrix} $0", { ...AUTO_MATH }),
  s("bmat", "\\begin{bmatrix} $1 \\end{bmatrix} $0", { ...AUTO_MATH }),
  s("cvec", "\\begin{pmatrix} ${1:x}_${2:1}\\\\ \\vdots\\\\ $1_${3:n} \\end{pmatrix}", { ...AUTO_MATH, description: "column vector" }),
  s("case", "\\begin{cases}\n\t$1\n\\end{cases}", { ...AUTO_MATH, wordBoundary: true }),
  s("bigfun", "\\begin{align*}\n\t$1: $2 &\\longrightarrow $3 \\\\\n\t$4 &\\longmapsto $1($4) = $0\n.\\end{align*}", { mode: "text", auto: true, description: "Big function" }),

  // ---- sums, limits, calculus -------------------------------------------------------
  s("sum", "\\sum_{n=${1:1}}^{${2:\\infty}} ${3:a_n z^n}", { ...MATH, wordBoundary: true }),
  s("taylor", "\\sum_{${1:k}=${2:0}}^{${3:\\infty}} c_$1 (x-a)^$1 $0", { ...MATH, wordBoundary: true }),
  s("lim", "\\lim_{${1:n} \\to ${2:\\infty}} ", { ...MATH, wordBoundary: true }),
  s("limsup", "\\limsup_{${1:n} \\to ${2:\\infty}} ", { ...MATH, wordBoundary: true }),
  s("prod", "\\prod_{${1:n=1}}^{${2:\\infty}} $3 $0", { ...MATH, wordBoundary: true }),
  s("part", "\\frac{\\partial ${1:V}}{\\partial ${2:x}} $0", { ...MATH, wordBoundary: true, description: "d/dx" }),
  s("dint", "\\int_{${1:-\\infty}}^{${2:\\infty}} $3 $0", { ...AUTO_MATH, wordBoundary: true, priority: 300, description: "integral" }),
  s("sq", "\\sqrt{$1} $0", { ...AUTO_MATH }),
  s("ooo", "\\infty", { ...AUTO_MATH }),
  s("rij", "(${1:x}_${2:n})_{$2\\in${3:\\N}}$0", { ...MATH, description: "sequence" }),
  s("conj", "\\overline{$1}$0", { ...AUTO_MATH }),

  // ---- \sin, \ln, \pi … without the backslash ---------------------------------------
  s(/(?<!\\)(sin|cos|arccot|cot|csc|ln|log|exp|star|perp)$/, (ctx) => `\\${ctx.match![1]}`, { ...AUTO_MATH, wordBoundary: true, priority: 100 }),
  s(/(?<!\\)(arcsin|arccos|arctan|arccot|arccsc|arcsec|pi|zeta|int)$/, (ctx) => `\\${ctx.match![1]}`, { ...AUTO_MATH, wordBoundary: true, priority: 200 }),

  // ---- arrows & operators -----------------------------------------------------------
  s("->", "\\to ", { ...AUTO_MATH, priority: 100 }),
  s("<->", "\\leftrightarrow", { ...AUTO_MATH, priority: 200 }),
  s("!>", "\\mapsto ", { ...AUTO_MATH }),
  s("\\\\\\", "\\setminus", { ...AUTO_MATH }),
  s("**", "\\cdot ", { ...AUTO_MATH, priority: 100 }),
  s("xx", "\\times ", { ...AUTO_MATH }),
  s("||", " \\mid ", { ...AUTO_MATH }),
  s("nabl", "\\nabla ", { ...AUTO_MATH }),
  s("<!", "\\triangleleft ", { ...AUTO_MATH }),
  s("<>", "\\diamond ", { ...AUTO_MATH }),

  // ---- sets ---------------------------------------------------------------------------
  s("cc", "\\subset ", { ...AUTO_MATH }),
  s("notin", "\\not\\in ", { ...AUTO_MATH }),
  s("inn", "\\in ", { ...AUTO_MATH }),
  s("Nn", "\\cap ", { ...AUTO_MATH }),
  s("UU", "\\cup ", { ...AUTO_MATH }),
  s("uuu", "\\bigcup_{${1:i \\in I}} $0", { ...AUTO_MATH }),
  s("nnn", "\\bigcap_{${1:i \\in I}} $0", { ...AUTO_MATH }),
  s("OO", "\\O", { ...AUTO_MATH }),
  s("NN", "\\N", { ...AUTO_MATH }),
  s("RR", "\\R", { ...AUTO_MATH }),
  s("QQ", "\\Q", { ...AUTO_MATH }),
  s("ZZ", "\\Z", { ...AUTO_MATH }),
  s("R0+", "\\R_0^+", { ...AUTO_MATH }),
  s("HH", "\\mathbb{H}", { ...AUTO_MATH }),
  s("DD", "\\mathbb{D}", { ...AUTO_MATH }),

  // ---- decorations & text -------------------------------------------------------------
  s("mcal", "\\mathcal{$1}$0", { ...AUTO_MATH }),
  s("lll", "\\ell", { ...AUTO_MATH }),
  s("tt", "\\text{$1}$0", { ...AUTO_MATH }),
  s("SI", "\\SI{$1}{$2}", { ...AUTO_MATH }),
  s("bar", "\\overline{$1}$0", { ...AUTO_MATH, priority: 10 }),
  s(/([a-zA-Z])bar$/, (ctx) => `\\overline{${ctx.match![1]}}`, { ...AUTO_MATH, priority: 100 }),
  s("hat", "\\hat{$1}$0", { ...AUTO_MATH, priority: 10 }),
  s(/([a-zA-Z])hat$/, (ctx) => `\\hat{${ctx.match![1]}}`, { ...AUTO_MATH, priority: 100 }),
  s("letw", "Let $$\\Omega \\subset \\C$$ be open.", { mode: "text", auto: true }),

  // ---- TikZ ---------------------------------------------------------------------------
  s("plot", "\\begin{figure}[$1]\n\t\\centering\n\t\\begin{tikzpicture}\n\t\t\\begin{axis}[\n\t\t\txmin= ${2:-10}, xmax= ${3:10},\n\t\t\tymin= ${4:-10}, ymax = ${5:10},\n\t\t\taxis lines = middle,\n\t\t]\n\t\t\t\\addplot[domain=$2:$3, samples=${6:100}]{$7};\n\t\t\\end{axis}\n\t\\end{tikzpicture}\n\t\\caption{$8}\n\t\\label{$9}\n\\end{figure}", { mode: "text", wordBoundary: true, description: "Plot" }),
  s("nn", "\\node[$3] ($1) at (${2:0,0}) {$$$1$$};\n$0", { mode: "text", wordBoundary: true, description: "Tikz node" }),
]);
