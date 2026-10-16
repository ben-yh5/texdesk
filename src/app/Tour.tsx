// The welcome tour: a few tips, each pointing at the part of the window it's about, shown the
// first time a workspace opens. Skippable at any step (Skip, or Escape); "Show the welcome tour"
// in the command palette brings it back.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

export interface TourStep {
  title: string;
  text: string;
  /** CSS selector of what the tip points at; centered when it's missing or not on screen. */
  anchor?: string;
}

/** The steps, for a workspace with (or without) folder types. */
export function tourSteps(opts: { hasTypes: boolean; shortcut: (id: string) => string }): TourStep[] {
  const k = opts.shortcut;
  return [
    {
      title: "Welcome to TeXdesk",
      text: "Write LaTeX in plain .tex files, in folders on your Mac. Documents build as you type, with the PDF beside them. Here are five quick tips — skip them any time.",
    },
    {
      title: "Your files",
      anchor: ".sidebar",
      text: "Everything in this folder, as it is on disk. Click a folder's name to see its overview page; its arrow just opens it. The name at the top is your home page. A folder can have a type (like Class or Project), with its own fields and subfolders — right-click it.",
    },
    {
      title: "Find anything",
      anchor: ".status",
      text: `${k("find_file")} finds a file or folder by any part of its path. ${k("command_palette")} runs any command — including a “New …” command for each of your templates.`,
    },
    {
      title: "The PDF",
      anchor: ".tb-pdf",
      text: `Saving (or pausing typing) builds the document. ${k("toggle_pdf")} shows or hides the PDF; double-click a line to find it in the PDF, or ⌘-click the PDF to jump back.`,
    },
    {
      title: opts.hasTypes ? "Make it yours" : "Set up your workflow",
      text: opts.hasTypes
        ? `Settings (${k("settings")}) → Workspace edits your folder types and templates; Plugins adds snippets. On a folder's overview, Edit layout picks what it shows.`
        : `Settings (${k("settings")}) → Workspace is where you describe how you organize things: folder types (Term → Class, Project → Chapter…) and templates for new files. Plugins add snippets.`,
    },
  ];
}

export function Tour(props: { steps: TourStep[]; onDone: (finished: boolean) => void }) {
  const [i, setI] = createSignal(0);
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  const step = () => props.steps[i()];

  const measure = () => {
    const sel = step()?.anchor;
    const el = sel ? document.querySelector(sel) : null;
    const r = el?.getBoundingClientRect();
    setRect(r && r.width > 0 && r.height > 0 ? r : null);
  };
  const go = (n: number) => {
    if (n >= props.steps.length) return props.onDone(true);
    setI(Math.max(0, n));
    measure();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); props.onDone(false); }
    else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); go(i() + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); go(i() - 1); }
  };
  onMount(() => {
    measure();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", measure);
  });
  onCleanup(() => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", measure); });

  /** The tip goes beside what it points at (right, else left, else below), kept on screen. */
  const tipStyle = () => {
    const r = rect();
    if (!r) return { left: "50%", top: "40%", transform: "translate(-50%, -50%)" };
    const W = 320, pad = 14, vw = window.innerWidth, vh = window.innerHeight;
    let left = r.right + pad;
    if (left + W > vw - 8) left = r.left - W - pad;
    let top = r.top;
    if (left < 8) { left = Math.min(Math.max(r.left, 8), vw - W - 8); top = r.bottom + pad; }
    if (r.height > vh * 0.6) top = vh * 0.3; // a tall target (the sidebar): level with its middle
    if (top + 180 > vh) top = Math.max(8, r.top - 180 - pad);
    return { left: `${left}px`, top: `${top}px` };
  };

  return (
    <div class="tour" role="dialog" aria-label="Welcome tour">
      <Show when={rect()} fallback={<div class="tour-dim" />}>
        {(r) => <div class="tour-spot" style={{ left: `${r().left - 4}px`, top: `${r().top - 4}px`, width: `${r().width + 8}px`, height: `${r().height + 8}px` }} />}
      </Show>
      <div class="tour-tip" style={tipStyle()}>
        <div class="tour-title">{step().title}</div>
        <div class="tour-text">{step().text}</div>
        <div class="tour-foot">
          <span class="tour-dots"><For each={props.steps}>{(_, j) => <span class={`tour-dot ${j() === i() ? "on" : ""}`} />}</For></span>
          <span class="ov-spacer" />
          <button class="tour-skip" onClick={() => props.onDone(false)}>Skip tour</button>
          <Show when={i() > 0}><button class="tour-btn" onClick={() => go(i() - 1)}>Back</button></Show>
          <button class="tour-btn primary" onClick={() => go(i() + 1)}>{i() === props.steps.length - 1 ? "Done" : "Next"}</button>
        </div>
      </div>
    </div>
  );
}
