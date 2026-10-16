// Matrix & align keys (a built-in TeXdesk plugin; Duplicate it in Settings → Plugins to edit your own copy).
//
// Inside matrices, cases, array, tabular and align-like environments:
//   Tab          → " & "            (next column)
//   Enter        → " \\" + newline  (next row, keeping the indentation)
//   Shift+Enter  → a plain newline
// While a snippet's tab stops are active (e.g. a fresh pmatrix), Tab still moves between
// them first; these keys take over once you've left the fields.

import { key } from "texdesk";

/** Environments with columns (& separates cells). */
const COLUMNS = /^((p|b|B|v|V|small)?matrix|array|cases|dcases|align\*?|aligned|alignat\*?|alignedat|split|eqnarray\*?|tabular\*?|tabularx)$/;
/** Environments with rows (\\ ends a line). */
const ROWS = /^((p|b|B|v|V|small)?matrix|array|cases|dcases|align\*?|aligned|alignat\*?|alignedat|split|eqnarray\*?|tabular\*?|tabularx|gather\*?|gathered|multline\*?)$/;

export const keys = [
  key("Tab", { env: COLUMNS, description: "next column ( & )" }, () => " & "),
  // New lines get the current line's indentation automatically.
  key("Enter", { env: ROWS, description: "next row ( \\\\ )" }, () => " \\\\\n"),
  key("Shift-Enter", { env: ROWS, description: "plain newline" }, () => "\n"),
];

export default [];
