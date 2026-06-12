---
"@llm-ports/core": minor
"@llm-ports/adapter-openai": patch
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-google": patch
"@llm-ports/adapter-ollama": patch
"@llm-ports/adapter-vercel": patch
"@llm-ports/capabilities": patch
---

CacheControl shape commit. **Breaking** in alpha-line surface: `cost.cacheDiscountUSD` is renamed to `cost.cacheSavingsUSD` on every result object. The shape of `CacheControl` is locked so beta.0 ships the right abstraction over the three caching patterns the major providers expose.

This is the third in the four-alpha shape-lock sequence before beta.0. The prior two (alpha.17 RerankPort + BackoffConfig + onRetry parity; alpha.18 typed-error taxonomy) close adapter-shape gaps; this one closes the provider-cache divergence gap. The two remaining alphas (alpha.20 BudgetScope + minute/session gating; alpha.21 observability hook signatures) close budget grammar and telemetry surface.

### New: `CacheControl` shape

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

`cacheControl?` is now an optional field on every request option type: `GenerateTextOptions`, `GenerateStructuredOptions`, `StreamTextOptions`, `StreamStructuredOptions`, `RunAgentOptions`. Omitting it is equivalent to `{ mode: "auto" }`: the adapter does whatever its provider does by default.

The four modes encode the field consensus across the three patterns:

- **`auto`** — let the adapter decide per provider. Right default for most callers.
- **`manual`** — caller supplies explicit `breakpoints` (Anthropic).
- **`preCreated`** — caller supplies a `cachedContentHandle` returned from a prior `createCachedContent` call (Google Gemini).
- **`off`** — caller opts out where the provider allows (Anthropic strips `cache_control` from message blocks).

`namespace` partitions cache lookups by tenant or customer through caching proxies that support partition keys (Helicone's `Cache-Seed` header is the reference pattern).

Per-provider behavior table:

| Mode | Anthropic | OpenAI | Google Gemini |
|---|---|---|---|
| `auto` | place marker at last static block | no-op (implicit cache always on) | no-op |
| `manual` | place markers at supplied breakpoints | no-op | no-op |
| `preCreated` | no-op | no-op | uses `cachedContentHandle` |
| `off` | strip `cache_control` from blocks | no-op (no API) | no-op (no API) |
| `ttlSeconds` | 300 or 3600 | ignored | passed through |

Per-mode adapter behaviors mature across beta minors. The **shape** itself is stable as of alpha.19.

### Breaking change: `cost.cacheDiscountUSD` → `cost.cacheSavingsUSD`

Every result object (`GenerateTextResult`, `GenerateStructuredResult`, `AgentResult`) whose `.cost` previously carried `cacheDiscountUSD` now carries `cacheSavingsUSD`. The semantics are unchanged: USD the caller saved on this call by hitting prompt cache, versus paying the full input rate. The field is still optional and only set when the provider returned cache telemetry (`cacheReadTokens > 0`).

The rename is not gradual. The old name does not exist in alpha.19. TypeScript will catch every read site. Runtime code that hand-rolled a `result.cost.cacheDiscountUSD` reference will resolve to `undefined`.

Rationale: "discount" implied a vendor-applied price reduction (Anthropic's cache_control billing tier, OpenAI's automatic cache). The field is actually the **caller-visible** dollar amount they did not pay. OpenInference's emerging `llm.cost.cache_savings` convention and Helicone's dashboard vocabulary already use "savings" for the same concept. Aligning the field name removes a small wrong implication and makes the cross-tool wire-up trivial.

### Migration

See `docs/migration/alpha-18-to-alpha-19.md` for the step-by-step. Summary:

```diff
- if (result.cost.cacheDiscountUSD !== undefined) {
-   metrics.cacheSavings.record(result.cost.cacheDiscountUSD);
- }
+ if (result.cost.cacheSavingsUSD !== undefined) {
+   metrics.cacheSavings.record(result.cost.cacheSavingsUSD);
+ }
```

Optionally start setting `cacheControl` on requests; Anthropic users get `mode: "manual"` breakpoint placement, OpenAI users get a `namespace` partition forwarded through proxies, Google users get `mode: "preCreated"` cached-content handles. Adapters that don't act on the field today still accept it without crashing, so setting it now is forward-compatible.

### Test stats

626 tests passing across the workspace (up from 615 in alpha.18). 11 new tests in `packages/core/tests/cache-control.test.ts` cover the shape lock and the field rename. Two existing cost tests updated to the new field name.

### Docs

- New: `docs/concepts/cache.md` — locked shape, per-provider behavior, when fields are honored vs ignored.
- New: `docs/migration/alpha-18-to-alpha-19.md` — migration steps + breaking-change disclosure.
- Updated: `docs/v0-1-status.md` — alpha.19 row added to closed-issues table.

### What did not change

- Adapter factories, the `Registry`, `createXxxAdapter` signatures, environment variable names, routing tokens.
- `TokenUsage.cacheReadTokens` and `TokenUsage.cacheWriteTokens`.
- Existing default behavior on every adapter (alpha.18 callers who omitted `cacheControl` see identical behavior on alpha.19).
- Adapter conformance test suite (unchanged).
- The typed error taxonomy from alpha.18.
