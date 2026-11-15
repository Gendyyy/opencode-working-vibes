// The narrator core is shared by the TUI and the desktop bundle, so it must not
// reach for either host's runtime. Type-only imports are fine: the hosts replace
// their own copies of those packages at load time, but types vanish at build.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CORE = join(import.meta.dir, "..", "src", "core");
const files = readdirSync(CORE).filter((name) => name.endsWith(".ts"));
const poisoned = /^import\s+(?!type\b)[^;]*?from\s+"(@opentui\/|@opencode-ai\/|solid-js|effect)/m;

describe("narrator core boundary", () => {
  test("core has modules to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)("%s imports no host runtime", (name) => {
    const source = readFileSync(join(CORE, name), "utf8");
    expect(source.match(poisoned)?.[0]).toBeUndefined();
  });
});
