---
"@llm-ports/core": minor
---

Adds `RegistryOptions.perAttemptTimeoutMs` (alpha.23+) and extends `RetryReason` with two new discriminators for the alpha.23 adapter-openai rescue paths.

## `RegistryOptions.perAttemptTimeoutMs`

When set, every provider attempt inside `walkChain` is wrapped in an `AbortController` + timer. On timeout, the abort propagates to the adapter's HTTP client; the adapter throws `ProviderUnavailableError`; the Registry's `shouldFallback` catches it and walks to the next provider with a fresh timer.

```ts
const registry = createRegistryFromEnv({
  env: process.env,
  adapters: { /* ... */ },
  perAttemptTimeoutMs: 30000, // 30s cap per provider
});
```

**Per-attempt (not chain-wide).** Each provider gets its own budget. A 30s timeout against a 3-provider chain caps total wall-clock at ~90s, but any single provider can't exceed 30s. Critical for routing around reasoning models that grind on hidden chain-of-thought without erroring.

**Composes with caller-supplied `signal`.** BOTH the timeout and the caller's abort fire the same wrapped controller; the shorter trigger wins. When `perAttemptTimeoutMs` is undefined AND there's no user signal, the wrapper is a pass-through (no AbortController created).

**Empirical motivation:** ADW production wedge 2026-06-19T15:40 UTC — mimo-parasail hit reasoning-starvation, retry expanded budget, model grinded silently for 3+ minutes with no timeout/failover. The AbortSignal infrastructure was already in place; this helper makes the per-attempt timeout pattern ergonomic.

## `RetryReason` extension

Two new discriminator values added to the existing `RetryReason` union:

- `"harmony-tool-call-extracted"` — adapter recovered a tool call from a harmony `message.reasoning_content` channel that the standard `tool_calls` array missed (observability only; no retry was performed)
- `"zero-tool-call-prose-retry"` — adapter retried with a corrective system message after the model emitted prose without making any tool call despite tools being available

Used by `@llm-ports/adapter-openai@0.1.0-alpha.23+` in its ASK 1 and ASK 2 paths. Consumers wanting to distinguish "was rescued" from "clean zero-output" can filter the existing adapter `onRetry` hook on these reason values.

## Tests

- 8 new core tests for `perAttemptTimeoutMs` (hanging provider falls back, fast provider passes through, no timeout = backwards-compat, user signal composes, NOT chain-wide, emits `onFallback` correctly, public field exposure)
- 295 core tests pass total (was 287; +8, 0 regressions)
