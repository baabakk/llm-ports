/**
 * The reported library version must match the package version.
 *
 * This exists because a constant did not stay true. `library_version` on every
 * observability event this adapter emits was the literal `0.1.0-alpha.30` for
 * five releases, so anything correlating events by emitter version was reading
 * a lie. The aider adapter still carries the same stale string, and the
 * contract package's `SPEC_VERSION` is further behind still, under a comment
 * asserting that a version-bump script keeps it in sync. No such script exists.
 *
 * Three hardcoded versions, three stale, one of them documented as maintained.
 * The pattern is not forgetfulness, it is that nothing was checking. This test
 * is the check: it fails on the next version bump, in the package being bumped,
 * before anything publishes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTER_VERSION } from "../src/adapter.js";

describe("reported version", () => {
  it("matches package.json, so observability events do not claim a stale emitter", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version: string;
    };

    expect(ADAPTER_VERSION).toBe(pkg.version);
  });
});
