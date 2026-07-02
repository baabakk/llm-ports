/**
 * Typed error taxonomy for @llm-ports.
 *
 * Designed for typed-error-driven failover (alpha.18+). Consumers declare
 * which error classes route to which fallback chains rather than string-
 * matching error messages. The shape matches the field consensus that
 * emerged across LiteLLM, Pydantic AI, LangChain, Portkey, and Genkit;
 * LiteLLM's 11-class taxonomy is the closest analogue.
 *
 * Hierarchy (alpha.18):
 *
 *   LLMPortError                                  // common base for instanceof checks
 *   ├── BadRequestError                           // 400-class root (client-fixable)
 *   │   ├── ContextWindowExceededError            // prompt too long for model
 *   │   └── ContentPolicyViolationError           // content filter rejected the request
 *   ├── AuthenticationError                       // 401/403 (NOT retryable to same provider)
 *   ├── RateLimitError                            // 429 with optional retryAfterMs
 *   ├── BudgetExceededError                       // port-internal cap exhausted
 *   ├── SessionBudgetExceededError                // CostSession budget exhausted
 *   ├── ServiceUnavailableError                   // 503 root (transient)
 *   │   ├── ProviderUnavailableError              // SDK error or unreachable; route to fallback
 *   │   └── EmptyResponseError                    // model returned empty visible text
 *   ├── NoProvidersAvailableError                 // entire chain exhausted
 *   ├── ValidationError                           // structured-output Zod failure
 *   ├── ContentBlockUnsupportedError              // block kind unknown to adapter
 *   ├── ConfigError                               // env/config malformed
 *   ├── ImageTooLargeError                        // image over per-provider byte limit
 *   └── InvalidImageUrlError                      // image URL form invalid
 *
 * Breaking changes vs alpha.17:
 *
 *   - `ContextWindowExceededError` is NEW. Previously the underlying provider
 *     SDK threw a generic 400, which got wrapped as `ProviderUnavailableError`.
 *     With the new taxonomy it's parented under `BadRequestError`. Consumers
 *     branching on `instanceof ProviderUnavailableError` after a context-window
 *     overflow will need to add `instanceof BadRequestError` to their handlers.
 *
 *   - `ContentPolicyViolationError` is NEW. Same shape change.
 *
 *   - `ServiceUnavailableError` is NEW. `ProviderUnavailableError` and
 *     `EmptyResponseError` are reparented under it. Existing `instanceof
 *     ProviderUnavailableError` checks continue to work; new `instanceof
 *     ServiceUnavailableError` checks catch both.
 *
 *   - `AuthenticationError` is NEW. Previously 401/403 errors were wrapped as
 *     `ProviderUnavailableError`, which is wrong because they're not transient
 *     and shouldn't trigger same-provider retries.
 *
 *   - `RateLimitError` is NEW. Previously 429 errors were wrapped as
 *     `ProviderUnavailableError`, which lost the `retryAfterMs` information.
 *
 *   - `LLMPortError` is NEW. All errors thrown by this library extend it.
 *     Use `e instanceof LLMPortError` to catch any library error;
 *     `errorMatchers.all` does this for fallback predicates.
 */

import type { ZodIssue } from "zod";

/**
 * Common base class for every error thrown by this library. Useful for
 * blanket catches: `try { ... } catch (e) { if (e instanceof LLMPortError)
 * { /* library error *\/ } }`. Direct subclass of `Error`, so existing
 * `instanceof Error` checks continue to work.
 */
export class LLMPortError extends Error {
  public override readonly name: string = "LLMPortError";
}

// ─── 400-class (client-fixable; do NOT retry the same request) ────────

/**
 * 400-class root. Indicates the request itself is malformed, too large, or
 * policy-violating. Adapters should NOT include this in default fallback
 * chains: another provider will reject the same request the same way.
 *
 * Use `LiteLLM`-style explicit `context_window_fallbacks` /
 * `content_policy_fallbacks` chains to handle 400s by routing to a model
 * with a larger window or more permissive policy.
 */
export class BadRequestError extends LLMPortError {
  public override readonly name: string = "BadRequestError";
  constructor(
    public readonly alias: string,
    message: string,
    public override readonly cause?: Error,
  ) {
    super(`Provider "${alias}": ${message}`);
  }
}

