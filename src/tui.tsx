/** @jsxImportSource @opentui/solid */
// OpenCode v2 TUI entrypoint: a themed working-vibes intent chip above the composer.
//
// The semantic activity layer (ported from pi-working-vibes) is the single writer of
// the chip's text: a delta of what the turn just did is summarized by a small model,
// sanitized, and de-duplicated. Spinner and label default to Claude Code orange; the
// shimmer sweep's highlight/accent/dim bands resolve from the active OpenCode theme.
import { Plugin } from "@opencode-ai/plugin/tui";
import type { Renderable, TextNodeRenderable, TextRenderable } from "@opentui/core";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { latestToolActivity } from "./activity.js";
import {
  bandColor,
  isVibeColor,
  rainbowColorForCharacter,
  resolveAgentColor,
  resolveColor,
  shimmerBand,
  type ThemeColor,
  type ThemeLike,
  type VibeColor,
} from "./color.js";
import { latestUserText, type MessageLike } from "./intent.js";
import { generateText, parseModel, type ModelRef } from "./narration.js";
import { buildSummaryPrompt, buildToolSummaryPrompt } from "./semantic.js";
import { SemanticDriver } from "./semantic-driver.js";
import {
  BUILTIN_AGENT_COLORS,
  DEFAULT_SETTINGS,
  resolveSettings,
  SHIMMER_EXIT_OFFSET,
  SHIMMER_FRAME_MS,
  SHIMMER_PAUSE_MS,
  SHIMMER_START_OFFSET,
  SHIMMER_STEP,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  type GenerationStrategy,
  type VibeSettings,
} from "./settings.js";

type UpdateSettings = (mutation: (draft: VibeSettings) => void) => Promise<void>;

// Opt-in trace for verifying narration end to end.
const TRACE = join(homedir(), ".config", "opencode", "working-vibes-debug.log");
function trace(message: string): void {
  if (process.env.WORKING_VIBES_DEBUG !== "1") return;
  try {
    appendFileSync(TRACE, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* best-effort */
  }
}

// Stamped at load so a stale TUI (one started before the last edit) is instantly
// obvious in the debug log instead of being mistaken for the new code.
const BUILD = "agent-color-1";
trace(`module loaded pid=${process.pid} cwd=${process.cwd()} build=${BUILD}`);

/** The message slice after the last user message (the current turn). */
function turnSlice(messages: ReadonlyArray<MessageLike>): MessageLike[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type === "user") return messages.slice(index + 1);
  }
  return messages.slice();
}

