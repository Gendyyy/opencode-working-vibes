// Server-side entrypoint: a no-op plugin so the package loads in both the
// server and the TUI. All working-vibes behavior lives in the TUI entry (./tui).
// No runtime @opencode-ai/* import: the host supplies those modules in-process
// (see src/define.ts). Only the local identity helper is needed here.
import { define } from "./define.js";

export default define({
  id: "working-vibes",
  tui: true,
  setup() {},
});
