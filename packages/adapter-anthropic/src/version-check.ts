/**
 * SDK version compatibility check.
 *
 * Surfaces a clear "upgrade us or downgrade them" warning when the
 * installed `@anthropic-ai/sdk` version is outside the range this
 * adapter has been tested against.
 *
 * This is observability only; the warning does not block adapter
 * construction. Users on slightly newer SDK versions may still work
 * fine; the warning just tells them they're outside the tested matrix.
 */

/** Inclusive lower bound: the minimum SDK version this adapter supports. */
const SDK_MIN_VERSION = "0.32.0";
/** Exclusive upper bound: the next major we have NOT tested against. */
const SDK_MAX_VERSION_EXCLUSIVE = "0.50.0";

/**
 * Compare two semver-shaped version strings (`"X.Y.Z"`).
 * Returns -1 if `a < b`, 0 if equal, +1 if `a > b`.
 * Pre-release suffixes (e.g. `"-beta.1"`) are stripped before compare.
 */
function compareSemver(a: string, b: string): number {
  const aClean = a.replace(/^v/i, "").split("-")[0] ?? a;
  const bClean = b.replace(/^v/i, "").split("-")[0] ?? b;
  const aParts = aClean.split(".").map((p) => parseInt(p, 10));
  const bParts = bClean.split(".").map((p) => parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

/**
 * Warn (via console.warn) if the installed SDK is outside the tested
 * range. Called once at adapter construction. Returns silently if the
 * version is in range, the version cannot be determined, or any error
 * occurs during the check (we never want this helper to block construction).
 */
export function checkSdkCompatibility(installedSdkVersion: string | undefined): void {
  if (!installedSdkVersion) return;

  try {
    const tooOld = compareSemver(installedSdkVersion, SDK_MIN_VERSION) < 0;
    const tooNew = compareSemver(installedSdkVersion, SDK_MAX_VERSION_EXCLUSIVE) >= 0;

    if (tooOld) {
      console.warn(
        `[@llm-ports/adapter-anthropic] Installed @anthropic-ai/sdk@${installedSdkVersion} ` +
          `is older than the tested minimum (${SDK_MIN_VERSION}). ` +
          `Either upgrade @anthropic-ai/sdk to >= ${SDK_MIN_VERSION}, or downgrade ` +
          `@llm-ports/adapter-anthropic to a version that targets your SDK. ` +
          `Continuing, but you may see unexpected request/response shape errors.`,
      );
      return;
    }

    if (tooNew) {
      console.warn(
        `[@llm-ports/adapter-anthropic] Installed @anthropic-ai/sdk@${installedSdkVersion} ` +
          `is newer than the tested range (< ${SDK_MAX_VERSION_EXCLUSIVE}). ` +
          `Either upgrade @llm-ports/adapter-anthropic to a version that supports ` +
          `your SDK, or pin @anthropic-ai/sdk to < ${SDK_MAX_VERSION_EXCLUSIVE}. ` +
          `Continuing, but you may see unexpected request/response shape errors.`,
      );
      return;
    }
  } catch {
    // Never fail adapter construction due to a version-check problem.
    return;
  }
}

/**
 * Best-effort lookup of the installed `@anthropic-ai/sdk` version. Returns
 * undefined if the package isn't resolvable (e.g. unusual bundler setup,
 * test environment with mocked imports).
 */
export function getInstalledSdkVersion(): string | undefined {
  try {
    // Use require() rather than dynamic import so the check is synchronous
    // at adapter construction. Wrapped in try/catch because bundlers may
    // tree-shake or refuse to resolve package.json files.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("@anthropic-ai/sdk/package.json") as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}