/** Renders the activity label, optionally with a per-character shimmer sweep. */
function VibeLabel(props: {
  readonly text: string;
  readonly theme: ThemeLike;
  readonly color: VibeColor;
  readonly shimmer: boolean;
}) {
  const [shimmerPhase, setShimmerPhase] = createSignal(0);
  const styledNodes = new Map<number, TextNodeRenderable>();
  const characters = createMemo(() => Array.from(props.text));
  const base = () => resolveColor(props.theme, props.color, undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  // Component-scope guard: no sweep timer may survive unmount, even if an effect
  // cleanup is skipped during a fast text-change reconciliation.
  onCleanup(stopTimer);

  const charColor = (index: number, phase: number): ThemeColor | undefined => {
    const character = characters()[index] ?? "";
    const fallback = base();
    // Whitespace takes the base color explicitly so a reused span never keeps a
    // stale band color from the previous line (reads as random flashing).
    if (/\s/.test(character)) return fallback;
    const band = shimmerBand(index, phase);
    if (band === "base") {
      return props.color === "rainbow"
        ? (rainbowColorForCharacter(props.text, index) ?? fallback)
        : fallback;
    }
    return bandColor(props.theme, fallback, band);
  };

  createEffect(() => {
    const message = props.text;
    if (!props.shimmer) {
      stopTimer();
      setShimmerPhase(0);
      return;
    }

    // Defensive: never let two sweep timers coexist. A leftover timer writing a
    // stale phase alongside the new one is what made the sweep flash at random.
    stopTimer();
    setShimmerPhase(0);
    let phase = 0;
    const cycleEnd = Array.from(message).length + SHIMMER_START_OFFSET + SHIMMER_EXIT_OFFSET;
    let tracedFrame = false;
    // Render one sweep step and schedule the next frame or post-sweep pause.
    const render = (): void => {
      setShimmerPhase(phase);
      if (!tracedFrame && phase > 0) {
        trace("chip shimmer frame advanced");
        tracedFrame = true;
      }
      const sweepEnded = phase >= cycleEnd;
      phase = sweepEnded ? 0 : Math.min(phase + SHIMMER_STEP, cycleEnd);
      timer = setTimeout(render, sweepEnded ? SHIMMER_PAUSE_MS : SHIMMER_FRAME_MS);
      timer.unref?.();
    };
    render();
    onCleanup(stopTimer);
  });

  createEffect(() => {
    const phase = shimmerPhase();
    const shimmer = props.shimmer;
    const color = props.color;
    const currentCharacters = characters();
    // Drop nodes for spans that no longer exist (a shorter replacement line):
    // painting bands onto detached nodes while new spans keep stale colors reads
    // as random flashing.
    for (const key of [...styledNodes.keys()]) {
      if (key >= currentCharacters.length) styledNodes.delete(key);
    }
    const fallback = base();
    for (let index = 0; index < currentCharacters.length; index += 1) {
      const node = styledNodes.get(index);
      if (!node) continue;
      node.fg = shimmer
        ? charColor(index, phase)
        : color === "rainbow"
          ? (rainbowColorForCharacter(props.text, index) ?? fallback)
          : undefined;
    }
  });

  onCleanup(() => styledNodes.clear());

  return (
    <Show
      when={props.shimmer || props.color === "rainbow"}
      fallback={<text fg={base()} wrapMode="none">{props.text}</text>}
    >
      <text fg={props.color === "rainbow" ? undefined : base()} wrapMode="none">
        <For each={characters()}>
          {(char, index) => (
            <span
              ref={(node: TextNodeRenderable) => {
                const position = index();
                styledNodes.set(position, node);
                node.fg = props.shimmer
                  ? charColor(position, shimmerPhase())
                  : rainbowColorForCharacter(props.text, position);
              }}
            >
              {char}
            </span>
          )}
        </For>
      </text>
    </Show>
  );
}

/** The chip: spinner + model-authored activity label, shown only while working. */
function VibeChip(props: {
  readonly context: Plugin.Context;
  readonly sessionID: string;
  readonly settings: VibeSettings;
}) {
  const [running, setRunning] = createSignal(false);
  const [vibeLine, setVibeLine] = createSignal<string | undefined>();
  const [currentAgent, setCurrentAgent] = createSignal<string | undefined>(undefined);

  let spinnerRenderable: TextRenderable | undefined;
  let driver: SemanticDriver | undefined;
  let activeStrategy: GenerationStrategy | undefined;
  let requestRecorded = false;
  let lastAssistantText = "";
  let currentToolKey: string | undefined;
  const recordedTools = new Set<string>();

  const cfg = () => resolveSettings(props.settings);
  const theme = () => props.context.theme as unknown as ThemeLike;
  const messages = () =>
    props.context.data.session.message.list(props.sessionID) as unknown as MessageLike[];

  /** Update the running signal and trace only state transitions for layout diagnosis. */
  const updateRunning = (value: boolean): void => {
    if (running() === value) return;
    trace(`chip state session=${props.sessionID} running=${value}`);
    setRunning(value);
  };

  /** Trace the row's measured size so a live TUI run can confirm it is not collapsed. */
  const traceChipLayout = function (this: Renderable): void {
    trace(`chip layout session=${props.sessionID} size=${this.width}x${this.height}`);
  };

  const sessionModelRef = (): ModelRef | undefined => {
    const model = props.context.data.session.get(props.sessionID)?.model;
    return model ? { providerID: model.providerID, id: model.id, variant: model.variant } : undefined;
  };

  const ensureDriver = (): SemanticDriver => {
    driver ??= new SemanticDriver({
      config: {
        debounceMs: cfg().semanticDebounceMs,
        maxWaitMs: cfg().semanticMaxWaitMs,
        minIntervalMs: cfg().semanticMinIntervalMs,
        timeoutMs: cfg().semanticTimeoutMs,
        maxWords: cfg().semanticMaxWords,
      },
      summarize: (excerpt, signal) => {
        const settings = cfg();
        const model = parseModel(settings.model) ?? sessionModelRef();
        const prompt =
          settings.strategy === "tools"
            ? buildToolSummaryPrompt(excerpt, settings.semanticMaxWords)
            : buildSummaryPrompt(excerpt, settings.semanticMaxWords);
        trace(`semantic request model=${JSON.stringify(model ?? null)} override=${JSON.stringify(settings.model ?? null)}`);
        return generateText(props.context.client, { prompt, model, signal });
      },
      display: (line) => setVibeLine(line),
      onTrace: (event) => trace(`semantic ${JSON.stringify(event)}`),
    });
    return driver;
  };

  /** Track the session's agent so spinner/label can follow its mode color. */
  const updateAgent = (): void => {
    let agent: string | undefined;
    try {
      agent = props.context.data.session.get(props.sessionID)?.agent ?? undefined;
    } catch {
      agent = undefined;
    }
    if (agent !== currentAgent()) {
      trace(`chip agent session=${props.sessionID} agent=${agent ?? "none"}`);
      setCurrentAgent(agent);
    }
  };

  onMount(() => {
    const readRunning = () => {
      try {
        return props.context.data.session.status(props.sessionID) === "running";
      } catch {
        return false;
      }
    };
    updateRunning(readRunning());
    updateAgent();

    // Poll the session status: this build does not deliver session.status events
    // to plugin handlers, and the data layer is the source of truth.
    let ticks = 0;
    const timer = setInterval(() => {
      updateRunning(readRunning());
      updateAgent();
      ticks += 1;
      if (ticks % 3 === 0) void props.context.data.session.message.sync(props.sessionID);
    }, 400);

    const stopStatus = props.context.data.on("session.status", (event) => {
      if (event.data.sessionID !== props.sessionID) return;
      updateRunning(event.data.status.type !== "idle");
    });
    const stopIdle = props.context.data.on("session.idle", (event) => {
      if (event.data.sessionID === props.sessionID) updateRunning(false);
    });
    onCleanup(() => {
      clearInterval(timer);
      stopStatus();
      stopIdle();
      driver?.stop();
      driver = undefined;
    });
  });

  // Keep the session and message stores fresh for the slot's session.
  createEffect(() => {
    const id = props.sessionID;
    if (!id) return;
    void props.context.data.session.sync(id);
    void props.context.data.session.message.sync(id);
  });

  // Update the spinner renderable directly so the animation does not depend on
  // reactive child-text reconciliation in the host renderer.
  createEffect(() => {
    if (!running()) return;
    trace(`chip animation start session=${props.sessionID} agent=${currentAgent() ?? "none"} spinner=${spinnerColor()}`);
    trace(
      `chip theme text=${String(theme().text?.base)} muted=${String(theme().text?.muted)} accent=${String(theme().text?.action?.primary?.base)}`,
    );
    let frame = 0;
    let tracedFrame = false;
    const spinner = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      if (!spinnerRenderable) return;
      spinnerRenderable.content = SPINNER_FRAMES[frame];
      if (!tracedFrame) {
        trace(`chip spinner frame advanced session=${props.sessionID} frame=${frame}`);
        tracedFrame = true;
      }
    }, SPINNER_INTERVAL_MS);
    onCleanup(() => clearInterval(spinner));
  });

  // Feed either broad turn activity or only the selected tool activity to the model.
  // Both strategies keep model-authored text as the sole writer of the chip label.
  createEffect(() => {
    const active = running();
    const strategy = cfg().strategy;

    if (!active) {
      if (activeStrategy !== undefined) {
        driver?.stop();
        driver = undefined;
        activeStrategy = undefined;
        setVibeLine(undefined);
        recordedTools.clear();
        currentToolKey = undefined;
      }
      setVibeLine(undefined);
      return;
    }

    if (activeStrategy !== strategy) {
      driver?.stop();
      driver = undefined;
      activeStrategy = strategy;
      requestRecorded = false;
      lastAssistantText = "";
      recordedTools.clear();
      currentToolKey = undefined;
      setVibeLine(undefined);
      driver = ensureDriver();
      driver.start();
    }

    const list = messages() as MessageLike[];
    const currentTurn = turnSlice(list);

    if (strategy === "tools") {
      // The request grounds intent: without the goal, a bare tool name leaves
      // the model nothing to phrase the operation's purpose from.
      if (!requestRecorded) {
        const task = latestUserText(list);
        if (task) {
          driver?.recordRequest(task);
          requestRecorded = true;
        }
      }
      const selectedTool = latestToolActivity(currentTurn);
      if (!selectedTool || selectedTool.key === currentToolKey) return;

      currentToolKey = selectedTool.key;
      // Keep the cadence and duplicate history across tool updates; the newest tool
      // becomes the tail of the next model delta while the last accepted line stays up.
      driver?.recordToolCall(selectedTool.name, selectedTool.input);
      if (selectedTool.status === "error") driver?.recordFailure(selectedTool.name);
      return;
    }

    if (!requestRecorded) {
      const task = latestUserText(list);
      if (task) {
        driver?.recordRequest(task);
        requestRecorded = true;
      }
    }

    let assistantText = "";
    for (const message of currentTurn) {
      if (message.type !== "assistant" || !message.content) continue;
      for (const entry of message.content) {
        const part = entry as
          | { type?: string; text?: string; name?: string; id?: string; state?: { status?: string; input?: unknown } }
          | undefined;
        if (!part) continue;
        if (part.type === "text" || part.type === "reasoning") {
          if (typeof part.text === "string") assistantText += `${part.text} `;
        } else if (part.type === "tool" && typeof part.name === "string") {
          const status = part.state?.status;
          if (status !== "running" && status !== "completed" && status !== "error") continue;
          const key = typeof part.id === "string" ? part.id : part.name;
          if (recordedTools.has(key)) continue;
          recordedTools.add(key);
          driver?.recordToolCall(part.name, part.state?.input);
          if (status === "error") driver?.recordFailure(part.name);
        }
      }
    }
    // Only forward a genuinely new signal: the poll re-reads the same messages on
    // every tick, and re-emitting unchanged text would keep resetting the quiet
    // timer so a dispatch could only ever fire on the burst cap.
    if (assistantText && assistantText !== lastAssistantText) {
      lastAssistantText = assistantText;
      driver?.recordAssistantText(assistantText);
    }
  });

  /** Spinner + label color for the session's agent mode, when following is on. */
  const agentModeColor = (): VibeColor | undefined => {
    const settings = cfg();
    if (!settings.agentColor) return undefined;
    const agent = currentAgent();
    if (!agent) return undefined;
    let hosted: ReadonlyArray<{ readonly id: string; readonly name?: string; readonly color?: string }> = [];
    try {
      hosted = props.context.data.location.agent.list() ?? [];
    } catch {
      hosted = [];
    }
    return resolveAgentColor(agent, {
      overrides: settings.agentColors,
      hosted,
      builtin: BUILTIN_AGENT_COLORS,
    });
  };

  const spinnerColor = () => {
    const mode = agentModeColor();
    if (mode) return resolveColor(theme(), mode, undefined);
    const configured = cfg().spinnerColor;
    return resolveColor(theme(), isVibeColor(configured) ? configured : undefined, undefined);
  };
  const labelColor = (): VibeColor => {
    const mode = agentModeColor();
    if (mode) return mode;
    const configured = cfg().color;
    if (isVibeColor(configured)) return configured;
    return isVibeColor(DEFAULT_SETTINGS.color) ? DEFAULT_SETTINGS.color : "text";
  };

  return (
    <Show when={running()}>
      <box
        flexDirection="row"
        gap={1}
        width="100%"
        height={1}
        minHeight={1}
        flexShrink={0}
        onSizeChange={traceChipLayout}
      >
        <text
          ref={(node: TextRenderable) => {
            spinnerRenderable = node;
            node.content = SPINNER_FRAMES[0];
          }}
          fg={spinnerColor()}
          wrapMode="none"
        >
          {SPINNER_FRAMES[0]}
        </text>
        <Show when={vibeLine()}>
          {(value: () => string) => (
            <VibeLabel
              text={value()}
              theme={theme()}
              color={labelColor()}
              shimmer={cfg().shimmer}
            />
          )}
        </Show>
      </box>
    </Show>
  );
}

