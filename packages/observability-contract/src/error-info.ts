/**
 * ErrorInfo shape per Plan 58 v0.4 §4.4.
 *
 * The structured error payload carried by every failure event
 * (`llm.attempt.failed`, `llm.operation.failed`, `agent.tool.returned`
 * when the tool errored). Mirrors the walk-table policy exported from
 * `@llm-ports/core` as `defaultShouldFallback`.
 *
 * Design principles:
 *
 *   - Free of raw provider response bodies by default. Bodies commonly
 *     carry prompt content, credentials, and customer data. Sinks with
 *     an explicit CapturePolicy allowance can opt into raw-body
 *     capture; the default posture is `details_redacted: true`.
 *
 *   - `retryable` and `fallback_worthy` are separate booleans, not
 *     rolled into one field. Same-provider retry (e.g. after 429 backoff)
 *     is orthogonal to walking to the next provider in the chain
 *     (e.g. after CreditExhaustionError).
 *
 *   - `cause_category` is a small enum for rollup dashboards. Rolls
 *     up the more granular `error_type` (which is one of the 20+ typed
 *     error classes) into a handful of buckets operators care about at
 *     a glance.
 *
 *   - `provider_status_code` + `retry_after_ms` + `provider_error_code`
 *     capture the transport-layer signals when present. Adapters extract
 *     these from the raw response BEFORE the body is redacted, so
 *     they survive the capture-policy filter.
 */

/**
 * Rollup category for dashboards. Sinks with an "error rate over time"
 * panel group by this rather than by `error_type` (which has too many
 * distinct values for a useful pie chart).
 *
 * "client_input": the caller sent something wrong (missing message,
 *   malformed schema, invalid image URL). Deterministic; walking does
 *   not help.
 * "provider_capacity": the provider is at capacity (429, exhausted
 *   credit, rate-limit). Transient; walking often recovers.
 * "provider_auth": credential problem (wrong key, expired token,
 *   quota disabled). Not fixable by walking.
 * "provider_unavailable": provider itself is down (5xx, SDK unreachable,
 *   fetch failed at network layer). Walk to next provider.
 * "provider_capability": provider cannot handle THIS request but a
 *   different provider might (context window exceeded, content policy
 *   violation, unsupported content block, image too large). Walk is
 *   the recommended response.
 * "network": lower-layer network failure (DNS, TLS, connection reset)
 *   that could not be attributed to a specific status code.
 * "port_internal": bug in @llm-ports itself (AdapterInternalError).
 *   Walking is pure waste; the fix is inside the port library.
 * "unknown": adapter could not classify. Rare; investigate.
 */
export type CauseCategory =
  | "client_input"
  | "provider_capacity"
  | "provider_auth"
  | "provider_unavailable"
  | "provider_capability"
  | "network"
  | "port_internal"
  | "unknown";

/**
 * The structured error shape carried by failure events. Fields are
 * ordered from most-often-populated to least-often-populated for
 * developer readability.
 */
export interface ErrorInfo {
  /**
   * String form of the typed error class (`AuthenticationError`,
   * `ContextWindowExceededError`, `CreditExhaustionError`,
   * `AdapterInternalError`, etc.). Consumers switch on this for
   * class-specific handling.
   */
  error_type: string;

  /**
   * Human-readable message. May be truncated or redacted per
   * CapturePolicy.error_body_capture.
   */
  message?: string;

  /**
   * True when a same-provider retry may succeed. Set by adapters based
   * on the error class and the specific transport-layer signals (e.g.
   * 429 with a Retry-After header → true).
   */
  retryable: boolean;

  /**
   * True when walking to the next provider in the chain may recover.
   * Mirrors `defaultShouldFallback`'s walk-table decision.
   */
  fallback_worthy: boolean;

  /** Rollup category for dashboards. */
  cause_category: CauseCategory;

  /** HTTP status when the adapter observed one. */
  provider_status_code?: number;

  /**
   * Provider-hinted delay before retrying (parsed from `Retry-After` or
   * `retry-after-ms` headers). Present only when the provider supplied
   * one AND the class is retryable.
   */
  retry_after_ms?: number;

  /**
   * Provider-specific error code (e.g. OpenAI's `insufficient_quota`,
   * Anthropic's `credit_balance_too_low`). Adapters extract these from
   * the response body BEFORE redaction so the code survives even when
   * the body doesn't.
   */
  provider_error_code?: string;

  /**
   * True when the raw provider response body was omitted from `message`
   * per the CapturePolicy. Consumers looking at a redacted event know
   * to inspect the sink's ambient policy rather than concluding no
   * body was present.
   */
  details_redacted?: boolean;
}

/**
 * A convenience constant naming the full rollup enum. Sinks iterating
 * for exhaustiveness or building a category-picker UI use this.
 */
export const CAUSE_CATEGORIES: readonly CauseCategory[] = [
  "client_input",
  "provider_capacity",
  "provider_auth",
  "provider_unavailable",
  "provider_capability",
  "network",
  "port_internal",
  "unknown",
] as const;

/**
 * Guidance mapping from the typed error class name (`error_type`) to
 * the canonical CauseCategory. Adapters consulting this ensure the
 * rollup category is consistent across the ecosystem, so a dashboard
 * grouping by `cause_category` sees the same buckets no matter which
 * provider surfaced the error.
 *
 * Unlisted classes fall through to "unknown"; sinks may extend this
 * mapping for consumer-specific typed classes.
 */
export const ERROR_TYPE_TO_CATEGORY: Readonly<Record<string, CauseCategory>> = {
  // Client input
  MessagesRequiredError: "client_input",
  EmptyMessagesError: "client_input",
  MessagesConflictError: "client_input",
  PromptRequiredError: "client_input",
  NonContiguousSystemError: "client_input",
  BadRequestError: "client_input",
  InvalidImageUrlError: "client_input",
  ValidationError: "client_input",
  ConfigError: "client_input",

  // Provider capacity
  RateLimitError: "provider_capacity",
  CreditExhaustionError: "provider_capacity",
  BudgetExceededError: "provider_capacity",
  SessionBudgetExceededError: "provider_capacity",

  // Provider auth
  AuthenticationError: "provider_auth",

  // Provider unavailable
  ServiceUnavailableError: "provider_unavailable",
  ProviderUnavailableError: "provider_unavailable",
  EmptyResponseError: "provider_unavailable",
  NoProvidersAvailableError: "provider_unavailable",

  // Provider capability
  ContextWindowExceededError: "provider_capability",
  ContentPolicyViolationError: "provider_capability",
  ImageTooLargeError: "provider_capability",
  ContentBlockUnsupportedError: "provider_capability",
  ProviderMalformed400Error: "provider_capability",

  // Port internal
  AdapterInternalError: "port_internal",
};

/**
 * Resolve the CauseCategory for a given error class name. Falls through
 * to "unknown" for unrecognized classes. Consumers with their own typed
 * classes may compose:
 *
 * ```ts
 * const cat = errorTypeToCauseCategory(myErr.name) ??
 *   MY_CONSUMER_MAP[myErr.name] ??
 *   "unknown";
 * ```
 */
export function errorTypeToCauseCategory(errorType: string): CauseCategory {
  return ERROR_TYPE_TO_CATEGORY[errorType] ?? "unknown";
}
