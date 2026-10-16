// Snippet debug view: live mode/env stack at the cursor, and what the engine did on
// the last keystroke.

import { For, Show } from "solid-js";
import type { MatchLog } from "../snippets/engine";
import type { Mode } from "../snippets/types";

const OUTCOME_TEXT: Record<string, string> = {
  fired: "fired",
  declined: "returned false",
  threw: "threw",
  "not-reached": "not tried (an earlier candidate fired)",
};

export function DebugPanel(props: { mode: Mode; env: string[]; log: MatchLog | null; onClose(): void }) {
  return (
    <div class="debug">
      <div class="debug-head">
        <span class="debug-title">Snippet debug</span>
        <span>mode <b>{props.mode}</b></span>
        <span class="debug-env">{props.env.length ? props.env.join(" › ") : "(no environment)"}</span>
        <span class="spacer" />
        <button class="debug-close" onClick={props.onClose} title="Close">×</button>
      </div>
      <Show when={props.log} fallback={<div class="debug-empty">Type something to see which snippets match.</div>}>
        {(log) => (
          <div class="debug-body">
            <div class="debug-event">
              Last keystroke: <b>{log().event}</b> · mode {log().mode} · {log().totalMs.toFixed(2)}ms
            </div>
            <Show when={!log().attempts.length && !log().filtered.length}>
              <div class="debug-empty">No snippet's trigger matched.</div>
            </Show>
            <For each={log().attempts}>
              {(a) => (
                <div class={`debug-row outcome-${a.outcome}`}>
                  <span class="debug-label">{a.label}</span>
                  <span class="debug-file">{a.file}</span>
                  <span class="debug-why">{OUTCOME_TEXT[a.outcome]}{a.detail ? `: ${a.detail}` : ""}</span>
                  <Show when={a.ms !== undefined}><span class="debug-ms">{a.ms!.toFixed(2)}ms</span></Show>
                </div>
              )}
            </For>
            <For each={log().filtered}>
              {(f) => (
                <div class="debug-row outcome-filtered">
                  <span class="debug-label">{f.label}</span>
                  <span class="debug-file">{f.file}</span>
                  <span class="debug-why">trigger matched, skipped: {f.reason}</span>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}