/**
 * Thrown when the prompt + tools + system content exceeds the model's
 * context window. Subclass of `BadRequestError`: fallback to another
 * provider with the same window will fail the same way. Route to a
 * larger-window model explicitly.
 */
export class ContextWindowExceededError extends BadRequestError {
  public override readonly name: string = "ContextWindowExceededError";
  constructor(
    alias: string,
    public readonly modelId: string,
    public readonly contextLimit?: number,
    public readonly observedTokens?: number,
    cause?: Error,
  ) {
    const detail =
      contextLimit !== undefined && observedTokens !== undefined
        ? ` (~${observedTokens} tokens; model limit ${contextLimit})`
        : "";
    super(
      alias,
      `context window exceeded for model "${modelId}"${detail}`,
      cause,
    );
  }
}

/**
 * Thrown when the provider's content filter / safety classifier rejected
 * the request. Not retryable on the same provider's same policy; may
 * succeed on a provider with different policy thresholds.
 */
export class ContentPolicyViolationError extends BadRequestError {
  public override readonly name: string = "ContentPolicyViolationError";
  constructor(
    alias: string,
    public readonly modelId: string,
    public readonly policyDetails?: string,
    cause?: Error,
  ) {
    super(
      alias,
      policyDetails
        ? `content policy violation on model "${modelId}": ${policyDetails}`
        : `content policy violation on model "${modelId}"`,
      cause,
    );
  }
}

// ─── 401/403 (NOT retryable to same provider) ─────────────────────────

/**
 * Thrown when the provider rejected the request as unauthenticated or
 * forbidden. Not transient: retrying the same call against the same
 * provider with the same credential will fail again. Adapters should
 * NOT include this in default fallback chains; the credential needs to
 * be fixed externally.
 */
export class AuthenticationError extends LLMPortError {
  public override readonly name: string = "AuthenticationError";
  constructor(
    public readonly alias: string,
    message: string,
    public override readonly cause?: Error,
  ) {
    super(`Provider "${alias}" auth failed: ${message}`);
  }
}

// ─── 429 (rate limited; may be retryable after a delay) ───────────────

/**
 * Thrown when the provider returned HTTP 429 (rate limited). When the
 * provider supplies a `Retry-After` or `retry-after-ms` header, the
 * adapter parses it and exposes it as `retryAfterMs`. Fallback chains
 * SHOULD honor this delay (planned for alpha.21+) and demote the alias
 * for exactly that duration rather than guessing with exponential
 * backoff.
 */
export class RateLimitError extends LLMPortError {
  public override readonly name: string = "RateLimitError";
  constructor(
    public readonly alias: string,
    message: string,
    public readonly retryAfterMs?: number,
    public override readonly cause?: Error,
  ) {
    super(`Provider "${alias}" rate limited: ${message}`);
  }
}

// ─── Budget / session (port-internal, not provider-side) ──────────────

/**
 * Thrown when a provider's request budget (count or USD) is exhausted.
 * Distinct from a provider-side 429: this is the local registry's
 * `cost:N/day` or `req:N/hour` gating, evaluated BEFORE the provider call.
 */
export class BudgetExceededError extends LLMPortError {
  public override readonly name: string = "BudgetExceededError";
  constructor(
    public readonly alias: string,
    public readonly limit: number,
    public readonly current: number,
    public readonly gatingKind: "requests" | "cost",
  ) {
    super(
      `Budget exceeded for provider "${alias}" (${gatingKind}): ${current} > ${limit}`,
    );
  }
}

/**
 * Thrown when an active CostSession exceeds its USD budget. Distinct from
 * `BudgetExceededError` (which gates per-provider hour/day/month) so call
 * sites can recover differently: typically by closing the session and
 * informing the user, not by routing to a fallback provider.
 *
 * Use case: continuous screen-capture loops where one stuck-open window
 * could otherwise burn arbitrary dollars overnight. The session-scoped
 * cap is a hard backstop independent of the per-provider gates.
 */
