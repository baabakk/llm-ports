/**
 * Fire-and-forget invocation of the `onRetry` observability hook.
 *
 * Adapters fire this on every retry attempt for the reasons documented in
 * `RetryReason`. Hooks are called fire-and-forget: errors thrown synchronously
 * or rejected promises are swallowed silently so observability code can never
 * cancel a retry or crash the request.
 *
 * Hoisted from per-adapter copies in alpha.3 so every adapter shares the same
 * semantics. Adapters that wrote their own `emitRetry` (adapter-openai,
 * adapter-vercel) now import this instead.
 */

import type { OnRetry, RetryEvent } from "./retry.js";

/**
 * Invoke `onRetry` with the given event, fire-and-forget.
 *
 * - If `onRetry` is undefined, returns immediately.
 * - If `onRetry` throws synchronously, the error is swallowed.
 * - If `onRetry` returns a rejected promise, the rejection is swallowed.
 *
 * Observability hooks are not allowed to affect retry behavior. This helper
 * enforces that invariant.
 */
export function emitRetryEvent(onRetry: OnRetry | undefined, event: RetryEvent): void {
  if (!onRetry) return;
  try {
    const result = onRetry(event);
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch(() => {
        /* swallow — hook is observability only */
      });
    }
  } catch {
    /* swallow — hook is observability only */
  }
}
