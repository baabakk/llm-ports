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
  | "validation-feedback";

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
}

/**
 * Observability hook. Sync or async. Adapters call it fire-and-forget; they
 * do NOT await the returned promise and do NOT cancel the retry if the hook
 * throws. Use this to emit logs, metrics, or traces.
 */
export type OnRetry = (event: RetryEvent) => void | Promise<void>;
