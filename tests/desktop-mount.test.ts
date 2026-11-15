// Mounts the desktop part the way the host does: `setup` with a context, then the
// slot's `render`. `@opencode/plugin/gui` is not on npm — the app supplies it — so the
// test stands in for it, and for the handful of DOM members the chip paints.
import { describe, expect, mock, test } from "bun:test";
import { createRoot } from "solid-js";

mock.module("@opencode/plugin/gui", () => ({ Slot: { id: "slot" } }));

interface Stub {
  className: string;
  id: string;
  textContent: string | null;
  dataset: Record<string, string>;
  style: Record<string, string>;
  children: Stub[];
  append(...nodes: Stub[]): void;
  setAttribute(name: string, value: string): void;
  find(className: string): Stub | undefined;
}

function element(tag = "div"): Stub {
  const node: Stub = {
    className: "",
    id: "",
    textContent: null,
    dataset: {},
    style: {},
    children: [],
    append(...nodes) {
      node.children.push(...nodes);
    },
    setAttribute() {},
    find(className) {
      if (node.className === className) return node;
      for (const child of node.children) {
        const hit = child.find(className);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  void tag;
  return node;
}

const head = element("head");
const body = element("body");
(globalThis as Record<string, unknown>).document = {
  getElementById: () => null,
  querySelector: () => null,
  createElement: (tag: string) => element(tag),
  body,
  head,
};
(globalThis as Record<string, unknown>).MutationObserver = class {
  constructor(_callback: () => void) {}
  observe() {}
  disconnect() {}
};

const { default: plugin } = await import("../src/desktop/index.js");

const user = { type: "user", text: "fix the scroll" };
const assistant = {
  type: "assistant",
  model: { providerID: "p", id: "m" },
  content: [{ type: "tool", name: "read", state: { status: "running", input: { filePath: "src/routes/session.tsx" } } }],
};

function mount(messages: unknown[]) {
  const items: Array<{ at: string; render: (input: unknown) => Stub }> = [];
  const session = { id: "ses_1", server: { data: { session: { message: { list: () => messages } } } } };
  const client = { generate: { text: async () => ({ text: "Tracing the scroll" }) } };
  const ctx = {
    id: "working-vibes",
    options: {},
    client,
    signal: new AbortController().signal,
    sessions: { current: () => session },
    add: (_registry: unknown, item: { at: string; render: (input: unknown) => Stub }) => items.push(item),
  };

  let chip: Stub | undefined;
  const dispose = createRoot((dispose) => {
    plugin.setup(ctx as never);
    chip = items[0]?.render({});
    return dispose;
  });

  return { items, chip, dispose };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("desktop part", () => {
  test("claims the window.bottom strip and paints a 34px chip", async () => {
    const { items, chip, dispose } = mount([user, assistant]);
    await settle();

    expect(items).toHaveLength(1);
    expect(items[0]?.at).toBe("window.bottom");
    expect(chip?.className).toBe("wv-dock");
    expect(chip?.find("wv-chip")?.dataset.state).toBe("working");
    expect(chip?.find("wv-chip")?.dataset.visible).toBe("true");
    expect(head.children).toHaveLength(1);

    dispose();
  });

  test("the model's line lands in the label", async () => {
    const { chip, dispose } = mount([user, assistant]);

    await settle();

    expect(chip?.find("wv-lbl")?.textContent).toBe("Tracing the scroll");
    expect(chip?.find("wv-tool")?.children[0]?.textContent).toBe("read src/routes/session.tsx");

    dispose();
  });

  test("a settled turn hides the strip", async () => {
    const { chip, dispose } = mount([user, assistant, { type: "idle", outcome: "succeeded" }]);
    await settle();

    expect(chip?.find("wv-chip")?.dataset.visible).toBe("false");
    expect(chip?.find("wv-chip")?.dataset.state).toBe("idle");

    dispose();
  });

  test("an interrupted turn keeps the strip without a spinner", async () => {
    const { chip, dispose } = mount([user, assistant, { type: "idle", outcome: "interrupted" }]);
    await settle();
    const arc = chip?.find("wv-arc");

    expect(chip?.find("wv-chip")?.dataset.state).toBe("interrupted");
    expect(arc?.style.animationPlayState).toBe("paused");

    dispose();
  });
});
