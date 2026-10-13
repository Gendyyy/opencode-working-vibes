// Server-side entrypoint: a no-op plugin so the package loads in both the
// server and the TUI. All working-vibes behavior lives in the TUI entry (./tui).
import { Plugin } from "@opencode-ai/plugin";

export default Plugin.define({
  id: "working-vibes",
  tui: true,
  setup() {},
});
