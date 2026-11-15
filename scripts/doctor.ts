// Purpose: report whether opencode actually loaded the working-vibes plugin on its
// most recent run. A load failure is only a WARN inside opencode's log and shows up
// to the user as a missing chip, so this surfaces the cause immediately.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_PATH = join(homedir(), ".local/share/opencode/log/opencode.log");
const DEBUG_LOG_PATH = join(homedir(), ".config/opencode/working-vibes-debug.log");
const PLUGIN_ID = "@agendy/opencode-working-vibes";

/** Line indexes of the last successful load attempt and the last failure for the plugin. */
function inspect(lines: string[]): { attempt: number; failure: number } {
  let attempt = -1;
  let failure = -1;
  lines.forEach((line, index) => {
    if (!line.includes(PLUGIN_ID)) return;
    if (line.includes("loading plugin") && line.includes("entrypoint")) attempt = index;
    if (line.includes("failed to load plugin")) failure = index;
  });
  return { attempt, failure };
}

/** Prints a red failure and exits non-zero. */
function fail(message: string): never {
  console.error(`\u001b[31mFAIL\u001b[0m ${message}`);
  process.exit(1);
}

/** Reports last-write time of the plugin's own debug log, if it exists. */
function reportDebugLog(): void {
  if (!existsSync(DEBUG_LOG_PATH)) {
    console.log(`      debug log: missing (${DEBUG_LOG_PATH})`);
    return;
  }
  const { mtime } = statSync(DEBUG_LOG_PATH);
  console.log(`      debug log: last written ${mtime.toISOString()}`);
}

if (!existsSync(LOG_PATH)) {
  fail(`no opencode log at ${LOG_PATH} — start opencode once, then re-run.`);
}

const lines = readFileSync(LOG_PATH, "utf8").split("\n");
const { attempt, failure } = inspect(lines);

if (attempt === -1) {
  fail(`no load attempt for ${PLUGIN_ID} in the log — opencode has not started since the plugin was added.`);
}

if (failure > attempt) {
  console.error(lines[failure].trim());
  fail(`${PLUGIN_ID} was loaded at line ${attempt + 1} and failed at line ${failure + 1}.`);
}

console.log(`\u001b[32mOK\u001b[0m   ${PLUGIN_ID} loaded without error (last attempt at line ${attempt + 1}).`);
reportDebugLog();
