// Public types for the `texdesk` snippet API.
//
// This file is self-contained on purpose: its text is embedded verbatim into the
// `texdesk.d.ts` written to `.texdesk/snippets/`, so it must not import anything.

/** Where the cursor is, as far as LaTeX is concerned. */
export type Mode = "text" | "inline" | "display" | "code";

/** A mode filter. `"math"` means inline or display. An array matches any of its entries. */
export type ModeOption = Mode | "math" | readonly (Mode | "math")[];

/** A half-open range of document offsets. */
export interface Range {
  readonly from: number;
  readonly to: number;
}

/**
 * A change for the engine to apply, built with `ctx.insert` or `ctx.replace`.
 * Snippet code never edits the document directly.
 */
export interface Edit extends Range {
  /** Snippet string to put in place of `from..to` (tab-stop syntax allowed). */
  readonly snippet: string;
  readonly kind: "edit";
}

/**
 * What a snippet or key handler returns:
 * - a string: replace the trigger match with this snippet string (key handlers: insert it at the cursor)
 * - `false` / `undefined` / `null`: didn't fire; the engine tries the next candidate
 * - an `Edit` (or array of them): applied as one undo step
 */
export type SnippetResult = string | Edit | readonly Edit[] | false | null | undefined | void;

export interface Expression {
  /** The expression's source text. */
  readonly text: string;
  /** `text` with one outer pair of parentheses removed, if it had one. */
  readonly unwrapped: string;
  readonly range: Range;
}

export interface Line {
  readonly from: number;
  readonly to: number;
  /** 1-based line number. */
  readonly number: number;
  readonly text: string;
}

/** Read-only access to the whole document. */
export interface Doc {
  readonly length: number;
  /** Number of lines. */
  readonly lines: number;
  slice(from: number, to?: number): string;
  lineAt(pos: number): Line;
  /** 1-based. */
  line(n: number): Line;
  toString(): string;
}

/** A folder above the open file that has a type or settings in workspace.json. */
export interface FolderInfo {
  readonly path: string;
  /** Its folder type (e.g. "class"), if it has one. */
  readonly kind: string | null;
}

export interface FileInfo {
  /** Absolute path of the open file. */
  readonly path: string;
  /** Workspace root (the folder containing `.texdesk/`). */
  readonly workspace: string;
  /** Template variables in effect here: your settings' `vars`, plus the fields of every typed folder above the file. */
  readonly vars: Readonly<Record<string, string>>;
  /** Folders above the file with a type or settings, outermost first. */
  readonly folders: readonly FolderInfo[];
}

export interface Context {
  /** Mode at the cursor. */
  readonly mode: Mode;
  /** Enclosing environment names, innermost last, e.g. `["document", "align*", "pmatrix"]`. */
  readonly envStack: readonly string[];
  /** Innermost environment name (last of `envStack`). */
  readonly env: string | undefined;
  /** Text on the current line before the cursor (after any typed trigger character). */
  readonly before: string;
  /** Text on the current line after the cursor. */
  readonly after: string;
  readonly doc: Doc;
  /** Cursor offset in the document. */
  readonly cursor: number;
  /** The regex match, for regex-triggered snippets; otherwise `null`. */
  readonly match: RegExpMatchArray | null;
  /** The range the trigger matched (empty at the cursor for key handlers). */
  readonly triggerRange: Range;
  /** Selected text, for visual snippets; otherwise `""`. */
  readonly selection: string;
  /**
   * The expression immediately before the trigger (for key handlers: the cursor): `{…}`, `(…)`, `[…]`, `\left…\right…`,
   * `\command` with its brace arguments, sub/superscripts attached to what precedes them,
   * and runs of letters/digits, juxtaposed. Whitespace, operators and unmatched open
   * brackets end it. `null` if there is none.
   */
  previousExpression(): Expression | null;
  /**
   * An edit inserting `snippet` at the cursor. When a snippet fires, its trigger text is
   * removed automatically unless one of the returned edits covers it.
   */
  insert(snippet: string): Edit;
  /** An edit replacing `range` with `snippet`. */
  replace(range: Range, snippet: string): Edit;
  readonly file: FileInfo | null;
}

/** A replacement snippet string, or a function computing the result from context. */
export type Replacement = string | ((ctx: Context) => SnippetResult);

export interface SnippetOptions {
  /** Where the snippet may fire. Default: anywhere except code. */
  mode?: ModeOption;
  /** Expand as soon as the trigger is typed (default: only on Tab). */
  auto?: boolean;
  /** Only fire when the trigger isn't preceded by a letter, digit or backslash. */
  wordBoundary?: boolean;
  /** Fire when the trigger is typed over a selection; `ctx.selection` holds the selected text. */
  visual?: boolean;
  /** Higher wins when several snippets match. Default 0. */
  priority?: number;
  description?: string;
}

export interface Snippet {
  readonly kind: "snippet";
  /** A string suffix, or a regex matched against the text before the cursor (implicitly anchored at the cursor). */
  readonly trigger: string | RegExp;
  readonly replacement: Replacement;
  readonly options: Readonly<SnippetOptions>;
}

export interface KeyOptions {
  /** Where the handler may run. Default: anywhere except code. */
  mode?: ModeOption;
  /**
   * Matched against the innermost environment (`ctx.env`), or a predicate over the whole stack.
   * With `env`, the handler only runs directly in the environment's rows, not inside a bracket
   * there (`\frac{…}`, `( … )`): there the key keeps its usual job (Tab moves between slots).
   */
  env?: string | RegExp | ((envStack: readonly string[]) => boolean);
  /** Higher runs first among handlers for the same key. Default 0. */
  priority?: number;
  description?: string;
}

export interface KeyHandler {
  readonly kind: "key";
  /** A CodeMirror key name, e.g. `"Tab"`, `"Enter"`, `"Shift-Enter"`, `"Mod-b"`. */
  readonly key: string;
  readonly options: Readonly<KeyOptions>;
  readonly run: (ctx: Context) => SnippetResult;
}
