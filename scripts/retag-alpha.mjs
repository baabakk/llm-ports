#!/usr/bin/env node
/**
 * Re-roll every publishable package's `alpha` dist-tag forward to the
 * version currently in its package.json.
 *
 * Why this exists: `changeset publish` writes new versions to `latest` (the
 * default dist-tag) but does NOT touch other dist-tags. So after a
 * prerelease publish like alpha.2, the `alpha` tag on npm still points at
 * alpha.1 and `npm install @llm-ports/core@alpha` resolves to the older
 * version. This script closes that gap by re-tagging the alpha tag for
 * every package whose version contains `-alpha.` (i.e. is still in pre-mode).
 *
 * Usage (typically chained after a publish):
 *   pnpm release && node scripts/retag-alpha.mjs
 *
 * Or for a one-off after manual publishing:
 *   node scripts/retag-alpha.mjs
 *
 * Skips packages with `private: true` (those don't go to npm at all).
 * Skips packages whose version is NOT in -alpha.* form (those would be
 * stable releases that shouldn't have an `alpha` tag pointing at them).
 *
 * Idempotent: re-tagging to the same version is a no-op on npm.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

const packageDirs = (await readdir(PACKAGES_DIR, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => join(PACKAGES_DIR, d.name));

let retagged = 0;
let skippedPrivate = 0;
let skippedNonAlpha = 0;
let failures = 0;

for (const dir of packageDirs) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }

  if (pkg.private) {
    console.log(`  skip (private): ${pkg.name}`);
    skippedPrivate++;
    continue;
  }
  if (!pkg.version.includes("-alpha.")) {
    console.log(`  skip (not alpha): ${pkg.name}@${pkg.version}`);
    skippedNonAlpha++;
    continue;
  }

  const fullSpec = `${pkg.name}@${pkg.version}`;
  console.log(`  retagging alpha -> ${fullSpec}`);
  // `shell: true` is required on Windows so `npm` resolves to `npm.cmd`.
  // Safe here: the args (pkg.name, pkg.version) come from our own
  // package.json files in `packages/*`, NOT from user input or env. No
  // command-injection path. Node emits DEP0190 but it's cosmetic for this case.
  const result = spawnSync("npm", ["dist-tag", "add", fullSpec, "alpha"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  if (result.error) {
    console.error(`  ✗ FAILED to invoke npm for ${fullSpec}:`, result.error.message);
    failures++;
    continue;
  }
  if (result.status !== 0) {
    console.error(`  ✗ FAILED: ${fullSpec}`);
    if (result.stderr) {
      console.error(`    stderr: ${result.stderr.toString().trim()}`);
    }
    failures++;
    continue;
  }
  retagged++;
}

console.log(
  `\nretagged: ${retagged}, skipped (private): ${skippedPrivate}, ` +
    `skipped (non-alpha): ${skippedNonAlpha}, failed: ${failures}`,
);
process.exit(failures > 0 ? 1 : 0);
