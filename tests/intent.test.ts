// Unit tests for reading the current user request out of OpenCode's message list.
import { describe, expect, test } from "bun:test";

import { latestUserText, type MessageLike } from "../src/intent.js";

describe("latestUserText", () => {
  test("returns the most recent user text", () => {
    const messages: MessageLike[] = [
      { type: "user", text: "first" },
      { type: "assistant", content: [] },
      { type: "user", text: "second" },
    ];
    expect(latestUserText(messages)).toBe("second");
  });

  test("returns undefined when no user message exists", () => {
    const messages: MessageLike[] = [{ type: "assistant", content: [] }];
    expect(latestUserText(messages)).toBeUndefined();
  });

  test("treats blank user text as absent", () => {
    expect(latestUserText([{ type: "user", text: "   " }])).toBeUndefined();
  });
});
