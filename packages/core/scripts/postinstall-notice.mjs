#!/usr/bin/env node
/**
 * Postinstall banner for @llm-ports/core.
 *
 * Purpose: print a single-line banner when the installed version changes since
 * the last install, pointing the user at the migration guide. Helps catch
 * accidental jumps across breaking alpha releases.
 *
 * Constraints (deliberately conservative for a postinstall script):
 *   - Never block the install. Bail silently on any error.
 *   - One single-line banner; no multi-line ASCII art.
 *   - Print once per version change. Persist a marker file inside this
 *     package's install directory so reinstalls of the same version stay quiet.
 *   - Skip in CI environments (CI=true / CONTINUOUS_INTEGRATION=true).
 *   - Skip when LLM_PORTS_NO_NOTICE=1 is set.
 *   - Skip when stdout is not a TTY (so it doesn't pollute log capture).
 *   - No network calls. No outside-tree writes.
 *
 * To disable globally:  export LLM_PORTS_NO_NOTICE=1
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

try {
  // Honor explicit opt-out.
  if (process.env["LLM_PORTS_NO_NOTICE"] === "1") process.exit(0);

  // Skip in CI — postinstall output spam helps no one in build logs.
  if (process.env["CI"] === "true" || process.env["CONTINUOUS_INTEGRATION"] === "true") {
    process.exit(0);
  }

  // Skip when stdout isn't a TTY (CI, redirected output, etc.).
  if (!process.stdout.isTTY) process.exit(0);

  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  if (!existsSync(pkgPath)) process.exit(0);

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const version = typeof pkg.version === "string" ? pkg.version : null;
  if (!version) process.exit(0);

  // Marker file lives inside our own install directory so it travels with the
  // package and is reset on a fresh install.
  const markerPath = join(here, "..", ".last-installed-version");
  let last = "";
  if (existsSync(markerPath)) {
    try {
      last = readFileSync(markerPath, "utf8").trim();
    } catch {
      // ignore
    }
  }

  if (last === version) process.exit(0);

  // Write the marker first so an error in console output doesn't cause a
  // re-fire on the next install.
  try {
    writeFileSync(markerPath, version, "utf8");
  } catch {
    // ignore
  }

  // The single-line banner. Use a leading ⓘ for visual scan; ANSI for color
  // only when the terminal supports it.
  const color = supportsColor();
  const dim = color ? "[2m" : "";
  const reset = color ? "[0m" : "";
  const cyan = color ? "[36m" : "";

  const heading =
    last === ""
      ? `${cyan}@llm-ports/core${reset} v${version} installed`
      : `${cyan}@llm-ports/core${reset} upgraded ${dim}${last}${reset} → v${version}`;

  process.stdout.write(`ⓘ  ${heading}\n`);
  process.stdout.write(
    `   ${dim}migration:${reset} https://github.com/baabakk/llm-ports/blob/main/MIGRATION.md\n`,
  );
  process.stdout.write(`   ${dim}disable banner:${reset} export LLM_PORTS_NO_NOTICE=1\n`);
} catch {
  // Any unhandled error is silently swallowed. A failing postinstall script
  // that blocks `npm install` is far worse than a missing banner.
  process.exit(0);
}

function supportsColor() {
  if (process.env["NO_COLOR"]) return false;
  if (process.env["FORCE_COLOR"]) return true;
  return process.stdout.isTTY === true && process.platform !== "win32";
}
