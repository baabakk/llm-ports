# Migrating from alpha.20 (or alpha.20.1) to alpha.21

> **Zero breaking changes — runtime AND type-level.** alpha.21 is fully additive. Existing code compiles and runs without modification. This page is the upgrade reference for the two new public-API surfaces worth knowing about.

## Install

```bash
pnpm add @llm-ports/core@alpha @llm-ports/adapter-openai@alpha @llm-ports/capabilities@alpha
```

## What was added

### 1. Per-call `strict?: boolean` on structured-output options

New optional field on `GenerateStructuredOptions` and `StreamStructuredOptions`:

```ts
interface GenerateStructuredOptions<T> {
  // ...existing fields unchanged...

  /**
   * Per-call override for strict-schema response_format mode. (alpha.21+)
   *   - true       → force strict json_schema for this call
   *   - false      → force json_object for this call
   *   - undefined  → use the adapter's existing default
   */
  strict?: boolean;
}
```

Precedence: per-call > adapter-level (`useStrictResponseFormat`) > auto-detect.

The 5 structured-output capability factories (`createClassifier`, `createScorer`, `createExtractor`, `createAnalyzer`, `createPlanner`) accept and forward the field on their per-call input shape.

Adapters that don't implement strict mode silently ignore the hint.

**When to use it.** Registries with one adapter alias per provider where the caller knows the schema shape (closed → strict, `z.record(...)` → json_object). See [Validation Strategies → Per-call strict-mode override](/concepts/validation-strategies#per-call-strict-mode-override-alpha-21).

### 2. `observability` bundle on `RegistryOptions`

Five fire-and-forget hooks aligned with [OpenTelemetry's `gen_ai.*` semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):

```ts
const registry = createRegistryFromEnv({
  // ...existing options unchanged...
  observability: {
    onCost:            (e) => { /* per-call USD breakdown */ },
    onTokenUsage:      (e) => { /* per-call token counts */ },
    onFallback:        (e) => { /* chain advancement */ },
    onCacheHit:        (e) => { /* cached_tokens > 0 */ },
    onValidationRetry: (e) => { /* type-only in alpha.21 */ },
  },
});
```

All five fields are independently optional. Hook errors are swallowed (instrumentation can't break inference).

**Emission coverage in alpha.21**: `onCost`, `onTokenUsage`, `onCacheHit`, `onFallback` are emitted by the Registry. `onValidationRetry` is type-only — use the adapter `onRetry` hook with `reason === "validation-feedback"` for that signal today; Registry-level emission is the alpha.22 follow-up. Stream methods don't emit cost yet (also alpha.22).

Full reference: [Observability hooks concept](/concepts/observability).

### 3. DeepInfra + Parasail strict-mode allowlist

`autoDetectStrictResponseFormat` now defaults strict ON for `api.deepinfra.com` and `api.parasail.io` baseURLs. New adapters constructed against these endpoints default to strict mode without explicit configuration. See the [openai adapter docs](/adapters/openai#auto-detection-alpha-14).

### 4. Three bundled compat-provider pricing entries

`OPENAI_PRICING` now includes `deepseek-ai/DeepSeek-V4-Flash`, `google/gemma-4-31B-it`, and `XiaomiMiMo/MiMo-V2.5`. Consumers using these models against the OpenAI-compat adapter no longer need to maintain a parallel `pricingOverrides` table. See the [openai adapter bundled pricing](/adapters/openai#curated-compat-provider-entries-alpha-21).

## What did NOT change

- Public type shape (`BudgetLimit`, `CostUsage`, `TokenUsage`, `CacheControl`, `BudgetScope`, every existing port interface) is unchanged.
- Runtime behavior of every existing call path is unchanged.
- Default values for `useStrictResponseFormat` on already-allowlisted baseURLs (OpenAI native, Cerebras, Groq, SambaNova) are unchanged.
- Adapter `onRetry` hook contract is unchanged.

## Should you do anything?

If you're upgrading from alpha.20.1 with no changes, nothing breaks. Pick from these on your own schedule:

| If you want… | Do this |
|---|---|
| ADW-style per-call strict at the wrapper layer | Pass `strict: true` to your closed-shape `llmClassify` / `llmScore` / `llmExtract` calls; leave undefined for `z.record`-bearing schemas |
| OTel-aligned observability | Add `observability` to `createRegistryFromEnv` with the hooks your downstream pipeline needs |
| DeepInfra / Parasail strict default | Just upgrade — auto-detect picks them up |
| DeepInfra / Parasail pricing | Just upgrade — bundled |

## Reference

- [Per-call strict opt-out (llm-ports#46)](https://github.com/baabakk/llm-ports/issues/46)
- [DeepInfra + Parasail allowlist (llm-ports#47)](https://github.com/baabakk/llm-ports/issues/47)
- [Pricing entries (llm-ports#48)](https://github.com/baabakk/llm-ports/issues/48)
- [Release notes](https://github.com/baabakk/llm-ports/releases/tag/v0.1.0-alpha.21) | [Discussion #49](https://github.com/baabakk/llm-ports/discussions/49)
