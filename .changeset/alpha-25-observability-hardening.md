---
"@llm-ports/core": patch
"@llm-ports/adapter-openai": patch
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-google": patch
"@llm-ports/adapter-ollama": patch
"@llm-ports/adapter-vercel": patch
"@llm-ports/capabilities": patch
---

Alpha.25 — Observability surface + reliability hardening. Three additive features, zero breaking changes.

**1. `refs?: Record<string, ArtifactRef>` on every call (issue #53).** A consumer-owned, keyed map of artifact references that flows through to every observability event (`onCost`, `onTokenUsage`, `onFallback`, `onCacheHit`, `onValidationRetry`) unchanged. Perfect for prompt versioning, cost attribution by tenant / project / experiment / session, or any versioned-artifact identity you want stamped onto trace. Not validated, not sent to the model, not read by adapters — pure trace metadata.

```ts
import type { ArtifactRef } from "@llm-ports/core";
port.generateStructured({
  taskType: "extract",
  prompt: input,
  schema: MySchema,
  refs: {
    prompt:  { key: "extractor-v3", version: 3, hash: "sha256:..." },
    tenant:  { key: "acme-corp" },
    session: { key: "sess-abc123" },
  },
});
```

**2. `runtimeFallback: "aggressive"` preset (issue #54, LP-REQ-01).** The opinionated classifier three consumers rebuilt by hand (BEPA Plan 29, HomeSignal, SalesCoach Plan 30). Walks the chain on `RateLimitError`, `EmptyResponseError`, `ContextWindowExceededError`, `BadRequestError` matching credit-exhaustion body patterns, and raw 5xx status codes — in addition to the default `ProviderUnavailableError`. Does NOT walk on `AuthenticationError`, generic `BadRequestError`, or `ContentPolicyViolationError`. Exports `aggressiveShouldFallback` and `AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS` for reuse.

```ts
const registry = createRegistryFromEnv({
  adapters: { /* ... */ },
  runtimeFallback: "aggressive", // NEW
});
```

**3. Streamed cost surfacing (issue #55).** `onCost` and `onTokenUsage` now fire once per stream at natural completion for `streamText` and `streamStructured`. Adapter-openai enables it by default via `stream_options: { include_usage: true }`; opt out with `createOpenAIAdapter({ streamUsage: false })` on compat providers that reject the field. Mid-stream errors and consumer-cancelled streams (via `AbortSignal`) do NOT emit — matches the "cost recorded only on success" contract. Other adapters follow in patch releases.

**Test coverage.** 864 tests pass across the workspace (was 828; +36; zero regressions):
- 8 refs tests
- 23 aggressive-fallback tests (positive + negative per error class + Registry integration)
- 5 streamed-cost tests

**Alpha.26 planning.** The next release will be a **BREAKING API unification**: the four generation methods (`generateText` / `generateStructured` / `streamText` / `streamStructured`) will move from `{ instructions, prompt }` to a canonical `messages: LLMMessage[]` input. A `toMessages()` migration shim lands in alpha.26; removal in alpha.27. See the alpha.26 planning discussion for the full plan.

See the [alpha.24 → alpha.25 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-24-to-alpha-25.md) for full details.
