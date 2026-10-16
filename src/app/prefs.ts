// Per-user UI conveniences (recent folders, last file, sidebar state). Stored in the
// webview's localStorage; losing them is harmless.

const PREFIX = "texdesk:";

export function get<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function set(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage unavailable; ignore
  }
}
