// LaTeX commands TeXdesk knows about: what completion suggests (math ones in math, text
// ones in text) and what the built-in error fixes compare a misspelled command against.
// No editor dependencies, so build-side code can use it too.

export type Where = "math" | "text" | "any";

/**
 * Commands: `name` or `name` + a template after it where `|` is the cursor, e.g.
 * "frac{|}{}". Grouped by where they make sense.
 */
const MATH = `frac{|}{} dfrac{|}{} tfrac{|}{} sqrt{|} boxed{|} binom{|}{} mathbb{|} mathcal{|} mathrm{|} mathbf{|} mathit{|}
mathfrak{|} mathsf{|} mathscr{|} operatorname{|} text{|} overline{|} underline{|} hat{|} bar{|} tilde{|} vec{|} dot{|} ddot{|}
widehat{|} widetilde{|} overbrace{|}^{} underbrace{|}_{} overset{|}{} underset{|}{} stackrel{|}{} xrightarrow{|} xleftarrow{|}
pmod{|} bmod substack{|} tag{|} cancel{|} left right big Big bigg Bigg displaystyle textstyle limits nolimits
cdot cdots ldots vdots ddots times div pm mp ast star circ bullet oplus ominus otimes odot
leq geq neq approx equiv sim simeq cong propto ll gg prec succ preceq succeq
infty partial nabla sum prod coprod int iint iiint oint lim limsup liminf sup inf max min arg
log ln lg exp sin cos tan sec csc cot arcsin arccos arctan sinh cosh tanh det dim ker hom deg gcd Pr
in notin ni subset subseteq subsetneq supset supseteq cup cap bigcup bigcap setminus emptyset varnothing complement
forall exists nexists neg lnot land lor wedge vee implies impliedby iff to gets mapsto
rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow longrightarrow Longrightarrow hookrightarrow
uparrow downarrow
langle rangle lfloor rfloor lceil rceil lvert rvert lVert rVert mid nmid parallel perp angle triangle
prime ell hbar Re Im aleph wp top bot vdash models
alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho
sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega`;

const TEXT = `section{|} subsection{|} subsubsection{|} paragraph{|} chapter{|} section*{|} subsection*{|}
textbf{|} textit{|} emph{|} texttt{|} textsc{|} textsf{|} textrm{|} underline{|} textcolor{|}{}
item label{|} ref{|} eqref{|} cref{|} cite{|} footnote{|} href{|}{} url{|} link{|}
includegraphics[width=0.6\\linewidth]{|} caption{|} centering newpage clearpage noindent
vspace{|} hspace{|} smallskip medskip bigskip hfill vfill linebreak par
input{|} include{|} lstinputlisting[language=|]{} lstinline|| verb||
maketitle tableofcontents title{|} author{|} date{|} today usepackage{|} documentclass{|}
newcommand{|}{} renewcommand{|}{} DeclareMathOperator{|}{} newtheorem{|}{} hwheader{|}{}{}
hline toprule midrule bottomrule multicolumn{|}{}{} LaTeX TeX ldots quad qquad`;

const ANY = `label{|} ref{|} eqref{|} quad qquad ldots begin{|} end{|} text{|}`;

export interface Cmd { name: string; template: string; where: Where }

function parse(list: string, where: Where): Cmd[] {
  return list.split(/\s+/).filter(Boolean).map((entry) => {
    const m = /^([A-Za-z]+\*?)(.*)$/.exec(entry)!;
    return { name: m[1], template: m[2], where };
  });
}

export const COMMANDS: Cmd[] = (() => {
  const seen = new Map<string, Cmd>();
  for (const c of [...parse(ANY, "any"), ...parse(MATH, "math"), ...parse(TEXT, "text")]) {
    const prev = seen.get(c.name);
    if (prev && prev.where !== c.where) prev.where = "any";
    else if (!prev) seen.set(c.name, c);
  }
  // \item comes with its space, so picking it (or Enter after typing it) leaves you ready to write.
  seen.get("item")!.template = " |";
  return [...seen.values()];
})();


/** Command names known to exist (for spotting typos), without backslashes. */
const BASICS = "begin end item documentclass usepackage left right newcommand renewcommand label ref eqref cite input include maketitle centering caption includegraphics hline newline linebreak pagebreak newpage clearpage noindent indent par footnote textwidth linewidth emph textbf textit texttt mathrm text";
export function knownCommandNames(extra: Iterable<string> = []): Set<string> {
  return new Set([...COMMANDS.map((c) => c.name.replace(/\*$/, "")), ...BASICS.split(" "), ...extra]);
}
