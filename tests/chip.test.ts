// The chip is derived state plus a painter, so the states the design draws are
// testable without a window: working, pending, interrupted, idle, and a long label.
import { describe, expect, test } from "bun:test";
import { chipView } from "../src/desktop/chip.js";
import { readTurn } from "../src/desktop/line.js";

const turn = (values: unknown[]) => readTurn(values);

const user = { type: "user", text: "fix the scroll" };
const idle = { type: "idle", outcome: "succeeded" };
const tool = (name: string, status = "running") => ({
  type: "tool",
  name,
  state: { status, input: { filePath: "packages/desktop/src/routes/session.tsx" } },
});
const assistant = (...content: unknown[]) => ({ type: "assistant", content, model: { providerID: "p", id: "m" } });

describe("readTurn", () => {
  test("a turn without an idle marker is working", () => {
    expect(turn([user, assistant(tool("read"))]).turn).toBe("working");
  });

  test("an idle marker after the activity ends the turn", () => {
    expect(turn([user, assistant(tool("read", "completed")), idle]).turn).toBe("idle");
  });

  test("an interrupted outcome stays visible", () => {
    expect(turn([user, assistant(tool("read")), { type: "idle", outcome: "interrupted" }]).turn).toBe("interrupted");
  });

  test("an idle marker from an earlier turn does not end the current one", () => {
    expect(turn([user, idle, user, assistant(tool("read"))]).turn).toBe("working");
  });

  test("step counts tool calls since the request", () => {
    const messages = [user, assistant(tool("read", "completed")), assistant(tool("edit", "completed")), user, assistant(tool("bash"))];
    expect(turn(messages).step).toBe(1);
  });

  test("the tool chip names the running tool", () => {
    // The strip truncates from the left in CSS, so the label keeps the whole path.
    expect(turn([user, assistant(tool("read"))]).tool).toBe("read packages/desktop/src/routes/session.tsx");
  });
});

describe("chipView", () => {
  test("working paints spinner, line, tool and step", () => {
    expect(chipView({ turn: "working", line: "Tracing the scroll", tool: "read route.ts", step: 3 })).toEqual({
      state: "working",
      visible: true,
      label: "Tracing the scroll",
      tool: "read route.ts",
      step: 3,
      spinning: true,
    });
  });

  test("no line yet keeps the strip and hides only the label", () => {
    const view = chipView({ turn: "working", line: null, tool: null, step: 0 });
    expect(view.state).toBe("pending");
    expect(view.visible).toBe(true);
    expect(view.label).toBe("");
  });

  test("interrupted does not spin and keeps the last line", () => {
    const view = chipView({ turn: "interrupted", line: "Tracing the scroll", tool: null, step: 4 });
    expect(view.state).toBe("interrupted");
    expect(view.spinning).toBe(false);
    expect(view.label).toBe("Tracing the scroll");
  });

  test("interrupted with no line still says something", () => {
    expect(chipView({ turn: "interrupted", line: null, tool: null, step: 0 }).label).toBe("Interrupted");
  });

  test("idle hides the chip", () => {
    const view = chipView({ turn: "idle", line: "Tracing the scroll", tool: "read route.ts", step: 3 });
    expect(view.visible).toBe(false);
    expect(view.state).toBe("idle");
    expect(view.spinning).toBe(false);
  });

  test("a long label is passed through whole; the strip ellipsises it", () => {
    const label = "Refactoring the session panel scroll restoration across the renderer routes";
    expect(chipView({ turn: "working", line: label, tool: null, step: 1 }).label).toBe(label);
  });
});