/** Handle `/vibe` subcommands and configuration. */
async function runVibeCommand(
  context: Plugin.Context,
  settings: VibeSettings,
  updateSettings: UpdateSettings,
  args: string,
): Promise<void> {
  const notify = (message: string, variant: "info" | "warning" | "error" = "info") =>
    context.ui.toast.show({ message, variant });

  const parts = args.trim().split(/\s+/).filter(Boolean);
  const action = parts[0]?.toLowerCase();
  const rest = parts.slice(1);

  if (parts.length === 0) {
    notify(
      `Vibe | Strategy: ${settings.strategy} | Model: ${settings.model ?? "session"} | AgentColor: ${settings.agentColor ? "on" : "off"} | Color: ${settings.color} | Spinner: ${settings.spinnerColor} | Shimmer: ${settings.shimmer ? "on" : "off"} | Max: ${settings.semanticMaxWords} words`,
    );
    return;
  }

  if (action === "strategy") {
    const value = rest[0]?.toLowerCase();
    if (!value) {
      notify(`Vibe strategy: ${settings.strategy}`);
      return;
    }
    if (value !== "semantic" && value !== "tools") {
      notify("Usage: /vibe strategy semantic|tools", "error");
      return;
    }
    await updateSettings((draft) => {
      draft.strategy = value;
    });
    notify(`Vibe strategy set to ${value}`);
    return;
  }

  if (action === "model") {
    const model = rest.join(" ").trim();
    if (!model) {
      notify(`Vibe model: ${settings.model ?? "session"}`);
      return;
    }
    if (model !== "default" && !model.includes("/")) {
      notify("Use provider/model-id[#variant], or 'default'.", "error");
      return;
    }
    await updateSettings((draft) => {
      draft.model = model === "default" ? null : model;
    });
    notify(`Vibe model set to ${model}`);
    return;
  }

  if (action === "color" || action === "spinner-color") {
    const value = rest.join(" ").trim();
    const isMessageColor = action === "color";
    if (!value) {
      notify(`Vibe ${action}: ${isMessageColor ? settings.color : settings.spinnerColor}`);
      return;
    }
    // "auto" resumes following the session agent's mode color; a fixed color
    // pauses following so the explicit choice wins.
    if (value !== "auto" && value !== "default" && !isVibeColor(value)) {
      notify("Use text|subdued|accent|success|warning|error|rainbow|#RRGGBB, or 'auto'.", "error");
      return;
    }
    await updateSettings((draft) => {
      if (value === "auto" || value === "default") {
        if (isMessageColor) draft.color = DEFAULT_SETTINGS.color;
        else draft.spinnerColor = DEFAULT_SETTINGS.spinnerColor;
        draft.agentColor = true;
      } else {
        if (isMessageColor) draft.color = value;
        else draft.spinnerColor = value;
        draft.agentColor = false;
      }
    });
    notify(value === "auto" || value === "default" ? `Vibe ${action} follows the agent mode` : `Vibe ${action} set to ${value}`);
    return;
  }

  if (action === "agent-color") {
    const agent = rest[0]?.toLowerCase();
    const value = rest.slice(1).join(" ").trim().toLowerCase();
    if (!agent) {
      const entries = Object.entries(settings.agentColors);
      notify(entries.length === 0 ? "Vibe agent colors: none" : `Vibe agent colors: ${entries.map(([name, color]) => `${name}=${color}`).join(", ")}`);
      return;
    }
    if (value && value !== "default" && !isVibeColor(value)) {
      notify("Usage: /vibe agent-color <agent> <color|default>", "error");
      return;
    }
    await updateSettings((draft) => {
      if (!value || value === "default") delete draft.agentColors[agent];
      else {
        draft.agentColors[agent] = value;
        draft.agentColor = true;
      }
    });
    notify(!value || value === "default" ? `Vibe agent color cleared for ${agent}` : `Vibe agent color for ${agent} set to ${value}`);
    return;
  }

  if (action === "shimmer") {
    const value = rest[0]?.toLowerCase();
    if (!value) {
      notify(`Vibe shimmer: ${settings.shimmer ? "on" : "off"}`);
      return;
    }
    if (value !== "on" && value !== "off") {
      notify("Usage: /vibe shimmer on|off", "error");
      return;
    }
    await updateSettings((draft) => {
      draft.shimmer = value === "on";
    });
    notify(`Vibe shimmer ${value}`);
    return;
  }

  notify("Usage: /vibe [strategy semantic|tools] [model provider/model] [color name|auto] [spinner-color name|auto] [agent-color <agent> <color|default>] [shimmer on|off]", "error");
}

/** Register the `/vibe` slash command and palette entry. */
function registerVibeCommand(
  context: Plugin.Context,
  settings: VibeSettings,
  updateSettings: UpdateSettings,
): void {
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "working-vibes.vibe",
        title: "Working vibes",
        description: "Configure the working-vibes intent chip",
        slash: { name: "vibe", arguments: true },
        palette: true,
        run: (input) => {
          void runVibeCommand(context, settings, updateSettings, input ?? "");
        },
      },
    ],
  }));
}

export default Plugin.define({
  id: "working-vibes",
  setup(context) {
    const [settings, updateSettings] = context.storage.store("settings", { initial: DEFAULT_SETTINGS });

    registerVibeCommand(context, settings, updateSettings);

    return context.ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <VibeChip context={context} sessionID={input.sessionID} settings={settings} />
      ),
    });
  },
});
