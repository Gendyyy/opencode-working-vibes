// Pure policy for the semantic activity layer: when to call the model, what to ask
// it, and whether its answer is worth painting.
//
// Ported verbatim from pi-working-vibes (itself modelled on dsh-working-activity-llm's
// SemanticActivityClassifier), which established three rules:
//   1. a call carries a delta, never the whole window;
//   2. a cadence — quiet-period debounce, burst cap, floor between calls, one
//      in-flight call at a time;
//   3. a reworded answer is withheld, not repainted.
//
// Everything here is pure and clock-injected so the policy is testable without a
// provider; the transport lives in the driver.

import type { ActivityLine } from "./activity.js";

export interface CadenceConfig {
  /** Quiet period after the last activity signal before a call is dispatched. */
  readonly debounceMs: number;
  /** Ceiling on that quiet period, measured from the start of a burst. */
  readonly maxWaitMs: number;
  /** Hard floor between two calls, however busy the turn is. The cost knob. */
  readonly minIntervalMs: number;
}

export interface CadenceState {
  burstStart: number | null;
  lastActivity: number | null;
  lastDispatch: number;
  inFlight: boolean;
}

export type CadenceAction = "idle" | "wait" | "dispatch";

export function createCadence(): CadenceState {
  return { burstStart: null, lastActivity: null, lastDispatch: Number.NEGATIVE_INFINITY, inFlight: false };
}

/** Record new activity. `lastDispatch` survives, so the floor still applies. */
export function markActivity(state: CadenceState, now: number): void {
  state.burstStart ??= now;
  state.lastActivity = now;
}

/** Decide what the driver should do right now. */
export function cadenceTick(
  state: CadenceState,
  now: number,
  config: CadenceConfig,
  hasPending: boolean,
): CadenceAction {
  if (state.inFlight) return "wait";
  if (!hasPending || state.lastActivity === null) return "idle";

  const quiet = now - state.lastActivity >= config.debounceMs;
  const burstExpired = state.burstStart !== null && now - state.burstStart >= config.maxWaitMs;
  if (!quiet && !burstExpired) return "wait";
  if (now - state.lastDispatch < config.minIntervalMs) return "wait";
  return "dispatch";
}

export function beginDispatch(state: CadenceState, now: number): void {
  state.inFlight = true;
  state.lastDispatch = now;
}

/** Close a call. A new burst starts fresh so the next quiet period is measured anew. */
export function endDispatch(state: CadenceState): void {
  state.inFlight = false;
  state.burstStart = null;
  state.lastActivity = null;
}

export function cadenceReset(state: CadenceState): void {
  state.burstStart = null;
  state.lastActivity = null;
  state.inFlight = false;
}

/** How long the driver may sleep before the next tick could dispatch. */
export const TICK_MS = 250;

export const SUMMARY_SYSTEM_PROMPT = [
  "You label what a coding agent is doing right now, for a one-line status display.",
  "",
  "Rules:",
  "- State the OPERATION INTENT: what the agent is trying to achieve, not a file inventory.",
  '- Good: "Fixing spinner colors". Bad: "Updating interface elements". Bad: "Editing tui.tsx".',
  "- The file name alone is never the point; the purpose behind touching it is.",
  "- Be brief. Most lines are 3 to 8 words.",
  "- {maxWords} words is the hard ceiling, not a target. Never pad a line to reach it.",
  "- One line only. No quotes, no markdown, no code fences, no trailing punctuation.",
  "- Describe what is happening right now, not the mechanics of how tools work.",
  "- Start with a present participle: Investigating, Fixing, Refactoring, Verifying, Adding, Reviewing.",
  "- Use the same language as the user's request.",
  "- If the activity contains nothing new worth reporting, reply with exactly: SKIP",
].join("\n");

export function buildSummaryPrompt(excerpt: string, maxWords: number): string {
  return [
    `Reply in as few words as possible. Short beats complete.`,
    `Hard ceiling: ${maxWords} words, and only when the idea genuinely needs it.`,
    "",
    SUMMARY_SYSTEM_PROMPT.replace("{maxWords}", String(maxWords)),
    "",
    excerpt,
  ].join("\n");
}

