// Unit tests for OpenCode theme color mapping, the shimmer sweep, and settings resolution.
import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";

import { bandColor, rainbowColorAt, rainbowColorForCharacter, resolveAgentColor, resolveColor, shimmerBand, type ThemeLike } from "../src/color.js";
import { BUILTIN_AGENT_COLORS, CLAUDE_CODE_ORANGE, DEFAULT_SETTINGS, resolveSettings, SHIMMER_FRAME_MS, SPINNER_FRAMES } from "../src/settings.js";

const theme: ThemeLike = {
  text: {
    base: "#eeeeee",
    muted: "#888888",
    action: { primary: { base: "#00aaff" } },
    feedback: {
      success: { base: "#00ff00" },
      warning: { base: "#ffaa00" },
      error: { base: "#ff0000" },
    },
  },
};

describe("resolveColor", () => {
  test("maps names to OpenCode 2.0.26 runtime theme tokens", () => {
    expect(resolveColor(theme, "text")).toBe("#eeeeee");
    expect(resolveColor(theme, "subdued")).toBe("#888888");
    expect(resolveColor(theme, "accent")).toBe("#00aaff");
    expect(resolveColor(theme, "success")).toBe("#00ff00");
    expect(resolveColor(theme, "warning")).toBe("#ffaa00");
    expect(resolveColor(theme, "error")).toBe("#ff0000");
  });

  test("passes hex through and falls back to the theme's muted color", () => {
    expect(resolveColor(theme, "#123456")).toBe("#123456");
    expect(resolveColor(theme, undefined, "#fallback")).toBe("#fallback");
    expect(resolveColor(theme, undefined)).toBe("#888888");
  });

  test("never throws when the theme is empty (defensive reads)", () => {
    expect(resolveColor({}, "accent")).toBeUndefined();
    expect(resolveColor({}, undefined, "#x")).toBe("#x");
  });

  test("preserves the RGBA tokens supplied by OpenCode at runtime", () => {
    const foreground = RGBA.fromHex("#eeeeee");
    const accent = RGBA.fromHex("#e6b450");
    const resolvedTheme: ThemeLike = {
      text: {
        base: foreground,
        muted: RGBA.fromHex("#888888"),
        action: { primary: { base: accent } },
      },
    };

    expect(resolveColor(resolvedTheme, "text")).toBe(foreground);
    expect(resolveColor(resolvedTheme, "accent")).toBe(accent);
    expect(bandColor(resolvedTheme, undefined, "highlight")).toBe(foreground);
  });
});

describe("rainbow + shimmer", () => {
  test("rainbow cycles deterministically", () => {
    expect(rainbowColorAt(0)).toBe(rainbowColorAt(7));
    expect(rainbowColorAt(0)).not.toBe(rainbowColorAt(1));
  });

  test("rainbow advances only across visible characters (pi parity)", () => {
    // Spaces and colons keep no color; the cycle advances only across visible characters.
    expect(rainbowColorForCharacter("a b", 2)).toBe(rainbowColorAt(1));
    expect(rainbowColorForCharacter("a b", 1)).toBeUndefined();
    expect(rainbowColorForCharacter("a:b", 1)).toBeUndefined();
    expect(rainbowColorForCharacter("🙂a", 1)).toBe(rainbowColorAt(1));
  });

  test("shimmer matches pi's highlight, accent, dim, and base bands", () => {
    expect(shimmerBand(0, 3)).toBe("highlight");
    expect(shimmerBand(1, 3)).toBe("accent");
    expect(shimmerBand(0, 7)).toBe("dim");
    expect(shimmerBand(8, 3)).toBe("base");
  });
});

describe("resolveAgentColor", () => {
  const sources = {
    overrides: { plan: "#112233" },
    hosted: [{ id: "debug", color: "warning" }],
    builtin: BUILTIN_AGENT_COLORS,
  };

  test("prefers overrides, then host definitions, then built-ins", () => {
    expect(resolveAgentColor("plan", sources)).toBe("#112233");
    expect(resolveAgentColor("debug", sources)).toBe("warning");
    expect(resolveAgentColor("build", sources)).toBe(CLAUDE_CODE_ORANGE);
  });

  test("matches host entries by name and ignores invalid colors", () => {
    expect(resolveAgentColor("Debugger", { overrides: {}, hosted: [{ id: "x", name: "Debugger", color: "error" }], builtin: {} })).toBe("error");
    expect(resolveAgentColor("plan", { overrides: { plan: "bogus" }, hosted: [], builtin: BUILTIN_AGENT_COLORS })).toBe("#6E9FFF");
    expect(resolveAgentColor("unknown", sources)).toBeUndefined();
    expect(resolveAgentColor(undefined, sources)).toBeUndefined();
  });
});

describe("settings", () => {
  test("ships a Claude-style spinner and semantic strategy defaults", () => {
    expect(SPINNER_FRAMES).toEqual(["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]);
    expect(SHIMMER_FRAME_MS).toBe(65);
    expect(DEFAULT_SETTINGS.strategy).toBe("semantic");
    expect(DEFAULT_SETTINGS.semanticMinIntervalMs).toBe(2500);
  });

  test("resolves a stale or partial record over the defaults", () => {
    expect(resolveSettings({ color: "accent" })).toEqual({ ...DEFAULT_SETTINGS, color: "accent" });
    expect(resolveSettings({ strategy: "tools" }).strategy).toBe("tools");
    expect(resolveSettings({ strategy: "unknown" as never }).strategy).toBe("semantic");
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  test("defaults the spinner and label to Claude Code orange", () => {
    expect(CLAUDE_CODE_ORANGE).toBe("#D97757");
    expect(DEFAULT_SETTINGS.color).toBe(CLAUDE_CODE_ORANGE);
    expect(DEFAULT_SETTINGS.spinnerColor).toBe(CLAUDE_CODE_ORANGE);
  });

  test("migrates records saved under the old theme-gray defaults", () => {
    expect(resolveSettings({ color: "subdued" }).color).toBe(CLAUDE_CODE_ORANGE);
    expect(resolveSettings({ spinnerColor: "accent" }).spinnerColor).toBe(CLAUDE_CODE_ORANGE);
    expect(resolveSettings({ color: "#123456" }).color).toBe("#123456");
  });

  test("follows agent mode colors by default with per-agent overrides", () => {
    expect(DEFAULT_SETTINGS.agentColor).toBe(true);
    expect(DEFAULT_SETTINGS.agentColors).toEqual({});
    expect(BUILTIN_AGENT_COLORS.build).toBe(CLAUDE_CODE_ORANGE);
    expect(BUILTIN_AGENT_COLORS.plan).toBe("#6E9FFF");
    expect(resolveSettings({ agentColors: { plan: "#112233" } }).agentColors).toEqual({ plan: "#112233" });
  });
});
