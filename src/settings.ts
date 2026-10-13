// Pure working-vibes settings and animation constants. The runtime glue (OpenCode
// slots, storage, events) lives in tui.tsx.

/** Claude Code's brand orange, used for the spinner and label by default. */
export const CLAUDE_CODE_ORANGE = "#D97757";

/** Built-in spinner/label colors per agent mode; the host or user can override. */
export const BUILTIN_AGENT_COLORS: Record<string, string> = {
  build: CLAUDE_CODE_ORANGE,
  plan: "#6E9FFF",
};

// Claude Code's asterisk spinner, expanding then contracting, at 120ms.
export const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
export const SPINNER_INTERVAL_MS = 120;

// Pi's shimmer cadence and sweep geometry, expressed in TUI-renderer colors.
export const SHIMMER_FRAME_MS = 65;
export const SHIMMER_STEP = 1.5;
export const SHIMMER_START_OFFSET = 3;
export const SHIMMER_EXIT_OFFSET = 4;
export const SHIMMER_PAUSE_MS = 180;
export const SHIMMER_ACCENT_TRAIL = 2.5;
export const SHIMMER_DIM_TRAIL = 4.5;
export const SHIMMER_ACCENT_LEAD = 1.5;

export type GenerationStrategy = "semantic" | "tools";

export interface VibeSettings {
  /** Optional "providerID/modelID[:variant]" override; null uses the session model. */
  model: string | null;
  color: string;
  spinnerColor: string;
  /** Follow the session agent's mode color for spinner and label. */
  agentColor: boolean;
  /** Explicit per-agent color overrides, keyed by agent id. */
  agentColors: Record<string, string>;
  shimmer: boolean;
  /** Select broad activity narration or tool-focused narration. */
  strategy: GenerationStrategy;
  semanticMaxWords: number;
  semanticDebounceMs: number;
  semanticMaxWaitMs: number;
  semanticMinIntervalMs: number;
  semanticTimeoutMs: number;
}

export const DEFAULT_SETTINGS: VibeSettings = {
  model: null,
  color: CLAUDE_CODE_ORANGE,
  spinnerColor: CLAUDE_CODE_ORANGE,
  agentColor: true,
  agentColors: {},
  shimmer: true,
  strategy: "semantic",
  semanticMaxWords: 12,
  semanticDebounceMs: 1500,
  semanticMaxWaitMs: 2500,
  semanticMinIntervalMs: 2500,
  semanticTimeoutMs: 6000,
};

/**
 * Merge a persisted record over the defaults, so a partial or stale record still works.
 * Records saved when the defaults were theme grays ("subdued"/"accent") migrate to the
 * Claude Code orange unless the user explicitly picked another color since.
 */
export function resolveSettings(stored: Partial<VibeSettings> | undefined): VibeSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  if (merged.color === "subdued") merged.color = DEFAULT_SETTINGS.color;
  if (merged.spinnerColor === "accent") merged.spinnerColor = DEFAULT_SETTINGS.spinnerColor;
  return { ...merged, strategy: merged.strategy === "tools" ? "tools" : "semantic" };
}
