/**
 * A bounded record of recent retries, for showing instability without
 * subscribing to every event.
 *
 * ## Why this is not `registry.recentRetries()`
 *
 * That is how the ask was phrased (alpha.28 item 9, Dramma), and the registry
 * cannot answer it. **Retries happen inside adapters**: provider backoff, and
 * the retry-with-feedback round when a model returns the wrong shape. The
 * registry's own recovery is a different thing, walking to the next provider,
 * which is a fallback rather than a retry. An adapter reports its retries
 * through the `onRetry` hook it is constructed with, and the consumer builds
 * the adapters, so the registry never sees them.
 *
 * A `registry.recentRetries()` would therefore have to either return nothing
 * useful or quietly report only fallbacks under a name that says retries.
 * This is the same capability, wired where the events actually are: one
 * recorder, passed to the adapters as their `onRetry`, queried whenever the
 * caller wants a picture.
 *
 * ```ts
 * const retries = createRetryRecorder();
 * const adapters = {
 *   openai: createOpenAIAdapter({ apiKey, onRetry: retries.onRetry }),
 *   anthropic: createAnthropicAdapter({ apiKey, onRetry: retries.onRetry }),
 * };
 * // later, on a dashboard or a health check:
 * retries.recent(10);
 * ```
 *
 * Bounded by construction, because the reason the ask exists is to look at
 * recent instability, and an unbounded log of every retry a long-running
 * process ever performed is a memory leak wearing a feature's clothes.
 *
 * Added in `0.1.0-alpha.35`.
 */

import type { RetryEvent } from "../observability.js";

/** One recorded retry, with the time it was observed. */
export interface RecordedRetry {
  /** When the recorder saw it, as epoch milliseconds. */
  at: number;
  event: RetryEvent;
}

export interface RetryRecorder {
  /**
   * Pass this as an adapter's `onRetry`. Safe to share across every adapter:
   * the events carry their own provider alias, so one recorder covers a whole
   * registry.
   */
  onRetry: (event: RetryEvent) => void;
  /**
   * The most recent retries, newest first. `n` defaults to the whole buffer
   * and is clamped to it.
   */
  recent(n?: number): readonly RecordedRetry[];
  /** How many retries the recorder has seen since it was created, including evicted ones. */
  readonly total: number;
  /** Forget everything retained. Does not reset `total`. */
  clear(): void;
}

/**
 * @param capacity how many retries to retain. Defaults to 50, which is enough
 * to see a pattern and small enough to be free. Values below 1 are treated as 1.
 */
export function createRetryRecorder(capacity = 50): RetryRecorder {
  const limit = Math.max(1, Math.floor(capacity));
  const buffer: RecordedRetry[] = [];
  let seen = 0;

  return {
    onRetry(event: RetryEvent): void {
      seen++;
      buffer.push({ at: Date.now(), event });
      // Evict oldest first. A ring buffer would avoid the shift, and at this
      // size the clarity is worth more than the microseconds.
      if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
    },
    recent(n?: number): readonly RecordedRetry[] {
      const count = n === undefined ? buffer.length : Math.max(0, Math.min(Math.floor(n), buffer.length));
      // Newest first: a caller asking for "the last 5" wants the most recent
      // five, and having to reverse the result is a paper cut in every caller.
      return buffer.slice(buffer.length - count).reverse();
    },
    get total(): number {
      return seen;
    },
    clear(): void {
      buffer.length = 0;
    },
  };
}
