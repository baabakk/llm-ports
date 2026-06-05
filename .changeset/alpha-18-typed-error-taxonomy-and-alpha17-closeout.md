---
"@llm-ports/core": minor
"@llm-ports/adapter-openai": patch
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-google": patch
"@llm-ports/adapter-ollama": patch
"@llm-ports/adapter-vercel": patch
"@llm-ports/capabilities": patch
---

Typed-error taxonomy commit. **Breaking** in alpha-line surface: `ContextWindowExceededError` no longer matches `instanceof ProviderUnavailableError`; 5xx errors now classify to `ServiceUnavailableError` (the typed base) rather than `ProviderUnavailableError` (which is now reserved for unknown-status fallbacks).

This is the largest single correctness fix in the v0.1 line. The change closes the architectural bug named in the BEPA-internal master plan: previously, a 400 context-window overflow was wrapped as `ProviderUnavailableError`, which caused the registry to fall back to another provider that would fail the same way. The new taxonomy correctly classifies 400-class errors as `BadRequestError` subclasses so consumers can route them to a larger-window model explicitly rather than retrying blindly.

### New typed-error hierarchy

```
LLMPortError                                  // common base for instanceof checks
├── BadRequestError                           // 400-class root (client-fixable)
│   ├── ContextWindowExceededError            // prompt too long for model
│   └── ContentPolicyViolationError           // content filter rejected the request
├── AuthenticationError                       // 401/403 (NOT retryable to same provider)
├── RateLimitError                            // 429 with optional retryAfterMs
├── BudgetExceededError                       // port-internal cap exhausted (unchanged)
├── SessionBudgetExceededError                // CostSession exhausted (unchanged)
├── ServiceUnavailableError                   // 503 root (transient)
│   ├── ProviderUnavailableError              // SDK error or unreachable; reparented
│   └── EmptyResponseError                    // model returned empty visible text; reparented
├── NoProvidersAvailableError                 // entire chain exhausted (unchanged)
├── ValidationError                           // structured-output Zod failure (unchanged)
├── ContentBlockUnsupportedError              // unchanged
├── ConfigError                               // unchanged
├── ImageTooLargeError                        // unchanged
└── InvalidImageUrlError                      // unchanged
```

All classes now extend `LLMPortError` (which extends `Error`). Use `e instanceof LLMPortError` to catch any library error.

### New typed-error matchers

```ts
import { errorMatchers } from "@llm-ports/core";

// Field consensus (matches LiteLLM content_policy_fallbacks / context_window_fallbacks pattern)
errorMatchers.rateLimit(e);   // RateLimitError only
errorMatchers.transient(e);   // RateLimitError + ServiceUnavailableError subclasses
errorMatchers.default(e);     // Anything except BadRequest + Authentication (recommended)
errorMatchers.all(e);         // Every LLMPortError subclass
```

### `wrapProviderError` now classifies HTTP-shaped SDK errors

The shared helper detects status codes and message patterns and produces the right typed class:

```
status 400 + "context length" / "tokens" message → ContextWindowExceededError
status 400 + "content policy" / "safety" message → ContentPolicyViolationError
status 400 + other                               → BadRequestError
status 401 / 403                                 → AuthenticationError
status 429 + Retry-After header                  → RateLimitError(retryAfterMs)
status 500 / 502 / 503 / 504                     → ServiceUnavailableError
no status (network reset, parse error, etc.)     → ProviderUnavailableError (fallback)
```

`Retry-After-Ms` (Anthropic) and `Retry-After` (seconds or HTTP-date) are parsed.

### Breaking change disclosure

Consumers branching on `instanceof ProviderUnavailableError` after a 5xx SDK error will need to update to `instanceof ServiceUnavailableError` (or check both). Consumers branching after a 400 context-window error will need to check `instanceof BadRequestError` or `instanceof ContextWindowExceededError` rather than `instanceof ProviderUnavailableError`. Consumers branching after a 401 will need `instanceof AuthenticationError`.

This is the breakage the master plan deliberately surfaced in alpha (not beta).

### alpha.17 close-out items rolled in

Per `TD-LLMPORTS-ALPHA17-CLOSEOUT`:

1. **`packages/adapter-ollama/tests/quirks/on-retry-hook.test.ts`** — 5 tests verifying `onRetry` fires for the validation-feedback retry path with the right shape, that hook errors don't cancel the retry, and that async hooks work fire-and-forget.

2. **`packages/adapter-google/tests/quirks/on-retry-hook.test.ts`** — 4 tests with the same shape for adapter-google.

3. **`docs/v0-1-status.md`** — closed-issues table gains 4 rows for alpha.17 + alpha.18 items (RerankPort skeleton, BackoffConfig, onRetry parity, typed-error taxonomy with breaking-change call-out).

4. **`docs/adapters/google.md`** — new `onRetry?: OnRetry` documented with a Langfuse / Phoenix wiring example.

5. **`docs/adapters/ollama.md`** — same documentation pattern.

6. **`packages/adapter-google/README.md`** — Supported features table gains the onRetry hook row.

7. **`packages/adapter-ollama/README.md`** — same.

### Test stats

615 tests passing across the workspace (up from 577 in alpha.17). 29 new error-taxonomy tests + 5 ollama onRetry hook tests + 4 google onRetry hook tests. Several alpha.17-era adapter-openai tests updated to assert the new typed classes (4 quirks files).
