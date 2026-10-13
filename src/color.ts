// Maps vibe color names to OpenCode TUI theme tokens and drives the shimmer sweep.
//
// OpenCode 2.0.26 exposes `themes.currentTokens()` through context.theme. Runtime
// text colors use `base`/`muted` and feedback `base` tokens; the pinned beta's
// declarations use different names, so map the shape the host actually supplies.
import type { RGBA } from "@opentui/core";
import {
  SHIMMER_ACCENT_LEAD,
  SHIMMER_ACCENT_TRAIL,
  SHIMMER_DIM_TRAIL,
  SHIMMER_START_OFFSET,
} from "./settings.js";

export type ThemeColor = RGBA | string;

/** Structural view of the OpenCode theme tokens this plugin reads. */
export interface ThemeLike {
  readonly text?: {
    readonly base?: ThemeColor
    readonly muted?: ThemeColor
    readonly action?: {
      readonly primary?: { readonly base?: ThemeColor }
    }
    readonly feedback?: {
      readonly error?: { readonly base?: ThemeColor }
      readonly warning?: { readonly base?: ThemeColor }
      readonly success?: { readonly base?: ThemeColor }
      readonly info?: { readonly base?: ThemeColor }
    }
  }
}

export type VibeColor =
  | "text"
  | "subdued"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "rainbow"
  | `#${string}`

// pi's rainbow palette, kept verbatim including its wrap-around entry.
const RAINBOW_COLORS = ["#b281d6", "#d787af", "#febc38", "#e4c00f", "#89d281", "#00afaf", "#178fb9", "#b281d6"];

const COLOR_NAMES = new Set(["text", "subdued", "accent", "success", "warning", "error", "rainbow"]);

/** True when a string is a supported vibe color name or six-digit hex value. */
export function isVibeColor(value: string): value is VibeColor {
  return COLOR_NAMES.has(value) || /^#[0-9a-f]{6}$/i.test(value);
}

/** Deterministic rainbow color for a character position. */
export function rainbowColorAt(index: number): string {
  const length = RAINBOW_COLORS.length;
  return RAINBOW_COLORS[((index % length) + length) % length];
}

/**
 * Rainbow color for one visible character; whitespace and colons remain uncolored.
 */
export function rainbowColorForCharacter(text: string, index: number): string | undefined {
  const characters = Array.from(text);
  if (/[\s:]/.test(characters[index] ?? "")) return undefined;

  let colored = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (!/[\s:]/.test(characters[cursor] ?? "")) colored += 1;
  }
  return rainbowColorAt(colored);
}

/** Read a theme token without ever throwing (tokens may be missing at runtime). */
function safeRead<T extends ThemeColor>(read: () => T | undefined): T | undefined {
  try {
    return read() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the active theme's primary action color. */
function accentColor(theme: ThemeLike): ThemeColor | undefined {
  return safeRead(() => theme.text?.action?.primary?.base);
}

/** Resolve a color name using the tokens exposed by the running OpenCode host. */
export function resolveColor(theme: ThemeLike, color: VibeColor | undefined, fallback?: ThemeColor): ThemeColor | undefined {
  const muted = safeRead(() => theme.text?.muted);
  if (!color || color === "rainbow") return fallback ?? muted;
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  switch (color) {
    case "accent":
      return accentColor(theme) ?? safeRead(() => theme.text?.base) ?? muted;
    case "success":
      return safeRead(() => theme.text?.feedback?.success?.base) ?? muted;
    case "warning":
      return safeRead(() => theme.text?.feedback?.warning?.base) ?? muted;
    case "error":
      return safeRead(() => theme.text?.feedback?.error?.base) ?? muted;
    case "subdued":
      return muted;
    case "text":
    default:
      return safeRead(() => theme.text?.base) ?? muted;
  }
}

export type ShimmerBand = "highlight" | "accent" | "dim" | "base";

/** Classify one character's shimmer band for the given animation phase. */
export function shimmerBand(index: number, phase: number): ShimmerBand {
  const center = phase - SHIMMER_START_OFFSET;
  const offset = index - center;
  if (Math.abs(offset) <= 0.5) return "highlight";
  if (offset >= -SHIMMER_ACCENT_TRAIL && offset <= SHIMMER_ACCENT_LEAD) return "accent";
  if (offset < -SHIMMER_ACCENT_TRAIL && offset >= -SHIMMER_DIM_TRAIL) return "dim";
  return "base";
}

/** Resolve the concrete color for a shimmer band, falling back to the base color. */
export function bandColor(theme: ThemeLike, base: ThemeColor | undefined, band: ShimmerBand): ThemeColor | undefined {
  if (band === "highlight") return safeRead(() => theme.text?.base) ?? base;
  if (band === "accent") return accentColor(theme) ?? base;
  if (band === "dim") return safeRead(() => theme.text?.muted) ?? base;
  return base;
}
