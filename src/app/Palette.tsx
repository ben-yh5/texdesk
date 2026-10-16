// A single overlay used for ⌘K (files), ⌘⇧K (commands), pickers, and text prompts.

import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { fuzzyFilter } from "../workspace/fuzzy";

export interface PickItem<T> {
  label: string;
  detail?: string;
  /** Right-aligned hint, e.g. a keyboard shortcut. */
  hint?: string;
  /** Text matched by the filter (default: the label). */
  key?: string;
  value: T;
}

interface PickState {
  kind: "pick";
  title?: string;
  placeholder: string;
  items: PickItem<unknown>[];
  itemsFor?: (query: string) => PickItem<unknown>[];
  resolve(v: unknown): void;
}

interface PromptState {
  kind: "prompt";
  title: string;
  placeholder?: string;
  value: string;
  validate?: (v: string) => string | null;
  /** Options shown under the input for the current text (e.g. templates for a .tex name); ↑↓ choose one. */
  choices?: (v: string) => PickItem<unknown>[];
  /** Heading above the choices. */
  choicesTitle?: string;
  /** Value of the choice selected at first. */
  initialChoice?: unknown;
  resolve(v: string | { value: string; choice: unknown } | null): void;
}

type State = PickState | PromptState;

export function createPalette() {
  const [state, setState] = createSignal<State | null>(null);

  const close = (value: unknown = null) => {
    const s = state();
    setState(null);
    s?.resolve(value as never);
  };

  return {
    state,
    close,
    pick<T>(opts: { title?: string; placeholder: string; items: PickItem<T>[]; itemsFor?: (q: string) => PickItem<T>[] }): Promise<T | null> {
      state()?.resolve(null as never);
      return new Promise((resolve) => setState({
        kind: "pick", ...opts, items: opts.items as PickItem<unknown>[],
        itemsFor: opts.itemsFor as ((q: string) => PickItem<unknown>[]) | undefined, resolve: resolve as (v: unknown) => void,
      }));
    },
    prompt(opts: { title: string; placeholder?: string; value?: string; validate?: (v: string) => string | null }): Promise<string | null> {
      state()?.resolve(null as never);
      return new Promise((resolve) => setState({ kind: "prompt", value: "", ...opts, resolve: resolve as PromptState["resolve"] }));
    },
    /** A text prompt with a list of choices under it; resolves to the text and the chosen value (null if there were none). */
    promptWithChoice<T>(opts: {
      title: string; placeholder?: string; value?: string; validate?: (v: string) => string | null;
      choices: (v: string) => PickItem<T>[]; choicesTitle?: string; initialChoice?: T;
    }): Promise<{ value: string; choice: T | null } | null> {
      state()?.resolve(null as never);
      return new Promise((resolve) => setState({
        kind: "prompt", value: "", ...opts, choices: opts.choices as PromptState["choices"], resolve: resolve as PromptState["resolve"],
      }));
    },
  };
}

export type Palette = ReturnType<typeof createPalette>;

