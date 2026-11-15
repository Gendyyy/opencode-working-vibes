// Purpose: fail the check when src/ regains a runtime (non-type) import of a module
// that opencode supplies itself. opencode replaces @opencode-ai/* and `effect` with
// its own bundled copies at load time, so a locally pinned copy resolves against a
// different `effect` version than the host and throws during import — before any
// plugin code runs, and invisible to typecheck.
import { Glob } from "bun";
import { readFileSync } from "node:fs";

/** Host-owned modules: importing these at runtime couples us to opencode's internals. */
const FORBIDDEN = /^(?:@opencode-ai\/.*|effect(?:\/.*)?)$/;

/** Matches an import statement and captures its clause and module specifier. */
const IMPORT_RE = /^\s*import\s+(?:([^"';]*?)\s+from\s+)?["']([^"']+)["']/;

/**
 * True when an import clause holds only type specifiers, in which case TypeScript
 * erases the statement and no runtime module resolution happens.
 */
function isTypeOnly(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed.startsWith("type ")) return true;
  if (!trimmed.startsWith("{")) return false;
  return trimmed
    .slice(1, trimmed.lastIndexOf("}"))
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier.length > 0)
    .every((specifier) => specifier.startsWith("type "));
}

/** Collects `file:line imports "module"` for every forbidden runtime import under src/. */
function findOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of new Glob("src/**/*.{ts,tsx}").scanSync()) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const match = IMPORT_RE.exec(line);
        if (match === null) return;
        const [, clause = "", specifier] = match;
        if (!FORBIDDEN.test(specifier)) return;
        if (isTypeOnly(clause)) return;
        offenders.push(`${file}:${index + 1} imports "${specifier}" at runtime`);
      });
  }
  return offenders;
}

const offenders = findOffenders();

if (offenders.length > 0) {
  console.error("Host-owned modules must not be imported at runtime:");
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error("\nUse `import type` and let opencode supply the module in-process.");
  process.exit(1);
}

console.log("runtime deps ok: src/ imports no host-owned module at runtime");
