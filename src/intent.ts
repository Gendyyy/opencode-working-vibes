// Reads the current user request out of OpenCode's message list. That request is the
// first activity line the semantic layer summarises. Nothing in this module paints the
// chip: pi's rule is that the semantic layer is the only writer of the working line.

/** The slice of an OpenCode chat message this module reads. */
export interface MessageLike {
  readonly type: string;
  readonly content?: ReadonlyArray<unknown>;
  readonly text?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Return the text of the most recent user message, used to seed the summarizer. */
export function latestUserText(messages: ReadonlyArray<MessageLike>): string | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.type === "user") return asString(message.text);
  }
  return undefined;
}
