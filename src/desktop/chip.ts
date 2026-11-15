// The desktop chip, as a state function and a DOM painter.
//
// There is no JSX here on purpose: the host shares `solid-js` but not
// `solid-js/jsx-runtime`, so a GUI bundle cannot compile JSX. The markup below is
// the design's chip verbatim (docs/designs/working-vibes-desktop-live-trace.html).
import { createEffect } from "solid-js";

export type TurnState = "idle" | "working" | "interrupted";

/** What the narrator knows about the current turn. */
export interface ChipInput {
  readonly turn: TurnState;
  /** Model-written line, or null before the first one lands. */
  readonly line: string | null;
  /** Running tool, already described as `read route.ts`. */
  readonly tool: string | null;
  /** Tool calls since the turn started. */
  readonly step: number;
}

/** What the chip paints. Every design state is one of these. */
export interface ChipView {
  readonly state: TurnState | "pending";
  readonly visible: boolean;
  readonly label: string;
  readonly tool: string;
  readonly step: number;
  readonly spinning: boolean;
}

export function chipView(input: ChipInput): ChipView {
  const interrupted = input.turn === "interrupted";
  const visible = input.turn !== "idle";

  return {
    // `pending` is working with no line yet: the spinner alone, same 34px strip.
    state: !visible ? "idle" : interrupted ? "interrupted" : input.line ? "working" : "pending",
    visible,
    label: input.line ?? (interrupted ? "Interrupted" : ""),
    tool: input.tool ?? "",
    step: input.step,
    spinning: visible && !interrupted,
  };
}

const STYLE_ID = "working-vibes-chip";

const CSS = `
.wv-dock{display:flex;justify-content:center}
.wv-chip{display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;width:100%;max-width:680px;box-sizing:border-box;margin-bottom:10px;
  background:var(--background-stronger,#151515);border:1px solid var(--border-weak-base,#282828);border-radius:var(--radius-md,.375rem)}
.wv-chip[data-visible="false"]{display:none}
.wv-arc{width:12px;height:12px;flex:0 0 12px;box-sizing:border-box;border-radius:50%;
  border:1.5px solid rgba(255,255,255,.14);border-top-color:var(--v2-icon-icon-accent,#a2bcff);animation:wv-spin .85s linear infinite}
@keyframes wv-spin{to{transform:rotate(360deg)}}
.wv-stop{display:none;color:var(--danger,#f17471);flex:0 0 auto;font:400 12px/1 var(--font-mono,ui-monospace,monospace)}
.wv-lbl{font-size:12.5px;line-height:1.3;color:var(--text-base,#ffffff9e);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;min-width:0;flex:1 1 auto}
.wv-tool{flex:0 0 auto;max-width:40%;min-width:0;display:flex;align-items:center;
  font:400 12px/1 var(--font-mono,ui-monospace,monospace);color:var(--text-base,#ffffff9e);
  background:rgba(255,255,255,.055);border-radius:var(--radius-md,.375rem);padding:5px 7px}
/* paths read best from the right: keep the filename, drop the head of the path */
.wv-tool span{direction:rtl;text-align:left;display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wv-meta{flex:0 0 auto;display:flex;align-items:center;gap:10px;
  font:400 12px/1 var(--font-mono,ui-monospace,monospace);color:var(--text-weak,#8a8a8a);font-variant-numeric:tabular-nums}
.wv-meta b{color:var(--text-stronger,#ffffff);font-weight:500}
.wv-chip[data-state="pending"] .wv-lbl{visibility:hidden}
.wv-chip[data-state="pending"] .wv-tool,.wv-chip[data-state="pending"] .wv-meta{visibility:hidden}
.wv-chip[data-state="interrupted"] .wv-arc{display:none}
.wv-chip[data-state="interrupted"] .wv-stop{display:inline}
.wv-chip[data-state="interrupted"] .wv-lbl{color:var(--danger,#f17471)}
.wv-chip[data-state="interrupted"]{border-color:rgba(241,116,113,.28);background:rgba(241,116,113,.05)}
@media (prefers-reduced-motion:reduce){.wv-arc{animation:none;border-top-color:var(--v2-icon-icon-accent,#a2bcff)}}
`;

function style(): void {
  if (document.getElementById(STYLE_ID)) return;
  const element = document.createElement("style");
  element.id = STYLE_ID;
  element.textContent = CSS;
  document.head.append(element);
}

function span(className: string, text = ""): ChipElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

// The host's `window.bottom` slot renders below the composer; the design puts the chip
// directly above it. Move the dock into the composer's own column when there is one.
function place(dock: ChipElement): ChipElement | null {
  const form = document.querySelector("form");
  if (!form || form.getBoundingClientRect().width === 0) return null;
  let node = form;
  while (
    node.parentElement &&
    node.parentElement.getBoundingClientRect().width <= node.getBoundingClientRect().width + 1
  ) {
    node = node.parentElement;
  }
  node.parentElement?.insertBefore(dock, node);
  return dock.parentElement;
}

/** Build the chip and keep it in step with `view`. */
export function createChip(view: () => ChipView): ChipElement {
  style();

  const dock = document.createElement("div");
  dock.className = "wv-dock";

  const chip = document.createElement("div");
  chip.className = "wv-chip";
  chip.setAttribute("role", "status");
  chip.setAttribute("aria-live", "polite");
  chip.setAttribute("aria-atomic", "true");
  chip.setAttribute("aria-label", "Agent activity");

  const arc = span("wv-arc");
  arc.setAttribute("aria-hidden", "true");
  const stop = span("wv-stop", "■");
  stop.setAttribute("aria-hidden", "true");
  const label = span("wv-lbl");
  const toolText = span("");
  const tool = span("wv-tool");
  tool.append(toolText);
  const stepValue = document.createElement("b");
  const meta = span("wv-meta", "step ");
  meta.append(stepValue);

  chip.append(arc, stop, label, tool, meta);
  dock.append(chip);

  // The composer may mount after the plugin does, and it is re-created on screen
  // changes, so re-place whenever the app's tree moves and the dock is not in it.
  let column: ChipElement | null = null;
  const settle = () => {
    if (column && dock.parentElement === column && dock.isConnected) return;
    column = place(dock);
  };
  settle();
  new MutationObserver(settle).observe(document.body, { childList: true, subtree: true });

  const paint = () => {
    const current = view();
    chip.dataset.state = current.state;
    chip.dataset.visible = String(current.visible);
    label.textContent = current.label;
    toolText.textContent = current.tool;
    tool.style.display = current.tool ? "flex" : "none";
    stepValue.textContent = String(current.step);
    meta.style.display = current.step > 0 ? "flex" : "none";
    arc.style.animationPlayState = current.spinning ? "running" : "paused";
  };

  createEffect(paint);

  return dock;
}