export class SessionBudgetExceededError extends LLMPortError {
  public override readonly name: string = "SessionBudgetExceededError";
  /**
   * Optional reason tag distinguishing which session-grain cap tripped
   * (e.g. `"tokens (50000 >= 50000)"`, `"tool_calls (8 >= 8)"`,
   * `"requests (100 >= 100)"`). When undefined the default USD cap
   * tripped. (alpha.20+)
   */
  public readonly grain?: string;
  /**
   * Backwards-compatible constructor. The first three args are the legacy
   * USD-cap shape; pass a fourth `grain` string when the cap that tripped
   * is one of the alpha.20+ token / tool_call / request session ceilings.
   * `budgetUSD` and `spentUSD` are repurposed as `cap` and `current` in
   * that case so the existing fields keep working for diagnostics.
   */
  constructor(
    public readonly sessionId: string,
    public readonly budgetUSD: number,
    public readonly spentUSD: number,
    grain?: string,
  ) {
    super(
      grain
        ? `Cost session "${sessionId}" exceeded its ${grain} cap`
        : `Cost session "${sessionId}" exceeded its budget: $${spentUSD.toFixed(6)} > $${budgetUSD.toFixed(6)}`,
    );
    if (grain) this.grain = grain;
  }
}

// ─── 503-class root (transient; safe to retry / failover) ─────────────

/**
 * Root of the transient-failure tier (HTTP 502/503/504, network resets,
 * provider-side overload). Adapters should include this in default
 * fallback chains: another provider may serve the same request fine.
 */
export class ServiceUnavailableError extends LLMPortError {
  public override readonly name: string = "ServiceUnavailableError";
  constructor(
    public readonly alias: string,
    message: string,
    public override readonly cause?: Error,
  ) {
    super(`Provider "${alias}" service unavailable: ${message}`);
  }
}

/**
 * Thrown when a configured provider is unreachable, returned a non-typed
 * error, or is misconfigured. Subclass of `ServiceUnavailableError` so
 * the default fallback predicate routes it to the next provider.
 *
 * Reparenting note: in alpha.17 this extended `Error` directly. In alpha.18
 * it extends `ServiceUnavailableError`. Existing `instanceof
 * ProviderUnavailableError` checks continue to work.
 */
export class ProviderUnavailableError extends ServiceUnavailableError {
  public override readonly name: string = "ProviderUnavailableError";
  constructor(
    alias: string,
    cause: Error,
  ) {
    super(alias, cause.message, cause);
  }
}

/**
 * Thrown by adapters when a model returns an empty/whitespace-only response
 * where one is structurally required (e.g. generateStructured needs JSON to
 * parse). Carries the model id + provider alias so the registry can route
 * to a fallback. Common cause: reasoning models that spent the entire output
 * budget on hidden reasoning tokens and produced no visible text.
 *
 * Reparenting note: in alpha.17 this extended `Error` directly. In alpha.18
 * it extends `ServiceUnavailableError` so fallback predicates treat it as
 * a transient failure.
 */
export class EmptyResponseError extends ServiceUnavailableError {
  public override readonly name: string = "EmptyResponseError";
  constructor(
    alias: string,
    public readonly modelId: string,
    public readonly hint?: string,
  ) {
    const msg = hint
      ? `empty response for model "${modelId}". ${hint}`
      : `empty response for model "${modelId}".`;
    super(alias, msg);
  }
}

// ─── Chain-level + other typed errors ─────────────────────────────────

/**
 * Thrown when every provider in the task's fallback chain has been attempted
 * and none succeeded (each either errored, was budget-blocked, or was missing).
 */
export class NoProvidersAvailableError extends LLMPortError {
  public override readonly name: string = "NoProvidersAvailableError";
  constructor(
    public readonly taskType: string,
    public readonly attempted: string[],
    public readonly reasons: Record<string, string>,
  ) {
    super(
      `No providers available for task "${taskType}". Attempted: ${attempted.join(", ")}`,
    );
  }
}

/** Thrown by validation strategies when generated structured output fails schema. */
export class ValidationError extends LLMPortError {
  public override readonly name: string = "ValidationError";
  constructor(
    public readonly issues: ZodIssue[],
    public readonly attempts: number,
  ) {
    const summary = issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    super(`Validation failed after ${attempts} attempt(s): ${summary}`);
  }
}

