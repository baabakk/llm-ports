/**
 * Seams that exist for this package's own tests and are not public API.
 *
 * Nothing here is re-exported from `src/index.ts`, and only `dist` is
 * published, so a consumer cannot reach any of it. The package's own tests
 * import this module by path.
 *
 * **Why a module rather than an option.** `transientAuthBackoffMs` used to sit
 * on `OpenAIAdapterOptions`, where it was reachable, documented and about to be
 * frozen into the version-1 contract, purely so six test files could skip a
 * wait. An underscore prefix would not have helped: a convention is not a
 * boundary, and the field would still appear in the published type
 * definitions. See `TD-LLMP-10`.
 */

/**
 * Override the backoff between transient-401 retries.
 *
 * Set on the options object passed to `createOpenAIAdapter`, keyed by this
 * symbol. The value is `(attempt: number) => number`, receiving the 0-indexed
 * retry attempt and returning milliseconds. Absent, the adapter uses
 * `(attempt) => 500 * Math.pow(3, attempt)`: 500ms, 1500ms, 4500ms.
 *
 * Tests set `() => 0` so a three-retry case does not spend six and a half
 * seconds asleep.
 */
export const TRANSIENT_AUTH_BACKOFF_SEAM: unique symbol = Symbol(
  "llm-ports.internal.transientAuthBackoffMs",
);

/** Options carrying the test seam. Internal to this package. */
export interface WithTransientAuthBackoffSeam {
  [TRANSIENT_AUTH_BACKOFF_SEAM]?: (attempt: number) => number;
}

/**
 * Read the seam off an options object, if a test set it.
 *
 * Takes `unknown` because the public options type does not and must not
 * declare the key.
 */
export function readTransientAuthBackoffSeam(
  options: unknown,
): ((attempt: number) => number) | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const value = (options as Record<symbol, unknown>)[TRANSIENT_AUTH_BACKOFF_SEAM];
  return typeof value === "function" ? (value as (attempt: number) => number) : undefined;
}
