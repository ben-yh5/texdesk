// Matching configured shortcuts ("Mod-Shift-b", CodeMirror syntax) against key events.

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

interface Combo { key: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }

export function parseKey(spec: string, mac = isMac): Combo | null {
  if (!spec) return null;
  // The key itself may be "-" (e.g. "Mod--"), so split on "-" except a trailing one.
  const parts = spec.endsWith("--") ? [...spec.slice(0, -2).split("-"), "-"] : spec.split("-");
  const key = parts.pop();
  if (!key) return null;
  const c: Combo = { key: key === "Space" ? " " : key.length === 1 ? key.toLowerCase() : key, meta: false, ctrl: false, shift: false, alt: false };
  for (const m of parts) {
    const n = m.toLowerCase();
    if (n === "mod") c[mac ? "meta" : "ctrl"] = true;
    else if (n === "cmd" || n === "meta") c.meta = true;
    else if (n === "ctrl" || n === "control") c.ctrl = true;
    else if (n === "shift") c.shift = true;
    else if (n === "alt" || n === "option") c.alt = true;
    else return null;
  }
  return c;
}

export function matchesKey(spec: string, e: KeyboardEvent, mac = isMac): boolean {
  const c = parseKey(spec, mac);
  if (!c) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return k === c.key && e.metaKey === c.meta && e.ctrlKey === c.ctrl && e.shiftKey === c.shift && e.altKey === c.alt;
}

const SYMBOL: Record<string, string> = { Enter: "↩", Escape: "⎋", Backspace: "⌫", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Tab: "⇥", " ": "Space" };

/** "Mod-Shift-b" → "⌘⇧B" (or "Ctrl+Shift+B" elsewhere). */
export function formatKey(spec: string, mac = isMac): string {
  const c = parseKey(spec, mac);
  if (!c) return "";
  const key = SYMBOL[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  if (mac) return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.meta ? "⌘" : ""}${key}`;
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.meta && "Meta", key].filter(Boolean).join("+");
}

const ACCEL_KEY: Record<string, string> = { "\\": "Backslash", ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "`": "Backquote", "=": "Equal", "-": "Minus", " ": "Space" };

/** "Mod-Shift-b" → "CmdOrCtrl+Shift+B", for native menu items. Null if there's no shortcut. */
export function toAccelerator(spec: string): string | null {
  if (!spec) return null;
  const parts = spec.endsWith("--") ? [...spec.slice(0, -2).split("-"), "-"] : spec.split("-");
  const key = parts.pop();
  if (!key) return null;
  const mods: string[] = [];
  for (const m of parts) {
    const n = m.toLowerCase();
    if (n === "mod") mods.push("CmdOrCtrl");
    else if (n === "cmd" || n === "meta") mods.push("Cmd");
    else if (n === "ctrl" || n === "control") mods.push("Ctrl");
    else if (n === "shift") mods.push("Shift");
    else if (n === "alt" || n === "option") mods.push("Alt");
    else return null;
  }
  const k = ACCEL_KEY[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...mods, k].join("+");
}
