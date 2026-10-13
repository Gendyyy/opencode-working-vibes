// Wires the activity buffer, the cadence gate and the model call together.
//
// Ported from pi-working-vibes. The driver owns one interval timer, one in-flight
// call, and the list of previously accepted lines. Its dependencies are injected so
// the whole flow can be exercised with a fake clock and a fake model.

import { ActivityBuffer, buildExcerpt } from "./activity.js";
import {
  TICK_MS,
  beginDispatch,
  cadenceReset,
  cadenceTick,
  createCadence,
  endDispatch,
  isNearDuplicate,
  markActivity,
  sanitizeSummary,
  type CadenceConfig,
} from "./semantic.js";

export interface SemanticDriverConfig extends CadenceConfig {
  /** End-to-end deadline for one call. */
  readonly timeoutMs: number;
  /** Maximum accepted words. */
  readonly maxWords: number;
}

export interface SemanticDriverOptions {
  readonly config: SemanticDriverConfig;
  /** Ask the model. Must respect the signal. */
  readonly summarize: (prompt: string, signal: AbortSignal) => Promise<string>;
  /** Paint an accepted line. */
  readonly display: (line: string) => void;
  /** Optional trace sink, mirroring dsh's `semantic: summary|skip|error` log lines. */
  readonly onTrace?: (event: Record<string, unknown>) => void;
  /** Injectable clock. */
  readonly now?: () => number;
  /** Injectable timer factory, so tests can drive ticks by hand. */
  readonly setTimer?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
  /** How many accepted lines to send back as context. */
  readonly recentContext?: number;
}

const DEFAULT_RECENT_CONTEXT = 8;

export class SemanticDriver {
  readonly #options: SemanticDriverOptions;
  readonly #buffer = new ActivityBuffer();
  readonly #cadence = createCadence();
  readonly #now: () => number;
  readonly #setTimer: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly #clearTimer: (timer: ReturnType<typeof setInterval>) => void;
  #accepted: string[] = [];
  #current: string | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inflight: AbortController | undefined;
  #running = false;

  constructor(options: SemanticDriverOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer = options.setTimer ?? ((handler, ms) => setInterval(handler, ms));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearInterval(timer));
  }

  /** Begin a turn: fresh activity, fresh cadence, timer running. */
  start(): void {
    this.#buffer.reset();
    this.#accepted = [];
    this.#current = null;
    cadenceReset(this.#cadence);
    this.#running = true;
    this.#timer ??= this.#setTimer(() => void this.tick(), TICK_MS);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  /** End a turn: stop the timer and abandon any in-flight call. */
  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
    this.#inflight?.abort();
    this.#inflight = undefined;
    endDispatch(this.#cadence);
  }

  recordRequest(prompt: string): void {
    this.#buffer.recordRequest(prompt);
    markActivity(this.#cadence, this.#now());
  }

  recordToolCall(name: string, args: unknown): void {
    this.#buffer.recordToolCall(name, args);
    markActivity(this.#cadence, this.#now());
  }

  recordFailure(name: string): void {
    this.#buffer.recordFailure(name);
    markActivity(this.#cadence, this.#now());
  }

  recordAssistantText(text: string): void {
    this.#buffer.recordAssistantText(text);
    markActivity(this.#cadence, this.#now());
  }

  /** Exposed for tests and diagnostics. */
  get currentLine(): string | null {
    return this.#current;
  }

  /** One cadence decision. Public so tests can drive it without real timers. */
  async tick(): Promise<void> {
    if (!this.#running) return;
    const now = this.#now();
    const action = cadenceTick(this.#cadence, now, this.#options.config, this.#buffer.hasPending);
    if (action !== "dispatch") return;
    await this.#dispatch();
  }

  async #dispatch(): Promise<void> {
    const delta = this.#buffer.takePending();
    if (delta.length === 0) return;

    const excerpt = buildExcerpt(
      delta,
      this.#accepted.slice(0, this.#options.recentContext ?? DEFAULT_RECENT_CONTEXT),
      this.#buffer.request,
    );

    const controller = new AbortController();
    this.#inflight = controller;
    beginDispatch(this.#cadence, this.#now());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.#options.config.timeoutMs)]);

    try {
      const raw = await this.#options.summarize(excerpt, signal);
      if (controller.signal.aborted) return;

      const result = sanitizeSummary(raw, this.#options.config.maxWords);
      const lastIndex = delta.at(-1)!.index;

      if (result.kind === "reject") {
        // Keep the lines: a rejected answer has not consumed them.
        this.#trace({ semantic: "reject", reason: result.reason });
        return;
      }

      // A skip means the model read the delta and had nothing new to say, so the
      // lines are consumed to avoid re-asking about them forever.
      this.#buffer.consumeThrough(lastIndex);
      if (result.kind === "skip") {
        this.#trace({ semantic: "skip", reason: result.reason });
        return;
      }

      if (this.#current !== null && isNearDuplicate(result.text, this.#current)) {
        this.#trace({ semantic: "skip", reason: "near-duplicate", text: result.text });
        return;
      }

      this.#current = result.text;
      this.#accepted = [result.text, ...this.#accepted].slice(0, this.#options.recentContext ?? DEFAULT_RECENT_CONTEXT);
      this.#options.display(result.text);
      this.#trace({ semantic: "summary", text: result.text, lines: delta.length });
    } catch (error) {
      if (controller.signal.aborted) {
        this.#trace({ semantic: "abort" });
      } else {
        // Preserve the full server payload: API failures arrive as plain data
        // objects whose extra fields (scope, model, cause) explain rejections
        // like "Model unavailable" far better than the message alone.
        const detail =
          error instanceof Error
            ? { name: error.name, message: error.message, cause: String((error as { cause?: unknown }).cause ?? "") || undefined }
            : error;
        this.#trace({ semantic: "error", error: detail });
      }
    } finally {
      if (this.#inflight === controller) this.#inflight = undefined;
      endDispatch(this.#cadence);
    }
  }

  #trace(event: Record<string, unknown>): void {
    this.#options.onTrace?.({ at: this.#now(), ...event });
  }
}
