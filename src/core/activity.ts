// A bounded, redacted excerpt of what a turn has done since the last accepted
// summary.
//
// Ported from pi-working-vibes (itself modelled on dsh-working-activity-llm):
// every signal (the user request, a tool starting, a tool failing, the assistant's
// own output growing) becomes one indexed line, and a summarizer call carries only
// the lines that no accepted answer has consumed yet. Re-sending the same window is
// what makes a summarizer restate one idea in new words instead of reporting progress.

export type ActivityKind = "request" | "tool" | "failure" | "text";

export interface ActivityLine {
  readonly index: number;
  readonly kind: ActivityKind;
  readonly text: string;
}

/** Per-line cap. Long arguments are truncated, not dropped: the head is the signal. */
export const MAX_LINE_CHARS = 160;
/** Cap on the assistant-output tail carried in one excerpt. */
export const MAX_TEXT_TAIL_CHARS = 800;
/** Assistant output must grow by this much before it becomes a new activity line. */
export const TEXT_GROWTH_MIN_CHARS = 160;
/** Hard cap on the framed prompt handed to the model. */
export const MAX_EXCERPT_CHARS = 2400;
/** Cap on the user request carried in one excerpt. */
export const MAX_REQUEST_CHARS = 1200;

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // `Authorization: Bearer <token>`, `token: abc`, `PASSWORD=abc`
  [/((?:token|key|secret|password|passwd|pwd|authorization|api[-_]?key)\s*[:=]\s*)(?:\w+\s+)?\S+/gi, "$1<redacted>"],
  [/\bBearer\s+\S+/gi, "Bearer <redacted>"],
  [/\b(?:sk|ghp|gho|ghs|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g, "<redacted>"],
  // Long opaque strings: JWTs, base64 blobs, hex digests.
  [/\b[A-Za-z0-9_+/=-]{40,}\b/g, "<redacted>"],
];

/** Remove credential-shaped text before anything leaves the machine. */
export function redactSecrets(value: string): string {
  let text = value;
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/** Collapse to one line and cap the length. */
export function oneLine(value: string, max = MAX_LINE_CHARS): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Argument names worth carrying per OpenCode tool, most identifying first. Tools
 * absent from this map contribute their name alone.
 */
const SALIENT_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  read: ["filePath", "path"],
  write: ["filePath", "path"],
  edit: ["filePath", "path"],
  multiedit: ["filePath", "path"],
  ls: ["path"],
  list: ["path"],
  grep: ["pattern"],
  glob: ["pattern"],
  webfetch: ["url"],
  fetch: ["url"],
  websearch: ["query"],
  apply_patch: ["filePath", "path"],
  patch: ["filePath", "path"],
  task: ["description", "subagent_type"],
  todowrite: [],
  invalid: [],
};

/**
 * Shell tools across OpenCode builds. `exec`/`execute` are the names newer
 * builds use, so they must be covered by the same privacy rule as `bash`.
 */
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "execute"]);

/**
 * Arguments tried, in order, for a tool this build has never seen. Without this,
 * one new tool name silently degrades its line to the bare tool name and the
 * model has nothing to narrate. Deliberately excludes free-form bodies
 * (`command`, `script`, `content`, `args`) that routinely carry secrets.
 */
const GENERIC_SALIENT_ARGUMENTS: readonly string[] = [
  "description",
  "filePath",
  "path",
  "pattern",
  "query",
  "url",
  "name",
  "subagent_type",
];

function argumentText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")) {
    return value.join(" ");
  }
  return undefined;
}

/** One-line description of a tool call for the excerpt. */
export function describeToolCall(name: string, args: unknown): string {
  const record = isRecord(args) ? args : {};
  const lower = name.toLowerCase();

  // Shell commands routinely embed credentials, so only the model-written
  // description (OpenCode's `description` argument) is ever carried — never the
  // command itself. `exec`/`execute` are the same tool under newer names.
  if (SHELL_TOOLS.has(lower)) {
    const intent = record.description;
    const label = typeof intent === "string" ? oneLine(redactSecrets(intent), 100) : "";
    return label ? `${name} (${label})` : name;
  }

  const mapped = SALIENT_ARGUMENTS[name] ?? SALIENT_ARGUMENTS[lower];
  const keys = mapped ?? GENERIC_SALIENT_ARGUMENTS;
  const detail = keys
    .map((key) => argumentText(record, key))
    .find((value) => value && value.trim());

  if (!detail) return name;
  return `${name} ${oneLine(redactSecrets(detail), 120)}`;
}

export interface ToolActivity {
  readonly key: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: "running" | "completed" | "error";
}

interface ToolActivityMessage {
  readonly type: string;
  readonly content?: ReadonlyArray<unknown>;
}

interface ToolActivityCandidate extends ToolActivity {
  readonly order: number;
  readonly startedAt: number;
  readonly completedAt: number;
}

