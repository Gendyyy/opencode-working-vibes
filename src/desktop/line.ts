// The desktop line source.
//
// shortcut: the GUI bundle runs its own narrator, so a session open in both the TUI
// and Desktop asks the model twice per turn. Move it behind the plugin's server part
// (an rpc channel) once the SDK pin carries one.
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { describeToolCall, latestToolActivity } from "../core/activity.js";
import { latestUserText } from "../core/intent.js";
import { generateText, parseModel, type ModelRef } from "../core/narration.js";
import { buildSummaryPrompt, buildToolSummaryPrompt } from "../core/semantic.js";
import { SemanticDriver } from "../core/semantic-driver.js";
import { resolveSettings } from "../settings.js";
import type { ChipInput, TurnState } from "./chip.js";

interface Part {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly text?: unknown;
  readonly state?: { readonly input?: unknown };
}

interface Message {
  readonly type?: unknown;
  readonly content?: ReadonlyArray<unknown>;
  readonly text?: unknown;
  readonly outcome?: unknown;
  readonly model?: ModelRef;
}

interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

/** The slice of a mounted session this part reads. */
export interface SessionSource {
  readonly id?: string;
  readonly server: {
    readonly data: {
      readonly session: {
        readonly message: { readonly list: (id: string) => ReadonlyArray<unknown> };
      };
    };
  };
}

export interface TurnView {
  readonly turn: TurnState;
  readonly tool: string | null;
  readonly step: number;
  /** Tool calls made since the request that opened this turn. */
  readonly tools: ReadonlyArray<ToolCall>;
  /** Assistant text written during this turn. */
  readonly text: string;
}

function part(value: unknown): Part | undefined {
  return typeof value === "object" && value !== null ? (value as Part) : undefined;
}

function asMessageLikes(messages: ReadonlyArray<Message>) {
  return messages.map((message) => ({
    type: typeof message.type === "string" ? message.type : "",
    content: message.content,
    text: typeof message.text === "string" ? message.text : undefined,
  }));
}

/**
 * Turn state from the message log the host already holds: `idle` markers close a
 * turn, so the last one after the last activity decides. A turn with no marker is
 * still running.
 */
export function readTurn(values: ReadonlyArray<unknown>): TurnView {
  const messages = values as ReadonlyArray<Message>;
  let lastUser = -1;
  let lastActive = -1;
  let idle: Message | undefined;
  let idleAt = -1;

  messages.forEach((message, index) => {
    if (message.type === "user") lastUser = index;
    if (message.type === "user" || message.type === "assistant") lastActive = index;
    if (message.type === "idle") {
      idle = message;
      idleAt = index;
    }
  });

  const working = lastActive > idleAt;
  const turn: TurnState = working
    ? "working"
    : idle?.outcome === "interrupted" && lastActive >= 0
      ? "interrupted"
      : "idle";

  const current = messages.slice(lastUser < 0 ? 0 : lastUser);
  const tools: ToolCall[] = [];
  let text = "";

  for (const message of current) {
    if (message.type !== "assistant" || !message.content) continue;
    for (const value of message.content) {
      const candidate = part(value);
      if (candidate?.type === "tool" && typeof candidate.name === "string") {
        tools.push({ name: candidate.name, input: candidate.state?.input });
      }
      if (candidate?.type === "text" && typeof candidate.text === "string") text += candidate.text;
    }
  }

  const latest = latestToolActivity(asMessageLikes(current));

  return {
    turn,
    tool: latest ? describeToolCall(latest.name, latest.input) : null,
    step: tools.length,
    tools,
    text,
  };
}

function modelOf(messages: ReadonlyArray<Message>): ModelRef | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.model;
    if (model) return model;
  }
  return undefined;
}

/**
 * Watch one session and narrate its live turn. The driver is the same one the TUI
 * uses, so both hosts paint the same line from the same rules.
 */
export function createWorkingLine(
  session: () => SessionSource | undefined,
  client: () => unknown,
): Accessor<ChipInput> {
  const settings = resolveSettings(undefined);
  const [line, setLine] = createSignal<string | null>(null);

  const messages = createMemo(() => {
    const current = session();
    return (current?.id ? current.server.data.session.message.list(current.id) : []) as ReadonlyArray<Message>;
  });
  const turn = createMemo(() => readTurn(messages()));

  const driver = new SemanticDriver({
    config: {
      firstDispatchMs: settings.semanticFirstDispatchMs,
      debounceMs: settings.semanticDebounceMs,
      maxWaitMs: settings.semanticMaxWaitMs,
      minIntervalMs: settings.semanticMinIntervalMs,
      timeoutMs: settings.semanticTimeoutMs,
      maxWords: settings.semanticMaxWords,
      // Tools mode narrates a live turn, so it must not sit on a debounce or a
      // call floor; semantic mode keeps the throttled cadence.
      realtime: settings.strategy === "tools",
    },
    summarize: (excerpt, signal) => {
      const model = parseModel(settings.model) ?? modelOf(messages());
      const prompt =
        settings.strategy === "tools"
          ? buildToolSummaryPrompt(excerpt, settings.semanticMaxWords)
          : buildSummaryPrompt(excerpt, settings.semanticMaxWords);

      return generateText(client(), { prompt, model, signal });
    },
    display: (next) => setLine(next),
  });

  let running = false;
  let seenTools = 0;
  let seenText = 0;
  let seenRequest: string | undefined;

  createEffect(() => {
    const view = turn();

    if (view.turn === "working" && !running) {
      running = true;
      seenTools = 0;
      seenText = 0;
      setLine(null);
      driver.start();
    }
    if (!running) return;

    const request = latestUserText(asMessageLikes(messages()));
    if (request && request !== seenRequest) {
      seenRequest = request;
      driver.recordRequest(request);
    }

    for (const tool of view.tools.slice(seenTools)) driver.recordToolCall(tool.name, tool.input);
    seenTools = view.tools.length;

    if (view.text.length > seenText) {
      driver.recordAssistantText(view.text.slice(seenText));
      seenText = view.text.length;
    }

    if (view.turn !== "working") {
      running = false;
      driver.stop();
    }
  });

  onCleanup(() => driver.stop());

  return createMemo(() => ({ turn: turn().turn, line: line(), tool: turn().tool, step: turn().step }));
}
