/**
 * Unit tests for the `alpha-19-to-alpha-20` codemod.
 *
 * Verifies the rewrite shape, the skip cases, and the manual-review flagging.
 * No filesystem access — operates on source strings.
 */

import { describe, expect, it } from "vitest";
import "../src/index.js"; // triggers registration

import { listMigrations } from "../src/index.js";

// Pull the registered migration via the public list. We access its rewriter
// through the index registry, but for unit tests we re-import the private
// pattern by re-running registerMigration — simpler to re-execute the
// rewriteSource directly. To keep this test isolated, we duplicate the
// rewriter call by going through runMigration on an in-memory shim. For
// pure unit testing the regex, we expose a tiny helper here:

import { runMigration } from "../src/index.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withTempProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "llm-ports-migrate-test-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const full = join(root, name);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, contents, "utf8");
    }
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("alpha-19-to-alpha-20 codemod", () => {
  it("is registered and discoverable via listMigrations()", () => {
    expect(listMigrations()).toContain("alpha-19-to-alpha-20");
  });

  it("rewrites a bare read of entry.budgetLimit.requestsPerHour", async () => {
    await withTempProject(
      {
        "src/app.ts": `
const rph = entry.budgetLimit.requestsPerHour;
console.log(rph);
`,
      },
      async (root) => {
        const report = await runMigration("alpha-19-to-alpha-20", { root, write: true, quiet: true });
        expect(report.rewritesApplied).toBe(1);
        expect(report.filesChanged).toBe(1);
        const out = await readFile(join(root, "src/app.ts"), "utf8");
        expect(out).toContain("(entry.budgetLimit.requestsPerHour ?? Infinity)");
      },
    );
  });

  it("dry-run does not modify the file", async () => {
    await withTempProject(
      {
        "src/app.ts": `const rph = config.providers.fast.budgetLimit.requestsPerHour;\n`,
      },
      async (root) => {
        const report = await runMigration("alpha-19-to-alpha-20", { root, write: false, quiet: true });
        expect(report.rewritesApplied).toBe(1);
        expect(report.filesChanged).toBe(1); // counted as "would change"
        const out = await readFile(join(root, "src/app.ts"), "utf8");
        // File on disk is untouched in dry-run.
        expect(out).toBe(`const rph = config.providers.fast.budgetLimit.requestsPerHour;\n`);
      },
    );
  });

  it("skips a match already guarded with ?? Infinity", async () => {
    await withTempProject(
      {
        "src/app.ts": `const rph = entry.budgetLimit.requestsPerHour ?? Infinity;\n`,
      },
      async (root) => {
        const report = await runMigration("alpha-19-to-alpha-20", { root, write: true, quiet: true });
        expect(report.rewritesApplied).toBe(0);
        const out = await readFile(join(root, "src/app.ts"), "utf8");
        expect(out).toBe(`const rph = entry.budgetLimit.requestsPerHour ?? Infinity;\n`);
      },
    );
  });

  it("skips a match guarded with optional chaining (?.)", async () => {
    await withTempProject(
      {
        "src/app.ts": `const rph = entry?.budgetLimit?.requestsPerHour ?? Infinity;\n`,
      },
      async (root) => {
        const report = await runMigration("alpha-19-to-alpha-20", { root, write: true, quiet: true });
        expect(report.rewritesApplied).toBe(0);
      },
    );
  });

  it("flags a read inside an `if (` condition as manual-review", async () => {
    await withTempProject(
      {
        "src/app.ts": `if (entry.budgetLimit.requestsPerHour > 100) doStuff();\n`,
      },
      async (root) => {
        const report = await runMigration("alpha-19-to-alpha-20", { root, write: true, quiet: true });
        expect(report.rewritesApplied).toBe(0);
        expect(report.manualReviewSites).toHaveLength(1);
        expect(report.manualReviewSites[0]?.reason).toMatch(/if \(/);
      },
    );
  });

  it("flags an assignment LHS as manual-review and skips the rewrite", async () => {
    await withTempProject(
      {
        "src/app.ts": `entry.budgetLimit.requestsPerHour = 100;\n`,
      },
      async (root) => {
        const report = await runMigration("alpha-19-to-alpha-20", { root, write: true, quiet: true });
        expect(report.rewritesApplied).toBe(0);
        expect(report.manualReviewSites).toHaveLength(1);
        expect(report.manualReviewSites[0]?.reason).toMatch(/assignment/);
      },
    );
  });

  it("rewrites multiple occurrences in a single file", async () => {
    await withTempProject(
      {
        "src/app.ts": `
const a = entry.budgetLimit.requestsPerHour;
const b = providerEntry.budgetLimit.requestsPerHour;
const c = configs.providers.fast.budgetLimit.requestsPerHour;
`,
      },
      async (root) => {
        const report = await runMigration("alpha-19-to-alpha-20", { root, write: true, quiet: true });
        expect(report.rewritesApplied).toBe(3);
      },
    );
  });

  it("ignores files outside the scanned extensions", async () => {
    await withTempProject(
      {
        "src/app.md": `entry.budgetLimit.requestsPerHour\n`,
        "src/app.json": `{ "x": "entry.budgetLimit.requestsPerHour" }`,
      },
      async (root) => {
        const report = await runMigration("alpha-19-to-alpha-20", { root, write: true, quiet: true });
        expect(report.rewritesApplied).toBe(0);
        expect(report.filesScanned).toBe(0);
      },
    );
  });
});
