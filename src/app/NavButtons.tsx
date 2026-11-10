// Back and forward through a tab's history (⌘[ / ⌘]).

/** ‹ › back/forward buttons, at the top left like a browser's. */
export function NavButtons(p: { can: (dir: "back" | "forward") => boolean; go: (dir: "back" | "forward") => void }) {
  return (
    <span class="nav-btns">
      <button class="nav-btn" title="Back (⌘[)" disabled={!p.can("back")} onClick={() => p.go("back")}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
      </button>
      <button class="nav-btn" title="Forward (⌘])" disabled={!p.can("forward")} onClick={() => p.go("forward")}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
      </button>
    </span>
  );
}