/** Thrown when a content block kind is sent to an adapter that does not support it. */
export class ContentBlockUnsupportedError extends LLMPortError {
  public override readonly name: string = "ContentBlockUnsupportedError";
  constructor(
    public readonly adapter: string,
    public readonly blockType: string,
  ) {
    super(`Adapter "${adapter}" does not support content block type "${blockType}"`);
  }
}

/** Thrown by the registry when env config is malformed. */
export class ConfigError extends LLMPortError {
  public override readonly name: string = "ConfigError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown by adapters when an image content block exceeds the provider's
 * per-image byte limit. Caught at the adapter boundary BEFORE the SDK call,
 * so the caller sees a typed error instead of an opaque 413/400 wrapped as
 * ProviderUnavailableError.
 *
 * Each adapter knows its own default limit (Anthropic 5MB, OpenAI 20MB,
 * Ollama model-dependent), and the limit can be overridden per-adapter at
 * port creation via `imageSizeLimitBytes`.
 *
 * `imageIndex` is the 0-indexed position of the offending image in the
 * caller's `prompt` ContentBlock[] array.
 */
export class ImageTooLargeError extends LLMPortError {
  public override readonly name: string = "ImageTooLargeError";
  constructor(
    public readonly alias: string,
    public readonly imageIndex: number,
    public readonly byteSize: number,
    public readonly limitBytes: number,
  ) {
    super(
      `Image at index ${imageIndex} is ${byteSize} bytes; exceeds the ${limitBytes}-byte limit for provider "${alias}".`,
    );
  }
}

/**
 * Thrown by adapters when an image content block's URL form is malformed:
 * `file://` scheme, `data:` URI passed as `kind: "url"` instead of base64,
 * or a URL with no scheme. Caught at the adapter boundary BEFORE the SDK call.
 */
export class InvalidImageUrlError extends LLMPortError {
  public override readonly name: string = "InvalidImageUrlError";
  constructor(
    public readonly alias: string,
    public readonly url: string,
    public readonly reason: string,
  ) {
    super(`Invalid image URL for provider "${alias}": ${reason}. URL: ${url.slice(0, 100)}`);
  }
}

// ─── errorMatchers helper (typed-error-driven failover predicates) ────

/**
 * Predicates for typed-error-driven fallback. Pass one of these as the
 * `shouldFallback` argument when configuring per-call or registry-level
 * `runtimeFallback` (planned alpha.21 surface) instead of writing inline
 * `instanceof` chains or string-match checks.
 *
 * Semantics:
 *   - `rateLimit`: true only for `RateLimitError`. Use when you want to
 *     fall back ONLY on 429.
 *   - `transient`: true for `RateLimitError` and any `ServiceUnavailableError`
 *     subclass (including `ProviderUnavailableError` and `EmptyResponseError`).
 *     Use for the conservative "retry on network-level transients" policy.
 *   - `default`: true for any `LLMPortError` EXCEPT `BadRequestError`
 *     subclasses (`ContextWindowExceededError`, `ContentPolicyViolationError`)
 *     and `AuthenticationError`. Use for the "fall back on anything not
 *     client-fixable" policy. This is the recommended default.
 *   - `all`: true for any `LLMPortError`. Use when you want to fall back
 *     on every library error, including client-fixable ones (rarely
 *     correct, but offered for completeness).
 */
export const errorMatchers = {
  rateLimit: (e: unknown): boolean => e instanceof RateLimitError,
  transient: (e: unknown): boolean =>
    e instanceof RateLimitError || e instanceof ServiceUnavailableError,
  default: (e: unknown): boolean =>
    e instanceof LLMPortError &&
    !(e instanceof BadRequestError) &&
    !(e instanceof AuthenticationError),
  all: (e: unknown): boolean => e instanceof LLMPortError,
};

// ─── Aggressive fallback classifier (alpha.25+, LP-REQ-01) ────────────

/**
 * Body-pattern list for credit-exhaustion / account-issue 400s. Matched
 * case-insensitively against `error.message` on a `BadRequestError`.
 * Expanded conservatively: the intent is "the account cannot serve ANY
 * call right now"; genuinely malformed requests (invalid parameter,
 * schema failure) fail identically on every provider and MUST NOT walk
 * the chain.
 *
 * Exported so consumers who want to extend this list (uncommon) or run
 * the same matcher outside the fallback path can reuse the canonical
 * regex set.
 */
export const AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS: readonly RegExp[] = [
  /credit balance is too low/i,
  /insufficient (funds|credit|quota|balance)/i,
  /account (disabled|suspended|deactivated|closed)/i,
  /billing/i,
  /exceeded your current quota/i,
  /out of credits/i,
  /payment required/i,
  /organization has been (deactivated|disabled)/i,
];

/**
 * The opinionated classifier bundled with `RegistryOptions.runtimeFallback:
 * "aggressive"`. Walks the provider chain on any provider-side signal that
 * means "try a different provider" — not just the narrow default of
 * `ProviderUnavailableError`.
 *
 * Bundled empirically after BEPA (Plan 29), HomeSignal, and SalesCoach
 * (Plan 30 §R2 + §5.4) each rebuilt the same classifier by hand. The
 * common thread: the default `runtimeFallback: "default"` only walks on
 * `ProviderUnavailableError`, which let credit-exhaustion 400s and
 * empty-response 200s abort the chain in production and caused hours-long
 * outages before the consumer patched their own classifier.
 *
 * Walks on:
 *   1. `ProviderUnavailableError` — the default (5xx, network, generic).
 *   2. `RateLimitError` — try the next provider immediately, don't wait
 *      out the retry-after backoff on this one.
 *   3. `EmptyResponseError` — the adapter's own retries gave up; a
 *      different provider may not exhibit the pattern.
 *   4. `ContextWindowExceededError` — this provider can't handle the
 *      input; try a provider with a larger window.
 *   5. `BadRequestError` matching credit-exhaustion / account body
 *      patterns (see {@link AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS}).
 *   6. Any raw error with `status >= 500` (defensive for adapters that
 *      don't wrap 5xx as `ProviderUnavailableError`).
 *
 * Does NOT walk on:
 *   - `AuthenticationError` (401/403 — credential needs to be fixed).
 *   - Generic `BadRequestError` (malformed request — would fail everywhere).
 *   - `ContentPolicyViolationError` (content-filter — separate concern).
 *   - `BudgetExceededError` / `SessionBudgetExceededError` (port-internal
 *     gating; walking would defeat the gate).
 *   - `NoProvidersAvailableError` (chain-level; nothing more to try).
 *   - Errors that aren't `LLMPortError` and don't look like a 5xx.
 *
 * Composability: consumers who want everything this classifier does PLUS
 * one extra condition can wrap it inline (`(e) => aggressiveShouldFallback(e)
 * || myExtraCheck(e)`). Consumers who want to disable one of these
 * categories can wrap and short-circuit similarly.
 */
export function aggressiveShouldFallback(err: unknown): boolean {
  // 1. Existing default (ProviderUnavailableError; covers 5xx via SDK wrap
  //    and any other unknown-provider-error surface).
  if (err instanceof ProviderUnavailableError) return true;

  // 2. Rate limits — try the next provider rather than waiting out backoff.
  if (err instanceof RateLimitError) return true;

  // 3. Empty responses after starvation retries gave up.
  if (err instanceof EmptyResponseError) return true;

  // 4. Context window exceeded — try a larger-window provider.
  if (err instanceof ContextWindowExceededError) return true;

  // 5. Credit exhaustion / account-issue 400s. Match against the message
  //    body patterns; genuine malformed-request 400s don't match and
  //    correctly do NOT walk the chain.
  if (err instanceof BadRequestError) {
    // ContextWindowExceededError already handled in (4). This branch is
    // for the OTHER BadRequestError shapes.
    if (err instanceof ContextWindowExceededError) return true;
    const message = String((err as Error).message ?? "");
    for (const pattern of AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS) {
      if (pattern.test(message)) return true;
    }
    return false;
  }

  // 6. Raw 5xx (defensive check for adapters that don't wrap 5xx as
  //    ProviderUnavailableError). Guards against duck-typed status fields.
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number" &&
    (err as { status: number }).status >= 500
  ) {
    return true;
  }

  return false;
}
