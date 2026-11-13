/**
 * The reported library version must match the package version.
 *
 * The literal this guards replaced said `0.1.0-alpha.30` while the package was
 * at `alpha.35`. The Codex adapter carried the same string, and the contract
 * package's `SPEC_VERSION` is further behind still, under a comment asserting a
 * version-bump script that does not exist. Three hardcoded versions, three
 * stale, nothing checking. This is the check.
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