/** Ask the model for a concise status grounded only in the latest tool activity. */
export function buildToolSummaryPrompt(excerpt: string, maxWords: number): string {
  const systemPrompt = [
    "You narrate a coding agent's live tool activity as one-line status updates.",
    "",
    "Rules:",
    "- State the OPERATION INTENT of the latest tool call: what the agent is trying to achieve right now.",
    '- Good: "Verifying the spinner fix compiles". Bad: "Updating a TypeScript file". Bad: "Editing tui.tsx".',
    "- The file name alone is never the point; the purpose behind touching it is.",
    "- Name the feature or area when it clarifies intent: Fixing spinner colors, Checking test results.",
    "- Every tool call gets a status line. Never judge whether an action is useful enough to mention.",
    "- Never claim a result that is not present in the activity.",
    "- Start with a present participle such as Verifying, Fixing, Checking, Searching, or Refactoring.",
    "- One line only, no quotes, markdown, or trailing punctuation.",
    "- Always write a status line. Never reply SKIP and never explain yourself.",
  ].join("\n");

  return [
    "Write the shortest useful status line.",
    `Hard ceiling: ${maxWords} words.`,
    "",
    systemPrompt,
    "",
    excerpt,
  ].join("\n");
}

export type SanitizeResult =
  | { readonly kind: "summary"; readonly text: string }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "reject"; readonly reason: string };

/** Absolute guard on a single word, so one pathological token cannot smear the row. */
const MAX_WORD_CHARS = 24;

/** Words a status line should never open with. */
const BANNED_FIRST_WORDS = new Set(["i", "the", "this", "it", "here", "sure", "okay", "ok", "assistant", "agent"]);
/** Prepositions/conjunctions that mean the line was cut off. */
const DANGLING_LAST_WORDS = new Set([
  "with", "for", "to", "in", "on", "of", "and", "or", "the", "a", "an", "by", "from", "at", "into", "as", "that",
  // Auxiliaries and connectives leave a clause unfinished, so a word-capped line
  // must not end on one.
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "does", "do", "did",
  "will", "would", "can", "could", "should", "may", "might", "must", "when", "while", "which", "because", "if",
]);

function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** A duplicate ignores case, punctuation and spacing. */
export function isNearDuplicate(a: string, b: string): boolean {
  const left = normalizeForComparison(a);
  const right = normalizeForComparison(b);
  if (!left || !right) return false;
  return left === right;
}

/**
 * Turn a raw model reply into a line worth showing.
 *
 * The one-line contract is enforced here rather than by the request, because
 * `stop` sequences are not supported by every adapter.
 */
export function sanitizeSummary(raw: string, maxWords: number): SanitizeResult {
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    // A reply that opens with a code fence is common; the phrase is on the next line.
    .filter((line) => line.length > 0 && !/^```/.test(line))
    .find((line) => line.length > 0);
  if (!firstLine) return { kind: "reject", reason: "empty" };

  if (/^skip\b/i.test(firstLine)) return { kind: "skip", reason: "model-skip" };

  let text = firstLine
    .replace(/^```[a-z]*/i, "")
    .replace(/```/g, "")
    .replace(/^[#>*\-–—•\d.)\s]+/, "")
    .replace(/[*_`]/g, "")
    .replace(/^["'“”]|["'“”]$/g, "")
    .trim();

  // Paths and versions are the mechanics, not the purpose.
  text = text
    .replace(/(?:^|\s)(?:[~/][\w@./-]+|\.{0,2}\/[\w@./-]+)/g, " ")
    .replace(/\b[\w-]+\.[a-z]{1,4}\b/gi, " ")
    .replace(/\bv?\d+(?:\.\d+)+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = text.replace(/[.!?,;:…]+$/g, "").trim();
  if (!text) return { kind: "reject", reason: "empty-after-cleanup" };

  const words = text.split(" ");
  if (BANNED_FIRST_WORDS.has(words[0]!.toLowerCase())) return { kind: "reject", reason: "banned-first-word" };

  // The word budget is the model's job, not the sanitizer's: cutting text mid-idea
  // produces a worse line than waiting for a compliant answer. An over-long reply is
  // dropped, and the driver keeps its activity pending so the next call sees it again.
  if (words.length > maxWords) return { kind: "reject", reason: "too-many-words" };
  if (DANGLING_LAST_WORDS.has(words.at(-1)!.toLowerCase())) return { kind: "reject", reason: "dangling-tail" };
  if (words.some((word) => word.length > MAX_WORD_CHARS)) return { kind: "reject", reason: "word-too-long" };

  text = text.replace(/[.!?,;:…]+$/g, "").trim();
  if (!text) return { kind: "reject", reason: "empty-after-cleanup" };

  return { kind: "summary", text };
}
