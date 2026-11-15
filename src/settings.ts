// Pure working-vibes settings and animation constants. The runtime glue (OpenCode
// slots, storage, events) lives in tui.tsx.

/**
 * The old pre-theme default (Claude Code's brand orange). Nothing paints it any more;
 * it survives only so a record written under the old defaults is recognisable and can
 * be moved onto the active theme's tokens.
 */
const LEGACY_ORANGE = "#D97757";

/**
 * Built-in spinner/label colors per agent mode, as theme token names rather than brand
 * hexes, so the chip matches whatever theme is active. The theme exposes a single accent
 * token, so these two cannot differ; to tell agent modes apart use a color defined in
 * `opencode.json`, or a `/vibe agent-color <agent> <color>` override.
 */
export const BUILTIN_AGENT_COLORS: Record<string, string> = {
  build: "accent",
  plan: "accent",
};

/**
 * Uniform-weight braille frames at 120ms. Braille is the conventional CLI spinner set, so
 * monospace fonts ship it far more often than they ship the Dingbats asterisks it replaces.
 * Every frame is a single codepoint with no emoji presentation and the same shape as its
 * neighbours, so the spinner neither shifts size mid-sweep nor hands a frame to a substitute
 * font that renders it at another width and ignores the configured color.
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
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

/**
 * Current settings schema. Records written before this version predate the per-tool
 * default and are migrated once to it, keeping an explicit later choice intact.
 */
export const SETTINGS_VERSION = 2;

export interface VibeSettings {
  /** Schema version of the persisted record, used to migrate old defaults once. */
  settingsVersion: number;
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
  /**
   * Settle window for the opening line of a turn. Short by design: it buys the
   * difference between an immediate restatement of the prompt and a line that
   * describes the first real action. See CadenceConfig.firstDispatchMs.
   */
  semanticFirstDispatchMs: number;
  /**
   * Steady-state cadence for every line after the opening one: settle on a quiet
   * period this long, cap a continuously streaming turn at `semanticMaxWaitMs`, and
   * keep `semanticMinIntervalMs` as the floor between calls. The cap is what a live
   * turn actually rides, so it sets how often the chip can visibly change.
   */
  semanticDebounceMs: number;
  semanticMaxWaitMs: number;
  semanticMinIntervalMs: number;
  semanticTimeoutMs: number;
}

export const DEFAULT_SETTINGS: VibeSettings = {
  settingsVersion: SETTINGS_VERSION,
  model: null,
  color: "subdued",
  spinnerColor: "accent",
  agentColor: false,
  agentColors: {},
  shimmer: true,
  strategy: "tools",
  semanticMaxWords: 12,
  semanticFirstDispatchMs: 400,
  semanticDebounceMs: 900,
  semanticMaxWaitMs: 1400,
  semanticMinIntervalMs: 1400,
  semanticTimeoutMs: 6000,
};

/**
 * Merge a persisted record over the defaults, so a partial or stale record still works.
 * A record still carrying the old brand orange in both color slots, with agent following
 * on, is adopted onto the theme tokens; anything else is a deliberate choice and is left
 * exactly as saved.
 */
export function resolveSettings(stored: Partial<VibeSettings> | undefined): VibeSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };

  // Records written before settingsVersion existed carry the old semantic default; adopt the
  // per-tool default once, then let an explicit choice made afterwards persist as saved.
  if ((stored?.settingsVersion ?? 0) < SETTINGS_VERSION) {
    merged.strategy = "tools";
    merged.settingsVersion = SETTINGS_VERSION;
  }

  if (merged.color === LEGACY_ORANGE && merged.spinnerColor === LEGACY_ORANGE && merged.agentColor === true) {
    merged.color = DEFAULT_SETTINGS.color;
    merged.spinnerColor = DEFAULT_SETTINGS.spinnerColor;
    merged.agentColor = DEFAULT_SETTINGS.agentColor;
  }
  return { ...merged, strategy: merged.strategy === "semantic" ? "semantic" : "tools" };
}
