// Local stand-in for @opencode-ai/plugin's identity `define` helper.
//
// The plugin's runtime module graph must stay free of @opencode-ai/*: opencode
// replaces those packages (and `effect`) with its own bundled copies at load time,
// so a locally pinned copy resolves its `effect` import against a different version
// than the host provides and dies at import — before any plugin code runs. Only the
// *type* is imported here, which TypeScript erases.
import type { Plugin } from "@opencode-ai/plugin/tui";

/** Returns the plugin definition unchanged, preserving its inferred literal type. */
export function define<P extends Plugin.Definition>(plugin: P): P {
  return plugin;
}
