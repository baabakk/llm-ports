---
"@llm-ports/core": minor
---

New shared utilities for adapter authors. Replaces helpers that were duplicated 3-4x across adapter packages with single canonical versions:

- `emitRetryEvent(onRetry, event)` — fire-and-forget invocation of the observability hook. Swallows hook errors, never blocks retries.
- `createCapabilityLearner()` — factory for per-model capability discovery. Returns `{ get, remember, _reset, seedFromCatalog, hasLearned }`. Adapters provide their own provider-specific error classifiers and static catalogs.
- `buildLearningIssueUrl(event)` + `emitFirstLearningWarning(event)` — pre-filled GitHub New Issue URL for runtime-learned capability constraints. Fires once per (modelId, capability) per process via `console.warn`. Zero telemetry.
- `wrapProviderError(alias, err)` — idempotent error wrapper. Passes typed framework errors (`ProviderUnavailableError`, `EmptyResponseError`, `ValidationError`) through unchanged.
- `stringifyContentBlocks(content)` — `MessageContent` → string.
- `extractJSON(raw)` — parse JSON out of markdown-fenced or prose-wrapped text.
- `tryParsePartialJSON(buffer)` — best-effort partial JSON parse for streaming. Now uses a proper bracket stack to close in correct reverse order (fixes a bug from the per-adapter copies that broke on inputs like `{"items": [1, 2, 3`).
- `mergeTokenUsage(a, b)` — add `TokenUsage` values, preserving cache + reasoning token fields.

Also adds an optional `capability?: string` field to `RetryEvent` so observability stacks can distinguish capability-fallback reasons.

Non-breaking. Existing imports unchanged; new exports are additive.