/** Read a finite tool timestamp, falling back to the message traversal order. */
function timeValue(part: Record<string, unknown>, key: string, fallback: number): number {
  const time = isRecord(part.time) ? part.time : {};
  const value = time[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Select the newest active tool, falling back to the most recently completed one. */
export function latestToolActivity(messages: ReadonlyArray<ToolActivityMessage>): ToolActivity | undefined {
  const candidates: ToolActivityCandidate[] = [];
  let order = 0;

  for (const message of messages) {
    if (message.type !== "assistant" || !message.content) continue;
    for (const value of message.content) {
      if (!isRecord(value) || value.type !== "tool" || typeof value.name !== "string") continue;
      const state = isRecord(value.state) ? value.state : undefined;
      const status = state?.status;
      if (status !== "running" && status !== "completed" && status !== "error") continue;
      const fallback = order;
      const id = typeof value.id === "string" ? value.id : `${value.name}:${fallback}`;
      candidates.push({
        key: `${id}:${status === "error" ? "error" : "tool"}`,
        name: value.name,
        input: state?.input,
        status,
        order,
        startedAt: timeValue(value, "ran", timeValue(value, "created", fallback)),
        completedAt: timeValue(value, "completed", timeValue(value, "created", fallback)),
      });
      order += 1;
    }
  }

  const active = candidates.filter((candidate) => candidate.status === "running");
  if (active.length > 0) {
    active.sort((left, right) => left.startedAt - right.startedAt || left.order - right.order);
    return active.at(-1);
  }

  const finished = candidates.filter((candidate) => candidate.status === "completed" || candidate.status === "error");
  finished.sort((left, right) => left.completedAt - right.completedAt || left.order - right.order);
  return finished.at(-1);
}

/**
 * Pending activity lines plus the pointer that lets an accepted answer consume
 * exactly the lines it was shown.
 */
export class ActivityBuffer {
  #lines: ActivityLine[] = [];
  #nextIndex = 0;
  #request = "";
  #textTail = "";
  #textTailReported = 0;

  get hasPending(): boolean {
    return this.#lines.length > 0;
  }

  get request(): string {
    return this.#request;
  }

  get pendingCount(): number {
    return this.#lines.length;
  }

  #push(kind: ActivityKind, text: string): void {
    const line = oneLine(redactSecrets(text));
    if (!line) return;
    // Collapse an immediate repeat of the same signal.
    const last = this.#lines.at(-1);
    if (last && last.kind === kind && last.text === line) return;
    this.#lines.push({ index: this.#nextIndex, kind, text: line });
    this.#nextIndex += 1;
  }

  recordRequest(prompt: string): void {
    // The request is carried as its own excerpt section on every call, so it is not
    // also an activity line; that would send it twice and consume the delta budget.
    this.#request = prompt.replace(/\s+/g, " ").trim().slice(0, MAX_REQUEST_CHARS);
    this.#textTail = "";
    this.#textTailReported = 0;
  }

  recordToolCall(name: string, args: unknown): void {
    this.#push("tool", describeToolCall(name, args));
  }

  recordFailure(name: string): void {
    this.#push("failure", `${name} failed`);
  }

  /**
   * Record the assistant's own output once it has grown enough to be worth a
   * line, keeping only the tail.
   */
  recordAssistantText(fullText: string): void {
    const collapsed = fullText.replace(/\s+/g, " ").trim();
    if (collapsed.length - this.#textTailReported < TEXT_GROWTH_MIN_CHARS) return;
    this.#textTailReported = collapsed.length;
    const tail = collapsed.slice(-MAX_TEXT_TAIL_CHARS);
    if (tail === this.#textTail) return;
    this.#textTail = tail;
    this.#push("text", `agent wrote: …${tail}`);
  }

  /** The lines no accepted answer has consumed yet. */
  takePending(): readonly ActivityLine[] {
    return this.#lines.slice();
  }

  /** Drop every line up to and including `index`; the answer covering them was accepted. */
  consumeThrough(index: number): void {
    this.#lines = this.#lines.filter((line) => line.index > index);
  }

  /** Drop everything pending without accepting it. */
  discardPending(): void {
    this.#lines = [];
  }

  reset(): void {
    this.#lines = [];
    this.#nextIndex = 0;
    this.#request = "";
    this.#textTail = "";
    this.#textTailReported = 0;
  }
}

/** Frame the delta plus prior context into the bounded prompt body. */
export function buildExcerpt(
  delta: readonly ActivityLine[],
  accepted: readonly string[],
  request: string,
  maxChars = MAX_EXCERPT_CHARS,
): string {
  const parts: string[] = [];
  if (request) parts.push(`User request:\n${request}`);
  if (delta.length > 0) parts.push(`Activity since the last update:\n${delta.map((line) => `- ${line.text}`).join("\n")}`);
  if (accepted.length > 0) parts.push(`Already shown:\n${accepted.map((line) => `- ${line}`).join("\n")}`);
  const excerpt = parts.join("\n\n");
  return excerpt.length <= maxChars ? excerpt : excerpt.slice(0, maxChars);
}
