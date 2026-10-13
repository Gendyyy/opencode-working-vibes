// Unit tests for the narration transport: model parsing, endpoint shapes, fallbacks.
import { describe, expect, test } from "bun:test";

import { generateText, parseModel } from "../src/narration.js";

describe("parseModel", () => {
  test("parses provider/model and optional variant", () => {
    expect(parseModel("anthropic/claude-haiku-5-5")).toEqual({ providerID: "anthropic", id: "claude-haiku-5-5" });
    expect(parseModel("openai/gpt-5:low")).toEqual({ providerID: "openai", id: "gpt-5", variant: "low" });
    expect(parseModel("openai/gpt-6-luna#low")).toEqual({ providerID: "openai", id: "gpt-6-luna", variant: "low" });
  });

  test("rejects malformed specs", () => {
    expect(parseModel(null)).toBeUndefined();
    expect(parseModel("noprovider")).toBeUndefined();
  });
});

describe("generateText", () => {
  test("prefers experimental.generate.text and unwraps { data: { text } }", async () => {
    const calls: string[] = [];
    const client = {
      generate: { text: async () => (calls.push("top"), { text: "top" }) },
      experimental: { generate: { text: async () => (calls.push("exp"), { data: { text: "exp" } }) } },
    };
    expect(await generateText(client, { prompt: "p" })).toBe("exp");
    expect(calls).toEqual(["exp"]);
  });

  test("falls back to generate.text when experimental is absent", async () => {
    const client = { generate: { text: async () => ({ text: "top" }) } };
    expect(await generateText(client, { prompt: "p" })).toBe("top");
  });

  test("passes the model and the abort signal through", async () => {
    let seen: { prompt?: string; model?: unknown } = {};
    let seenOptions: unknown;
    const controller = new AbortController();
    const client = {
      generate: {
        text: async (input: unknown, options: unknown) => {
          seen = input as typeof seen;
          seenOptions = options;
          return { text: "ok" };
        },
      },
    };
    await generateText(client, {
      prompt: "p",
      model: { providerID: "anthropic", id: "haiku" },
      signal: controller.signal,
    });
    expect(seen.prompt).toBe("p");
    expect(seen.model).toEqual({ providerID: "anthropic", id: "haiku" });
    expect(seenOptions).toEqual({ signal: controller.signal });
  });

  test("falls through when the first group throws", async () => {
    const client = {
      experimental: { generate: { text: async () => { throw new Error("404"); } } },
      generate: { text: async () => ({ text: "recovered" }) },
    };
    expect(await generateText(client, { prompt: "p" })).toBe("recovered");
  });

  test("throws when no generate method exists", async () => {
    await expect(generateText({}, { prompt: "p" })).rejects.toThrow("unavailable");
  });
});
