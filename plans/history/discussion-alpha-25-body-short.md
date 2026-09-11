**Released 2026-07-02.** Install: `pnpm add @llm-ports/core@alpha @llm-ports/adapter-openai@alpha`

Three additive features under one release theme: "Observability surface + reliability hardening." Zero breaking changes.

## In this release

### 1. `refs?: Record<string, ArtifactRef>` on every call (#53)

Consumer-owned, keyed map of artifact references that flows through to every observability event (`onCost`, `onTokenUsage`, `onFallback`, `onCacheHit`, `onValidationRetry`) unchanged. For prompt versioning, tenant / experiment attribution, session correlation.

```ts
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

Not validated, not sent to the model, not read by adapters — pure trace metadata.

### 2. `runtimeFallback: "aggressive"` preset (#54, LP-REQ-01)

Three consumers rebuilt the same classifier by hand. Now a preset:

```ts
const registry = createRegistryFromEnv({
  adapters: { /* ... */ },
  runtimeFallback: "aggressive",
});
```

Walks on `RateLimitError`, `EmptyResponseError`, `ContextWindowExceededError`, `BadRequestError` matching credit-exhaustion body patterns, and raw 5xx codes — in addition to the default `ProviderUnavailableError`. NOT on `AuthenticationError` or generic `BadRequestError`.

Classifier exported for composition: `import { aggressiveShouldFallback } from "@llm-ports/core"`.

### 3. Streamed cost surfacing (#55)

`onCost` and `onTokenUsage` now fire once per stream at natural completion for `streamText` and `streamStructured`. Adapter-openai enabled by default via `stream_options: { include_usage: true }`; opt out with `createOpenAIAdapter({ streamUsage: false })`. Other adapters follow in patch releases.

```ts
for await (const chunk of registry.getPort().streamText({
  taskType: "chat",
  prompt: "hello",
  refs: { session: { key: "sess-abc123" } },
})) {
  ui.append(chunk);
}
// onCost + onTokenUsage fired once at completion with refs preserved.
```

Mid-stream errors and consumer-cancelled streams do NOT emit — matches the "cost recorded only on success" contract.

## Tests

- 8 refs tests
- 23 aggressive-fallback tests (positive + negative per error class + Registry integration)
- 5 streamed-cost tests
- **864 total (was 828; +36; 0 regressions)**

## Backwards compatibility

All three features are opt-in. Existing code compiles and runs unchanged.

## ⚠️ Coming next: alpha.26 is BREAKING

The next release will unify the port input around a canonical `messages: LLMMessage[]` field, deprecating `{ instructions, prompt }` on `generateText` / `generateStructured` / `streamText` / `streamStructured`. A one-cycle deprecation window is planned with a `toMessages()` migration shim.

See the **[alpha.26 planning discussion](https://github.com/baabakk/llm-ports/discussions)** for the full plan and to weigh in on any open design questions before implementation begins.

---

[Full release notes](https://github.com/baabakk/llm-ports/releases/tag/v0.1.0-alpha.25) | [alpha.24 → alpha.25 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-24-to-alpha-25.md) | [Observability concept](https://github.com/baabakk/llm-ports/blob/main/docs/concepts/observability.md)
