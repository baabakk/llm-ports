/**
 * Cross-adapter observability hook for transient retries.
 *
 * Adapters call `onRetry` when they decide to retry an in-flight request for
 * a known transient reason — burst-protection 401s, capability-rejection
 * fallback (drop temperature, drop json_object, drop system message),
 * reasoning-starved responses (model spent all tokens on hidden reasoning),
 * or schema-validation feedback retries.
 *
 * This is observability only. Adapters decide whether to retry; the hook just
 * gets told. Throwing from the hook does NOT cancel the retry — adapters call
 * the hook fire-and-forget.
 */

/**
 * Discriminator for why the adapter retried. New reasons may be added in
 * minor releases; consumers should default to logging the event verbatim
 * rather than switching exhaustively.
 */
export type RetryReason =
  /** Project-key burst-protection 401 from OpenAI. The key is valid; retry. */
  | "transient-auth"
  /** Model rejected an unsupported parameter (temperature, json_object, system). Drop and retry. */
  | "capability-fallback"
  /** Reasoning model spent its whole budget on hidden tokens. Retry with expanded budget. */
  | "reasoning-starvation"
  /** Structured-output response failed schema validation; retry with corrective feedback. */
  | "validation-feedback"
  /**
   * Tool call was emitted in the harmony reasoning channel (`message.reasoning_content`)
   * rather than the standard `message.tool_calls` array. The adapter extracted the
   * harmony tool call and hoisted it into the executable path. No retry was performed
   * — this is observability only, signaling that the response shape was non-standard
   * but recoverable. (alpha.23+)
   */
  | "harmony-tool-call-extracted"
  /**
   * Model emitted prose without making any tool calls, despite the request providing
   * a tools array. Retry with a corrective system message asking the model to use
   * the standard `tool_calls` array. Single-shot retry. (alpha.23+)
   */
  | "zero-tool-call-prose-retry";

/** What the adapter passes to `onRetry` each time it retries. */
export interface RetryEvent {
  reason: RetryReason;
  /** 0-indexed retry number (0 = first retry, after the original attempt failed). */
  attempt: number;
  modelId: string;
  providerAlias: string;
  /** Milliseconds slept before this retry. 0 when the retry fires immediately. */
  delayMs: number;
  /**
   * The error that triggered the retry, when applicable. `undefined` for
   * reasoning-starvation (which inspects a successful response, not an error)
   * and may be undefined for validation-feedback if the adapter doesn't
   * forward the Zod issues here.
   */
  cause?: unknown;
  /**
   * When `reason === "capability-fallback"`, names the specific capability
   * the adapter learned about (e.g. `temperatureLocked`, `jsonModeUnsupported`,
   * `systemMessageInUserOnly`). Lets observability stacks distinguish "we
   * stripped temperature" from "we stripped json_object" from each other.
   * Adapter authors should populate this whenever the retry was driven by a
   * specific capability rejection. Omitted for other retry reasons.
   */
  capability?: string;
}

/**
 * Observability hook. Sync or async. Adapters call it fire-and-forget; they
 * do NOT await the returned promise and do NOT cancel the retry if the hook
 * throws. Use this to emit logs, metrics, or traces.
 */
export type OnRetry = (event: RetryEvent) => void | Promise<void>;

/**
 * Jitter strategy for exponential backoff delays.
 *
 * Per the AWS Architecture Blog "Exponential Backoff And Jitter" (2015) and
 * subsequent industry consensus, decorrelated jitter is the recommended
 * default for high-concurrency clients because it preserves the average
 * backoff while breaking up retry storms most aggressively. "Full" matches
 * Genkit's default. "Equal" matches the classic Capacity-Random-Truncated
 * Binary Exponential Backoff. "None" disables jitter (use for tests).
 */
export type JitterStrategy = "none" | "full" | "equal" | "decorrelated";

/**
 * Configurable jittered exponential backoff for adapter retry loops.
 *
 * Adapters consume this config when computing the delay before a retry.
 * The shape matches Genkit's middleware retry config so users migrating
 * from Genkit see a familiar API.
 *
 * Defaults (when fields are omitted):
 *   - initialDelayMs: 200
 *   - maxDelayMs:     10000
 *   - multiplier:     2
 *   - jitter:         "decorrelated"
 *
 * Pseudocode for delay computation:
 *
 *   baseDelay = min(initialDelayMs * multiplier^attempt, maxDelayMs)
 *   switch (jitter) {
 *     case "none":          return baseDelay
 *     case "full":          return random(0, baseDelay)
 *     case "equal":         return baseDelay/2 + random(0, baseDelay/2)
 *     case "decorrelated":  return min(maxDelayMs, random(initialDelayMs, prevDelay * 3))
 *   }
 *
 * Added in alpha.17. Adapters wire this in adapter-specific releases.
 */
export interface BackoffConfig {
  /**
   * Delay before the first retry, in milliseconds. The base from which
   * subsequent attempts scale exponentially. Default: 200ms.
   */
  initialDelayMs?: number;

  /**
   * Hard ceiling on any single retry delay. Prevents runaway exponential
   * growth. Default: 10000ms (10 seconds).
   */
  maxDelayMs?: number;

  /**
   * Exponential growth factor. Default: 2 (each attempt waits ~2x the
   * previous one before jitter is applied).
   */
  multiplier?: number;

  /** Jitter strategy. Default: "decorrelated". */
  jitter?: JitterStrategy;
}

/**
 * Compute the delay (in ms) before the Nth retry attempt under a given
 * BackoffConfig. Pure function; useful for testing and for adapters that
 * want to apply uniform backoff semantics.
 *
 * @param attempt 0-indexed retry number (0 = before the first retry).
 * @param config  Backoff configuration. Missing fields filled with defaults.
 * @param prevDelay The previous attempt's computed delay; required for
 *   "decorrelated" jitter, ignored otherwise. Pass `initialDelayMs` for
 *   the first call.
 * @param rng A 0-1 uniform random function. Defaults to Math.random for
 *   production; tests should pass a deterministic function.
 */
export function computeBackoffDelay(
  attempt: number,
  config: BackoffConfig = {},
  prevDelay?: number,
  rng: () => number = Math.random,
): number {
  const initial = config.initialDelayMs ?? 200;
  const max = config.maxDelayMs ?? 10000;
  const multiplier = config.multiplier ?? 2;
  const jitter = config.jitter ?? "decorrelated";

  const baseDelay = Math.min(initial * Math.pow(multiplier, attempt), max);

  switch (jitter) {
    case "none":
      return baseDelay;
    case "full":
      return rng() * baseDelay;
    case "equal":
      return baseDelay / 2 + rng() * (baseDelay / 2);
    case "decorrelated": {
      const prev = prevDelay ?? initial;
      return Math.min(max, initial + rng() * (prev * 3 - initial));
    }
  }
}
