---
"@llm-ports/core": minor
---

Adds per-call `strict?: boolean` to `GenerateStructuredOptions` + `StreamStructuredOptions`, plus five OTel-aligned observability hooks on `RegistryOptions.observability` (`onCost`, `onTokenUsage`, `onFallback`, `onValidationRetry`, `onCacheHit`).

## What changed

### Per-call structured-output strict override

`GenerateStructuredOptions` and `StreamStructuredOptions` now accept an optional `strict?: boolean`:

- `strict: true`  — force strict `response_format: { type: "json_schema", strict: true }` for this call
- `strict: false` — force classic `response_format: { type: "json_object" }` for this call
- `strict: undefined` — use the adapter's existing default (auto-detected per baseURL allowlist, or whatever `useStrictResponseFormat` was set to at construction)

Adapters that do not implement strict mode (or whose backing provider doesn't support it) silently ignore the hint rather than throw. See llm-ports#46 for the empirical case driving this addition (ADW 04-Structured-Output-Reliability.md): registries with one adapter alias per provider need to flip strict on/off per call based on the schema shape (closed-shape → strict, `z.record(...)` → json_object).

### OTel-aligned observability hooks

`RegistryOptions` gains an optional `observability` bundle:

```ts
const registry = createRegistryFromEnv({
  // ...existing options...
  observability: {
    onCost:        (e) => { /* per-call USD breakdown */ },
    onTokenUsage:  (e) => { /* per-call token counts */ },
    onFallback:    (e) => { /* fired when chain advances */ },
    onCacheHit:    (e) => { /* fired when cached_tokens > 0 */ },
    onValidationRetry: (e) => { /* type-only in alpha.21 */ },
  },
});
```

All hooks are fire-and-forget; sync OR async; hook errors are swallowed (observability instrumentation can't break inference). Event shapes align with the OpenTelemetry `gen_ai.*` semantic-conventions taxonomy so downstream pipelines can map them onto spans + metrics without re-deriving fields.

#### Coverage in this release

- **`onCost` / `onTokenUsage` / `onCacheHit`** — emitted by the Registry on every successful `generateText`, `generateStructured`, `runAgent` call. Stream methods do not emit cost yet (streamed cost surfacing is the alpha.22 follow-up).
- **`onFallback`** — emitted by `walkChain` whenever it advances from one provider alias to the next due to runtime error. Per-call only; not emitted for the initial selection or for `forceProviderAlias` calls.
- **`onValidationRetry`** — hook type defined; Registry-level emission is the alpha.22 follow-up. Consumers wanting validation-retry observability today should use the adapter's existing `onRetry` hook and filter on `reason === "validation-feedback"`.

### Backwards compatibility

Both additions are additive. Registries constructed without the `observability` field behave identically to alpha.20.1; calls without the `strict` field preserve the adapter's existing default behavior.

See also: llm-ports#46 (per-call strict opt-out), llm-ports#47 (allowlist expansion), llm-ports#48 (pricing entries).
