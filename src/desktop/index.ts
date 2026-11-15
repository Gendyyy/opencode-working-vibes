// The desktop part: the working-vibes chip in the window's bottom strip.
//
// The host assigns this plugin's id from the server part, so this file declares none.
// The bundle default-exports the declarations directly — `Plugin.define` is the same
// object with types attached, and the host only checks the shape.
import { createMemo } from "solid-js";
import { Slot, type SetupContext } from "@opencode/plugin/gui";
import { chipView, createChip } from "./chip.js";
import { createWorkingLine } from "./line.js";

export default {
  setup(ctx: SetupContext) {
    const line = createWorkingLine(() => ctx.sessions.current(), () => ctx.client);
    const view = createMemo(() => chipView(line()));

    ctx.add(Slot, { at: "window.bottom", render: () => createChip(view) });
  },
};
