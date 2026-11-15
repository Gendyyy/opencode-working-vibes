// Text-generation client for the semantic activity layer. Kept free of TUI/Solid
// imports so the request shaping and fallbacks can be unit-tested.
//
// The runtime's `client.generate.text` posts to `/api/experimental/generate` and
// resolves `{ data: { text } }`. The scan below tolerates the other shapes a
// different build may expose, so the transport never silently disappears.

export interface ModelRef {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

/** Parse a "providerID/modelID[#variant]" spec into a model ref. A trailing
 * ":variant" is accepted too, for backward compatibility. */
export function parseModel(spec: string | null): ModelRef | undefined {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0) return undefined;
  const providerID = spec.slice(0, slash);
  const rest = spec.slice(slash + 1);
  // Canonical OpenCode form uses "#variant" (see Model.Ref); ":" is legacy.
  const hash = rest.lastIndexOf("#");
  const colon = rest.lastIndexOf(":");
  const cut = hash > 0 ? hash : colon > 0 ? colon : -1;
  if (cut > 0) {
    const variant = rest.slice(cut + 1);
    if (variant && /^[a-z0-9_-]+$/i.test(variant)) return { providerID, id: rest.slice(0, cut), variant };
  }
  return { providerID, id: rest };
}

type GenerateGroup = { text?: (value: unknown, requestOptions?: unknown) => Promise<unknown> };

export interface GenerateTextOptions {
  readonly prompt: string;
  readonly model?: ModelRef;
  readonly signal?: AbortSignal;
}

/**
 * Call the server's text-generation endpoint across client shapes.
 * The runtime exposes `generate.text` (→ /api/experimental/generate); older and
 * experimental builds may nest it differently. The response is `{ text }` or
 * `{ data: { text } }`.
 */
export async function generateText(client: unknown, input: GenerateTextOptions): Promise<string> {
  const anyClient = client as {
    generate?: GenerateGroup | ((value: unknown, requestOptions?: unknown) => Promise<unknown>);
    generateText?: (value: unknown, requestOptions?: unknown) => Promise<unknown>;
    experimental?: {
      generate?: GenerateGroup | ((value: unknown, requestOptions?: unknown) => Promise<unknown>);
      generateText?: (value: unknown, requestOptions?: unknown) => Promise<unknown>;
    };
  };

  const candidates: Array<(value: unknown, requestOptions?: unknown) => Promise<unknown>> = [];
  const addGroup = (group: GenerateGroup | ((value: unknown, requestOptions?: unknown) => Promise<unknown>) | undefined) => {
    if (!group) return;
    if (typeof (group as GenerateGroup).text === "function") {
      candidates.push((group as GenerateGroup).text!.bind(group));
    }
    if (typeof group === "function") candidates.push(group as (value: unknown, requestOptions?: unknown) => Promise<unknown>);
  };
  addGroup(anyClient.experimental?.generate);
  addGroup(anyClient.generate);
  if (typeof anyClient.experimental?.generateText === "function") {
    candidates.push(anyClient.experimental.generateText.bind(anyClient.experimental));
  }
  if (typeof anyClient.generateText === "function") candidates.push(anyClient.generateText.bind(anyClient));

  const payload: { prompt: string; model?: ModelRef } = input.model
    ? { prompt: input.prompt, model: input.model }
    : { prompt: input.prompt };
  const requestOptions = input.signal ? { signal: input.signal } : undefined;

  let lastError: unknown;
  for (const call of candidates) {
    try {
      const result = (await call(payload, requestOptions)) as { text?: string; data?: { text?: string } } | undefined;
      const text = result?.text ?? result?.data?.text ?? "";
      if (text) return text;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error("generate.text is unavailable");
}