export function PaletteView(props: { palette: Palette }) {
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  let input!: HTMLInputElement;
  let list: HTMLDivElement | undefined;

  createEffect(() => {
    const s = props.palette.state();
    if (!s) return;
    setQuery(s.kind === "prompt" ? s.value : "");
    setChosen(s.kind === "prompt" ? s.initialChoice : undefined);
    setIndex(0);
    setError(null);
    queueMicrotask(() => {
      input?.focus();
      if (s.kind === "prompt") input.setSelectionRange(input.value.length, input.value.length);
    });
  });

  /** For a prompt with choices: the options for the current text, and which is selected (kept by value as you type). */
  const [chosen, setChosen] = createSignal<unknown>(undefined);
  const choices = () => {
    const s = props.palette.state();
    return s?.kind === "prompt" && s.choices ? s.choices(query()) : [];
  };
  const chosenIndex = () => {
    const list = choices();
    const i = list.findIndex((c) => c.value === chosen());
    return i < 0 ? 0 : i;
  };

  const filtered = () => {
    const s = props.palette.state();
    if (s?.kind !== "pick") return [];
    return fuzzyFilter(query(), s.itemsFor ? s.itemsFor(query()) : s.items, (i) => i.key ?? i.label, 80);
  };

  createEffect(() => {
    filtered();
    setIndex(0);
  });

  const scrollToActive = () => queueMicrotask(() => list?.querySelector(".pal-item.active")?.scrollIntoView({ block: "nearest" }));

  const onKey = (e: KeyboardEvent) => {
    const s = props.palette.state();
    if (!s) return;
    if (e.key === "Escape") { e.preventDefault(); props.palette.close(null); return; }
    if (s.kind === "pick") {
      const n = filtered().length;
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); setIndex((index() + 1) % Math.max(n, 1)); scrollToActive(); }
      else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); setIndex((index() - 1 + n) % Math.max(n, 1)); scrollToActive(); }
      else if (e.key === "Enter") { e.preventDefault(); const it = filtered()[index()]; if (it) props.palette.close(it.value); }
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && choices().length) {
      e.preventDefault();
      const n = choices().length;
      setChosen(choices()[(chosenIndex() + (e.key === "ArrowDown" ? 1 : n - 1)) % n].value);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const v = query();
      const err = s.validate?.(v) ?? null;
      if (err) setError(err);
      else if (s.choices) props.palette.close({ value: v, choice: choices().length ? choices()[chosenIndex()].value : null });
      else props.palette.close(v);
    }
  };

  const onDocKey = (e: KeyboardEvent) => { if (props.palette.state() && e.key === "Escape") props.palette.close(null); };
  document.addEventListener("keydown", onDocKey);
  onCleanup(() => document.removeEventListener("keydown", onDocKey));

  return (
    <Show when={props.palette.state()}>
      {(s) => (
        <div class="pal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.palette.close(null); }}>
          <div class="pal" role="dialog">
            <Show when={s().kind === "prompt" ? (s() as PromptState).title : (s() as PickState).title}>
              {(t) => <div class="pal-title">{t()}</div>}
            </Show>
            <input
              ref={input}
              class="pal-input"
              value={query()}
              placeholder={s().kind === "pick" ? (s() as PickState).placeholder : (s() as PromptState).placeholder ?? ""}
              onInput={(e) => { setQuery(e.currentTarget.value); setError(null); }}
              onKeyDown={onKey}
              spellcheck={false}
              autocomplete="off"
            />
            <Show when={error()}><div class="pal-error">{error()}</div></Show>
            <Show when={choices().length}>
              <div class="pal-choices">
                <Show when={(s() as PromptState).choicesTitle}><div class="pal-choices-title">{(s() as PromptState).choicesTitle}</div></Show>
                <For each={choices()}>
                  {(item, i) => (
                    <div
                      class={`pal-item ${i() === chosenIndex() ? "active" : ""}`}
                      onMouseDown={(e) => { e.preventDefault(); setChosen(item.value); input.focus(); }}
                    >
                      <span class="pal-label">{item.label}</span>
                      <Show when={item.detail}><span class="pal-detail">{item.detail}</span></Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={s().kind === "pick"}>
              <div class="pal-list" ref={list}>
                <For each={filtered()} fallback={<div class="pal-empty">No matches</div>}>
                  {(item, i) => (
                    <div
                      class={`pal-item ${i() === index() ? "active" : ""}`}
                      onMouseMove={() => setIndex(i())}
                      onMouseDown={(e) => { e.preventDefault(); props.palette.close(item.value); }}
                    >
                      <span class="pal-label">{item.label}</span>
                      <Show when={item.detail}><span class="pal-detail">{item.detail}</span></Show>
                      <Show when={item.hint}><span class="pal-hint">{item.hint}</span></Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
