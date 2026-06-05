/**
 * Idempotent error-wrapping helper for adapter implementations.
 *
 * Every adapter's `messages.create` / `chat.completions.create` call wraps
 * the inner SDK call in try/catch and pipes the error through this helper
 * before throwing it out of the LLMPort method. The contract:
 *
 *   - Typed framework errors pass through unchanged. These are intentional
 *     signals from upstream code; double-wrapping them would hide their
 *     type from the caller's try/catch.
 *
 *   - HTTP-shaped SDK errors get classified into the new alpha.18 typed
 *     taxonomy: 400-context-window → ContextWindowExceededError; 400-policy
 *     → ContentPolicyViolationError; 401/403 → AuthenticationError; 429 →
 *     RateLimitError (with parsed retryAfterMs); 502/503/504 →
 *     ServiceUnavailableError; everything else → ProviderUnavailableError.
 *
 *   - Non-Error values (strings, undefined, primitives) are stringified
 *     into an Error first, then classified.
 *
 * Hoisted from per-adapter copies in alpha.3; HTTP classification added in
 * alpha.18 (TD-LLMPORTS-TYPED-ERRORS).
 */

import {
  AuthenticationError,
  BadRequestError,
  ContentPolicyViolationError,
  ContextWindowExceededError,
  EmptyResponseError,
  LLMPortError,
  ProviderUnavailableError,
  RateLimitError,
  ServiceUnavailableError,
} from "../errors.js";

/**
 * Extract HTTP status code from an SDK error if present. Provider SDKs
 * (OpenAI, Anthropic, Google Gemini) all expose `.status` on their error
 * classes; fetch-based errors may put it on `.response.status`.
 */
function extractStatus(err: Error): number | undefined {
  const e = err as unknown as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  return e.status ?? e.statusCode ?? e.response?.status;
}

/**
 * Parse a Retry-After header value (seconds or HTTP-date) or
 * retry-after-ms (milliseconds) into milliseconds. Returns undefined when
 * no usable value is present.
 */
function extractRetryAfterMs(err: Error): number | undefined {
  const e = err as unknown as {
    headers?: Record<string, string | undefined>;
    response?: { headers?: Record<string, string | undefined> };
  };
  const headers = e.headers ?? e.response?.headers;
  if (!headers) return undefined;

  // Anthropic exposes both retry-after-ms (preferred) and retry-after.
  const ms = headers["retry-after-ms"];
  if (ms) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const after = headers["retry-after"];
  if (after) {
    const n = Number(after);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    // HTTP-date form: parse and subtract now.
    const dateMs = Date.parse(after);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }
  return undefined;
}

/**
 * Heuristic detector for the two BadRequestError subclasses. Provider error
 * messages are not standardized, but the patterns are well-known across
 * OpenAI, Anthropic, Google, and the OpenAI-compat providers.
 */
function detectBadRequestKind(
  message: string,
): "context-window" | "content-policy" | undefined {
  const m = message.toLowerCase();
  if (
    m.includes("context length") ||
    m.includes("context window") ||
    m.includes("maximum context") ||
    m.includes("tokens in the input") ||
    m.includes("prompt is too long") ||
    m.includes("requested tokens exceed")
  ) {
    return "context-window";
  }
  if (
    m.includes("content policy") ||
    m.includes("content_policy") ||
    m.includes("safety") ||
    m.includes("safety_classifier") ||
    m.includes("flagged by") ||
    m.includes("policy violation")
  ) {
    return "content-policy";
  }
  return undefined;
}

/**
 * Wrap an unknown caught error as a typed framework error.
 *
 * Idempotent on every `LLMPortError` subclass (including subclasses added
 * in alpha.18: `BadRequestError`, `AuthenticationError`, `RateLimitError`,
 * `ServiceUnavailableError`, and their descendants).
 *
 * For raw SDK errors, classifies into the right typed class by HTTP status
 * + message pattern. For non-Error inputs, stringifies first.
 *
 * Adapter authors can opt into more precise typing by extracting their
 * SDK-specific error fields (e.g. OpenAI's `param`, Anthropic's
 * `error.type`) and constructing the typed error directly; this helper is
 * the catch-all fallback when adapters haven't customized.
 */
export function wrapProviderError(alias: string, err: unknown): Error {
  // Pass-through: any LLMPortError subclass is already typed.
  if (err instanceof LLMPortError) return err;

  // Pass-through: ValidationError predates LLMPortError extension; keep
  // by-name check as a safety net for any code paths still constructing
  // it without the base class.
  if (err instanceof Error && err.name === "ValidationError") return err;

  // Stringify non-Error inputs.
  if (!(err instanceof Error)) {
    return new ProviderUnavailableError(alias, new Error(String(err)));
  }

  // Classify by HTTP status when available.
  const status = extractStatus(err);
  const message = err.message ?? String(err);

  if (status === 400) {
    const kind = detectBadRequestKind(message);
    if (kind === "context-window") {
      return new ContextWindowExceededError(
        alias,
        "(unknown)",
        undefined,
        undefined,
        err,
      );
    }
    if (kind === "content-policy") {
      return new ContentPolicyViolationError(alias, "(unknown)", message, err);
    }
    // Generic 400 → BadRequest with raw message.
    return new BadRequestError(alias, message, err);
  }

  if (status === 401 || status === 403) {
    return new AuthenticationError(alias, message, err);
  }

  if (status === 429) {
    const retryAfterMs = extractRetryAfterMs(err);
    return new RateLimitError(alias, message, retryAfterMs, err);
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ServiceUnavailableError(alias, message, err);
  }

  // Unknown / no status → treat as provider unavailable (default behavior
  // matching alpha.17 semantics).
  return new ProviderUnavailableError(alias, err);
}

// Empty response is a typed signal, not an SDK error. Re-export for adapter
// authors who construct it directly.
export { EmptyResponseError };
