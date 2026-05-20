/**
 * Idempotent error-wrapping helper for adapter implementations.
 *
 * Every adapter's `messages.create` / `chat.completions.create` call wraps
 * the inner SDK call in try/catch and pipes the error through this helper
 * before throwing it out of the LLMPort method. The contract:
 *
 *   - Typed framework errors (`ProviderUnavailableError`,
 *     `EmptyResponseError`, `ValidationError`) pass through unchanged.
 *     These are intentional signals from upstream code; double-wrapping
 *     them would hide their type from the caller's try/catch.
 *
 *   - Any other `Error` instance is wrapped as `ProviderUnavailableError`
 *     so the registry can identify the failure as a provider problem and
 *     (in v0.2+) walk the fallback chain.
 *
 *   - Non-Error values (strings, undefined, primitives) are stringified
 *     into an Error first, then wrapped.
 *
 * Hoisted from per-adapter copies in alpha.3. Every adapter that previously
 * wrote its own `wrapError(alias, err)` now imports `wrapProviderError`.
 */

import { EmptyResponseError, ProviderUnavailableError } from "../errors.js";

/**
 * Wrap an unknown caught error as a typed framework error.
 *
 * Idempotent on `ProviderUnavailableError`, `EmptyResponseError`, and
 * `ValidationError`. All other inputs produce a fresh `ProviderUnavailableError`
 * carrying the original error as its `cause`.
 */
export function wrapProviderError(alias: string, err: unknown): Error {
  if (err instanceof ProviderUnavailableError) {
    return err;
  }
  if (err instanceof EmptyResponseError) {
    return err;
  }
  if (err instanceof Error && err.name === "ValidationError") {
    return err;
  }
  if (err instanceof Error) {
    return new ProviderUnavailableError(alias, err);
  }
  return new ProviderUnavailableError(alias, new Error(String(err)));
}
