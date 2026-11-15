// Ambient types for the desktop GUI bundle contract.
//
// `@opencode/plugin/gui` is not published: the desktop app supplies it to the bundle
// at load time through its own `require`, exactly like the TUI's runtime packages.
// Only the parts this plugin touches are declared here, plus the handful of DOM
// members the chip paints — the project has no DOM lib, so the TUI stays untouched.
declare module "@opencode/plugin/gui" {
  export interface SessionSource {
    readonly id?: string;
    readonly server: {
      readonly data: {
        readonly session: {
          readonly message: { readonly list: (id: string) => ReadonlyArray<unknown> };
        };
      };
    };
  }

  export interface SetupContext {
    readonly id: string;
    readonly options: unknown;
    readonly client: unknown;
    readonly signal: AbortSignal;
    readonly sessions: { readonly current: () => SessionSource | undefined };
    add<T>(registry: unknown, item: T | (() => T | undefined)): void;
  }

  export const Slot: unknown;

  // `define` is identity at runtime; a bundle may default-export its declarations directly.
}

/** The DOM surface the chip touches. */
interface ChipElement {
  id: string;
  className: string;
  textContent: string | null;
  readonly dataset: Record<string, string>;
  readonly style: Record<string, string>;
  readonly parentElement: ChipElement | null;
  readonly isConnected: boolean;
  append(...nodes: ChipElement[]): void;
  setAttribute(name: string, value: string): void;
  insertBefore(node: ChipElement, anchor: ChipElement): void;
  getBoundingClientRect(): { readonly width: number };
}

declare const document: {
  getElementById(id: string): ChipElement | null;
  querySelector(selector: string): ChipElement | null;
  createElement(tag: string): ChipElement;
  readonly body: ChipElement;
  readonly head: { append(node: ChipElement): void };
};

declare class MutationObserver {
  constructor(callback: () => void);
  observe(target: ChipElement, options: { childList: true; subtree: true }): void;
  disconnect(): void;
}
