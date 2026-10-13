// Unit/integration tests for the semantic activity layer: activity buffer, cadence
// gate, sanitizing, and the driver. Ported from pi-working-vibes' semantic.test.ts.
import { describe, expect, test } from "bun:test";

import { ActivityBuffer, buildExcerpt, describeToolCall, latestToolActivity, oneLine, redactSecrets } from "../src/activity.js";
import {
  buildToolSummaryPrompt,
  beginDispatch,
  cadenceTick,
  createCadence,
  endDispatch,
  isNearDuplicate,
  markActivity,
  sanitizeSummary,
} from "../src/semantic.js";
import { SemanticDriver } from "../src/semantic-driver.js";

const CADENCE = { debounceMs: 1500, maxWaitMs: 2500, minIntervalMs: 2500 };
const WORDS = 12;

describe("tool summary prompt", () => {
  test("asks for model-authored statuses based only on tool activity", () => {
    const prompt = buildToolSummaryPrompt("Activity since the last update:\n- read src/config.ts", WORDS);
    expect(prompt).toContain("narrate a coding agent's live tool activity");
    expect(prompt).toContain("OPERATION INTENT");
    expect(prompt).toContain("Every tool call gets a status line");
    expect(prompt).toContain("read src/config.ts");
  });
});

describe("activity", () => {
  test("lines redact credentials and stay one bounded line", () => {
    expect(redactSecrets("token: abc123def456")).toBe("token: <redacted>");
    expect(redactSecrets("PASSWORD=hunter2")).toBe("PASSWORD=<redacted>");
    expect(redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef")).toBe("Authorization: <redacted>");
    expect(redactSecrets("key sk-abcdefghijklmnop")).toMatch(/<redacted>/);
    expect(oneLine("a\n\n  b\t c")).toBe("a b c");
    expect(oneLine("x".repeat(300)).length).toBe(160);
  });

  test("bash carries only its description; other tools carry one salient argument", () => {
    expect(describeToolCall("bash", { command: "curl -H 'token: secret' https://x" })).toBe("bash");
    expect(describeToolCall("bash", { command: "npm test", description: "Running the suite" })).toBe(
      "bash (Running the suite)",
    );
    expect(describeToolCall("read", { filePath: "/Users/a/Projects/app/src/index.ts" })).toBe(
      "read /Users/a/Projects/app/src/index.ts",
    );
    expect(describeToolCall("grep", { pattern: "describeToolCall" })).toBe("grep describeToolCall");
    expect(describeToolCall("webfetch", { url: "https://example.com" })).toBe("webfetch https://example.com");
    expect(describeToolCall("ls", {})).toBe("ls");
  });

  test("selects the newest running tool, falls back to active predecessors, then the last completion", () => {
    const snapshot = (tools: unknown[]) => [{ type: "assistant", content: tools }];
    const read = (status: string, ran: number, completed?: number) => ({
      type: "tool",
      id: "read-1",
      name: "read",
      state: { status, input: { filePath: "src/config.ts" } },
      time: { created: 1, ran, completed },
    });
    const grep = (status: string, ran: number, completed?: number) => ({
      type: "tool",
      id: "grep-1",
      name: "grep",
      state: { status, input: { pattern: "strategy" } },
      time: { created: 2, ran, completed },
    });

    expect(latestToolActivity(snapshot([read("running", 10), grep("running", 20)]))?.name).toBe("grep");
    expect(latestToolActivity(snapshot([read("running", 10), grep("completed", 20, 30)]))?.name).toBe("read");
    expect(latestToolActivity(snapshot([read("completed", 10, 40), grep("completed", 20, 30)]))?.name).toBe("read");
    expect(latestToolActivity(snapshot([{ type: "tool", name: "read", state: { status: "streaming", input: "{" } }]))).toBeUndefined();
  });

  test("the buffer exposes only activity no accepted answer has consumed", () => {
    const buffer = new ActivityBuffer();
    buffer.recordRequest("fix the parser");
    buffer.recordToolCall("read", { filePath: "a.ts" });
    buffer.recordToolCall("read", { filePath: "a.ts" }); // immediate repeat collapses
    expect(buffer.pendingCount).toBe(1);

    const delta = buffer.takePending();
    expect(delta.map((line) => line.kind)).toEqual(["tool"]);
    expect(buffer.hasPending).toBe(true);

    buffer.consumeThrough(delta.at(-1)!.index);
    expect(buffer.hasPending).toBe(false);

    buffer.recordToolCall("edit", { filePath: "b.ts" });
    expect(buffer.pendingCount).toBe(1);
  });

  test("assistant output becomes a line only after it grows enough", () => {
    const buffer = new ActivityBuffer();
    buffer.recordRequest("do the thing");
    buffer.recordAssistantText("short");
    expect(buffer.hasPending).toBe(false);

    buffer.recordAssistantText("x".repeat(200));
    expect(buffer.hasPending).toBe(true);
    expect(buffer.takePending()[0]!.text).toMatch(/^agent wrote: /);
  });

  test("the excerpt is framed and bounded", () => {
    const buffer = new ActivityBuffer();
    buffer.recordRequest("fix the parser");
    buffer.recordToolCall("read", { filePath: "a.ts" });
    const delta = buffer.takePending();
    const excerpt = buildExcerpt(delta, ["Reading the parser"], "fix the parser");
    expect(excerpt).toMatch(/User request:/);
    expect(excerpt).toMatch(/Activity since the last update:/);
    expect(excerpt).toMatch(/Already shown:/);
    expect(buildExcerpt(delta, [], "x".repeat(5000)).length).toBeLessThanOrEqual(2400);
  });
});

describe("cadence", () => {
  test("waits for quiet, caps a burst, and floors the interval", () => {
    const state = createCadence();
    expect(cadenceTick(state, 0, CADENCE, false)).toBe("idle");
    expect(cadenceTick(state, 0, CADENCE, true)).toBe("idle");

    markActivity(state, 0);
    expect(cadenceTick(state, 500, CADENCE, true)).toBe("wait");
    expect(cadenceTick(state, 1500, CADENCE, true)).toBe("dispatch");

    beginDispatch(state, 1500);
    expect(cadenceTick(state, 9000, CADENCE, true)).toBe("wait");
    endDispatch(state);

    markActivity(state, 1600);
    expect(cadenceTick(state, 3100, CADENCE, true)).toBe("wait");
    expect(cadenceTick(state, 4000, CADENCE, true)).toBe("dispatch");
  });

  test("a continuously streaming turn still updates at the burst cap", () => {
    const state = createCadence();
    markActivity(state, 0);
    for (const at of [400, 800, 1200]) markActivity(state, at);
    expect(cadenceTick(state, 1400, CADENCE, true)).toBe("wait");
    expect(cadenceTick(state, 2500, CADENCE, true)).toBe("dispatch");
  });
});

describe("sanitizeSummary", () => {
  test("cleans output and enforces the word budget without trimming", () => {
    expect(sanitizeSummary("Investigating why the connection fails", WORDS)).toEqual({
      kind: "summary",
      text: "Investigating why the connection fails",
    });
    expect(sanitizeSummary("Investigating why the connection fails.", WORDS)).toEqual({
      kind: "summary",
      text: "Investigating why the connection fails",
    });
    expect(sanitizeSummary("SKIP", WORDS)).toEqual({ kind: "skip", reason: "model-skip" });
    expect(sanitizeSummary("", WORDS).kind).toBe("reject");
    expect(sanitizeSummary("The tool ran", WORDS).kind).toBe("reject");
    expect(sanitizeSummary("Investigating the failure with", WORDS).kind).toBe("reject");
    expect(sanitizeSummary("```\nFixing the config loader\n```", WORDS).kind).toBe("summary");

    const full = "Tracing why the Snowflake connection keeps failing after rotation";
    expect(full.split(" ").length).toBe(9);
    expect(sanitizeSummary(full, WORDS).kind).toBe("summary");

    const thirteen = `${full} today again later on`;
    expect(thirteen.split(" ").length).toBe(13);
    expect(sanitizeSummary(thirteen, WORDS)).toEqual({ kind: "reject", reason: "too-many-words" });

    const withPath = sanitizeSummary("Editing intent.ts to fix the lookup", WORDS);
    expect(withPath.kind).toBe("summary");
    expect(String((withPath as { text: string }).text)).not.toContain("intent.ts");
  });

  test("near-duplicates ignore case, punctuation and spacing", () => {
    expect(isNearDuplicate("Editing intent.ts.", "editing intent ts")).toBe(true);
    expect(isNearDuplicate("Fixing the loader", "Investigating the loader")).toBe(false);
    expect(isNearDuplicate("", "anything")).toBe(false);
  });
});

describe("driver", () => {
  interface Harness {
    driver: SemanticDriver;
    calls: string[];
    shown: string[];
    traces: Record<string, unknown>[];
    advance: (ms: number) => void;
    setReply: (reply: string | (() => Promise<string>)) => void;
  }

  function makeHarness(config: Partial<{ debounceMs: number; maxWaitMs: number; minIntervalMs: number; maxWords: number }> = {}): Harness {
    let clock = 0;
    let reply: string | (() => Promise<string>) = "Investigating why the parser fails";
    const calls: string[] = [];
    const shown: string[] = [];
    const traces: Record<string, unknown>[] = [];

    const driver = new SemanticDriver({
      config: { debounceMs: 1500, maxWaitMs: 2500, minIntervalMs: 2500, timeoutMs: 6000, maxWords: 12, ...config },
      now: () => clock,
      setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
      clearTimer: () => {},
      summarize: async (prompt) => {
        calls.push(prompt);
        return typeof reply === "function" ? await reply() : reply;
      },
      display: (line) => shown.push(line),
      onTrace: (event) => traces.push(event),
    });

    return {
      driver,
      calls,
      shown,
      traces,
      advance: (ms) => {
        clock += ms;
      },
      setReply: (next) => {
        reply = next;
      },
    };
  }

  test("dispatches only after a quiet period and sends only new activity", async () => {
    const harness = makeHarness();
    harness.driver.start();
    harness.driver.recordRequest("fix the parser");
    harness.driver.recordToolCall("read", { filePath: "parser.ts" });

    await harness.driver.tick();
    expect(harness.calls.length).toBe(0);

    harness.advance(1500);
    await harness.driver.tick();
    expect(harness.calls.length).toBe(1);
    expect(harness.calls[0]!).toMatch(/read parser\.ts/);
    expect(harness.shown).toEqual(["Investigating why the parser fails"]);

    harness.driver.recordToolCall("edit", { filePath: "parser.ts" });
    harness.advance(3000);
    await harness.driver.tick();
    expect(harness.calls.length).toBe(2);
    expect(harness.calls[1]!).toMatch(/edit parser\.ts/);
    expect(harness.calls[1]!).not.toMatch(/read parser\.ts/);
  });

  test("tool-focused updates can run on tool activity alone and stay model-authored", async () => {
    const harness = makeHarness();
    harness.driver.start();
    harness.driver.recordToolCall("read", { filePath: "src/config.ts" });

    harness.advance(1500);
    await harness.driver.tick();

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toContain("read src/config.ts");
    expect(harness.calls[0]).not.toContain("User request:");
    expect(harness.shown).toEqual(["Investigating why the parser fails"]);
  });

  test("a reworded answer is withheld instead of repainted", async () => {
    const harness = makeHarness();
    harness.driver.start();
    harness.driver.recordRequest("fix the parser");
    harness.driver.recordToolCall("read", { filePath: "parser.ts" });
    harness.advance(1500);
    await harness.driver.tick();
    expect(harness.shown.length).toBe(1);

    harness.setReply("Investigating why the parser fails.");
    harness.driver.recordToolCall("read", { filePath: "other.ts" });
    harness.advance(3000);
    await harness.driver.tick();
    expect(harness.shown.length).toBe(1);
    expect(harness.traces.some((event) => event.semantic === "skip" && event.reason === "near-duplicate")).toBe(true);
  });

  test("a skip consumes the delta; a reject keeps it for the next call", async () => {
    const harness = makeHarness();
    harness.driver.start();
    harness.driver.recordRequest("fix the parser");
    harness.driver.recordToolCall("read", { filePath: "parser.ts" });
    harness.setReply("SKIP");
    harness.advance(1500);
    await harness.driver.tick();
    expect(harness.shown.length).toBe(0);

    harness.driver.recordToolCall("read", { filePath: "b.ts" });
    harness.advance(3000);
    await harness.driver.tick();
    const deltaSection = (call: string) => call.split("Activity since the last update:")[1]?.split("Already shown:")[0] ?? "";
    expect(deltaSection(harness.calls[1]!)).not.toContain("fix the parser");
    expect(deltaSection(harness.calls[1]!)).toMatch(/read b\.ts/);

    harness.setReply("The tool ran");
    harness.driver.recordToolCall("read", { filePath: "c.ts" });
    harness.advance(3000);
    await harness.driver.tick();
    expect(harness.traces.some((event) => event.semantic === "reject")).toBe(true);

    // The rejected delta is not consumed: the next call carries it again.
    harness.setReply("Fixing the broken import path");
    harness.driver.recordToolCall("edit", { filePath: "d.ts" });
    harness.advance(3000);
    await harness.driver.tick();
    expect(harness.calls.at(-1)!).toMatch(/read c\.ts/);
    expect(harness.calls.at(-1)!).toMatch(/edit d\.ts/);
    expect(harness.shown.at(-1)).toBe("Fixing the broken import path");
  });

  test("one call is in flight at a time, and stop() prevents painting", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeHarness();
    harness.driver.start();
    harness.driver.recordRequest("fix the parser");
    harness.driver.recordToolCall("read", { filePath: "parser.ts" });
    harness.setReply(async () => {
      await gate;
      return "Investigating the failing import";
    });

    harness.advance(1500);
    const first = harness.driver.tick();
    harness.advance(5000);
    await harness.driver.tick();
    expect(harness.calls.length).toBe(1);

    release?.();
    await first;
    expect(harness.shown).toEqual(["Investigating the failing import"]);

    harness.setReply(async () => {
      await gate;
      return "Fixing the config loader";
    });
    harness.driver.recordToolCall("edit", { filePath: "loader.ts" });
    harness.advance(3000);
    const pending = harness.driver.tick();
    harness.driver.stop();
    release?.();
    await pending;
    expect(harness.shown.length).toBe(1);
  });
});
