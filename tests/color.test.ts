// Unit tests for OpenCode theme color mapping, the shimmer sweep, and settings resolution.
import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";

import { bandColor, isVibeColor, rainbowColorAt, rainbowColorForCharacter, resolveAgentColor, resolveColor, shimmerBand, type ThemeLike } from "../src/color.js";
import { BUILTIN_AGENT_COLORS, DEFAULT_SETTINGS, resolveSettings, SETTINGS_VERSION, SHIMMER_FRAME_MS, SPINNER_FRAMES } from "../src/settings.js";

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
    expect(resolveAgentColor("build", sources)).toBe("accent");
  });

  test("matches host entries by name and ignores invalid colors", () => {
    expect(resolveAgentColor("Debugger", { overrides: {}, hosted: [{ id: "x", name: "Debugger", color: "error" }], builtin: {} })).toBe("error");
    expect(resolveAgentColor("plan", { overrides: { plan: "bogus" }, hosted: [], builtin: BUILTIN_AGENT_COLORS })).toBe("accent");
    expect(resolveAgentColor("unknown", sources)).toBeUndefined();
    expect(resolveAgentColor(undefined, sources)).toBeUndefined();
  });
});

describe("settings", () => {
  test("ships a uniform-weight braille spinner and per-tool strategy defaults", () => {
    expect(SPINNER_FRAMES).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
    expect(SHIMMER_FRAME_MS).toBe(65);
    expect(DEFAULT_SETTINGS.strategy).toBe("tools");
    expect(DEFAULT_SETTINGS.settingsVersion).toBe(SETTINGS_VERSION);
    expect(DEFAULT_SETTINGS.semanticMinIntervalMs).toBe(1400);
  });

  test("the steady-state cadence updates a little faster than it settles", () => {
    // The chip should visibly move during a long turn: the burst cap that paces a
    // continuously streaming turn must stay under the settle window a quiet turn uses,
    // and the opening settle must be the shortest of the three.
    expect(DEFAULT_SETTINGS.semanticFirstDispatchMs).toBeLessThan(DEFAULT_SETTINGS.semanticMaxWaitMs);
    expect(DEFAULT_SETTINGS.semanticDebounceMs).toBeLessThan(DEFAULT_SETTINGS.semanticMaxWaitMs);
    expect(DEFAULT_SETTINGS.semanticMinIntervalMs).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.semanticMaxWaitMs);
  });

  test("keeps every spinner frame one non-emoji cell wide", () => {
    // The bug this guards: Dingbats frames are missing from many terminal monospace
    // fonts, so the terminal falls back per glyph and renders uneven widths that ignore
    // the configured color. Each frame must be one codepoint, never emoji, and all
    // frames must agree on width so the spinner cannot shift size mid-sweep.
    for (const frame of SPINNER_FRAMES) {
      expect([...frame]).toHaveLength(1);
      expect(/\p{Extended_Pictographic}/u.test(frame)).toBe(false);
    }
    expect(new Set(SPINNER_FRAMES.map((frame) => [...frame].length))).toEqual(new Set([1]));
  });

  test("resolves a stale or partial record over the defaults", () => {
    expect(resolveSettings({ color: "accent" })).toEqual({ ...DEFAULT_SETTINGS, color: "accent" });
    expect(resolveSettings({ strategy: "tools" }).strategy).toBe("tools");
    expect(resolveSettings({ strategy: "unknown" as never }).strategy).toBe("tools");
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  test("migrates a record written before the settings version to per-tool narration", () => {
    const resolved = resolveSettings({ strategy: "semantic", color: "accent" });

    expect(resolved.strategy).toBe("tools");
    expect(resolved.settingsVersion).toBe(SETTINGS_VERSION);
    expect(resolved.color).toBe("accent");
  });

  test("keeps an explicit strategy chosen after the migration", () => {
    const resolved = resolveSettings({ strategy: "semantic", settingsVersion: SETTINGS_VERSION });

    expect(resolved.strategy).toBe("semantic");
  });

  test("defaults the spinner and label to the active theme's tokens", () => {
    expect(DEFAULT_SETTINGS.spinnerColor).toBe("accent");
    expect(DEFAULT_SETTINGS.color).toBe("subdued");
    expect(DEFAULT_SETTINGS.agentColor).toBe(false);
  });

  test("adopts theme tokens over a record left on the old brand defaults", () => {
    const legacy = { color: "#D97757", spinnerColor: "#D97757", agentColor: true };
    expect(resolveSettings(legacy)).toMatchObject({
      color: DEFAULT_SETTINGS.color,
      spinnerColor: DEFAULT_SETTINGS.spinnerColor,
      agentColor: DEFAULT_SETTINGS.agentColor,
    });
  });

  test("leaves a deliberate color choice exactly as saved", () => {
    expect(resolveSettings({ color: "#123456" }).color).toBe("#123456");
    expect(resolveSettings({ color: "accent" }).color).toBe("accent");
    expect(resolveSettings({ color: "subdued" }).color).toBe("subdued");
    // Orange in one slot only means the user picked it on purpose; do not rewrite it.
    expect(resolveSettings({ color: "#D97757" }).color).toBe("#D97757");
  });

  test("keeps agent color following off by default, with per-agent overrides available", () => {
    expect(DEFAULT_SETTINGS.agentColor).toBe(false);
    expect(DEFAULT_SETTINGS.agentColors).toEqual({});
    expect(BUILTIN_AGENT_COLORS).toEqual({ build: "accent", plan: "accent" });
    expect(resolveSettings({ agentColors: { plan: "#112233" } }).agentColors).toEqual({ plan: "#112233" });
  });

  test("paints a legacy record in the active theme's colors (record -> tokens -> theme)", () => {
    // The full path the chip takes: a record saved under the old brand defaults resolves
    // to theme token names, and those tokens then resolve against the live theme. This is
    // the regression the user hit — a stored record that kept painting fixed orange.
    const settings = resolveSettings({ color: "#D97757", spinnerColor: "#D97757", agentColor: true });
    const spinner = isVibeColor(settings.spinnerColor) ? settings.spinnerColor : undefined;
    const label = isVibeColor(settings.color) ? settings.color : undefined;
    expect(resolveColor(theme, spinner)).toBe("#00aaff");
    expect(resolveColor(theme, label)).toBe("#888888");
  });
});
