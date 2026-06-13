# Migrating from alpha.18 to alpha.19

> **Update (2026-06-12, alpha.19.1).** When alpha.19 shipped, only the type-level shape was wired; the per-mode adapter behaviors and capability pass-through landed in the alpha.19.1 dot-release later the same day. This guide describes the migration path as of alpha.19.1, where the `cacheControl` field is live and verified end-to-end on Anthropic and Google adapters and on every capability factory. Earlier wording that said "per-mode behaviors mature across beta minors" no longer applies; see [`docs/concepts/cache.md`](../concepts/cache.md) for the verified per-adapter behavior matrix.

`alpha.19` ships two breaking changes to lock surfaces that `beta.0` needs to commit. Both are renames or additions; neither changes the routing model, the adapter contract, or any test you wrote against a typed result.

## What changed

### 1. `cost.cacheDiscountUSD` is now `cost.cacheSavingsUSD`

Every result object whose `.cost` previously carried `cacheDiscountUSD` now carries `cacheSavingsUSD`. The semantics are unchanged (USD the caller saved on this call by hitting prompt cache, versus paying the full input rate), and the field is still optional and only set when the provider returned cache telemetry.

The rename is not gradual; the old name does not exist in `alpha.19`. TypeScript will catch every read site; runtime code that hand-rolled a `result.cost.cacheDiscountUSD` reference will resolve to `undefined`.

### 2. `CacheControl` shape is locked

A new optional field on every request option type:

```ts
import type { CacheControl } from "@llm-ports/core";

interface CacheControl {
  mode: "auto" | "manual" | "preCreated" | "off";
  ttlSeconds?: number;
  breakpoints?: Array<{ at: "tools" | "system" | "message-index"; index?: number }>;
  cachedContentHandle?: string;
  namespace?: string;
}
```

Omitting `cacheControl` keeps every adapter at its existing default. Setting `{ mode: "auto" }` is equivalent to omitting it. Per-provider behavior is documented in [docs/concepts/cache.md](../concepts/cache.md).

Per-mode adapter behavior is **live as of alpha.19.1**. The shape itself is stable as of `alpha.19`. Future beta minors will extend behavior (Helicone-style `namespace` proxy header forwarding, Gemini `cachedContents.create()` lifecycle helper) without breaking the shape.

## Update steps

### Step 1: rename every read of `cacheDiscountUSD`

```diff
- if (result.cost.cacheDiscountUSD !== undefined) {
-   metrics.cacheSavings.record(result.cost.cacheDiscountUSD);
- }
+ if (result.cost.cacheSavingsUSD !== undefined) {
+   metrics.cacheSavings.record(result.cost.cacheSavingsUSD);
+ }
```

If you have dashboards keyed on the field name, decide whether to rename the metric or keep emitting both names for a transition window. The library no longer emits the old name; if you keep the old metric, copy the value yourself.

### Step 2 (optional): start using `cacheControl`

If you're on Anthropic and want to influence cache_control placement, set `mode: "manual"` with explicit breakpoints:

```ts
const result = await port.generateText({
  taskType: "summary",
  instructions: longSystemPrompt,
  prompt: shortUserTurn,
  cacheControl: {
    mode: "manual",
    breakpoints: [{ at: "system" }],
    ttlSeconds: 3600,
  },
});
```

If you're on Anthropic, `mode: "auto"` places a `cache_control` marker on the system block when `instructions` is set; `mode: "manual"` honors explicit `breakpoints[]`. If you're on Gemini, `mode: "preCreated"` with a `cachedContentHandle` (from a prior `cachedContents.create()` call) routes to `config.cachedContent` — the cached-content lifecycle helper that wraps the creation flow ships in `@llm-ports/capabilities` in beta.2; until then, callers manage the handle themselves. If you're on OpenAI, every mode is a no-op (the implicit prompt cache is always on with no API to influence it); setting `cacheControl` is forward-compatible and harmless.

If your callers are tenant-aware and you front the provider with Helicone (or another proxy that supports partition keys), set `namespace` to your tenant ID:

```ts
cacheControl: {
  mode: "auto",
  namespace: `tenant:${tenantId}`,
};
```

## What did not change

- Adapter factories, the `Registry`, `createXxxAdapter` signatures, environment variable names, routing tokens.
- The `cacheReadTokens` and `cacheWriteTokens` fields on `TokenUsage`.
- Existing default behavior on every adapter (`alpha.18` callers who omitted `cacheControl` see identical behavior on `alpha.19`).
- Adapter conformance tests (the suite is unchanged).
- The typed error taxonomy shipped in `alpha.18`.

## Release context

This is the third in the four-alpha sequence that locks the public surface before `beta.0`:

- `alpha.17`: `RerankPort` skeleton, jittered backoff config, `onRetry` parity across adapters.
- `alpha.18`: typed error taxonomy (`BadRequestError`, `ContextWindowExceededError`, `ContentPolicyViolationError`, `AuthenticationError`, `RateLimitError(retryAfterMs)`, `ServiceUnavailableError` as base), `errorMatchers` predicates.
- `alpha.19` (this release): `CacheControl` shape locked; `cacheSavingsUSD` rename.
- `alpha.20`: `BudgetScope` (`tenant | customer | user | agent | session`) and minute / session gating tokens.
- `alpha.21`: observability hook signatures (`onCost`, `onTokenUsage`, `onFallback`, `onValidationRetry`, `onCacheHit`) aligned with OpenTelemetry `gen_ai.*` conventions.

`beta.0` follows on `2026-06-30` with the locked surface intact.
