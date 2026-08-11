# Changelog

`llm-ports` uses [Changesets](https://github.com/changesets/changesets) to manage releases. Each published package keeps its own per-version changelog beside the source:

| Package | Per-package changelog |
|---|---|
| `@llm-ports/core` | [`packages/core/CHANGELOG.md`](packages/core/CHANGELOG.md) |
| `@llm-ports/capabilities` | [`packages/capabilities/CHANGELOG.md`](packages/capabilities/CHANGELOG.md) |
| `@llm-ports/observability-contract` | [`packages/observability-contract/CHANGELOG.md`](packages/observability-contract/CHANGELOG.md) |
| `@llm-ports/eval` | [`packages/eval/CHANGELOG.md`](packages/eval/CHANGELOG.md) |
| `@llm-ports/adapter-anthropic` | [`packages/adapter-anthropic/CHANGELOG.md`](packages/adapter-anthropic/CHANGELOG.md) |
| `@llm-ports/adapter-openai` | [`packages/adapter-openai/CHANGELOG.md`](packages/adapter-openai/CHANGELOG.md) |
| `@llm-ports/adapter-google` | [`packages/adapter-google/CHANGELOG.md`](packages/adapter-google/CHANGELOG.md) |
| `@llm-ports/adapter-ollama` | [`packages/adapter-ollama/CHANGELOG.md`](packages/adapter-ollama/CHANGELOG.md) |
| `@llm-ports/adapter-vercel` | [`packages/adapter-vercel/CHANGELOG.md`](packages/adapter-vercel/CHANGELOG.md) |
| `@llm-ports/adapter-codex` | [`packages/adapter-codex/CHANGELOG.md`](packages/adapter-codex/CHANGELOG.md) |
| `@llm-ports/adapter-aider` | [`packages/adapter-aider/CHANGELOG.md`](packages/adapter-aider/CHANGELOG.md) |

This root file aggregates the **release-level** notes — the user-facing summary of what changed across all packages in a given version, breaking changes, and migration guidance.

## v0.1.0-alpha.29 — 2026-08-11

### What changed

Runtime observability instrumentation. The Registry now emits the full alpha.28 observability contract lifecycle when instrumentation is configured. Fully additive; existing consumers see identical behavior when they don't opt into the new fields.

### New

- **`@llm-ports/core`**: shared instrumentation service at `src/instrumentation.ts` — `withOperation`, `withAttempt`, `emitRetryScheduled`, `emitFallbackSelected`, `startAttempt` / `completeAttempt` / `failAttempt` (manual escape hatch), `maybeComputeFingerprint`. New `RegistryOptions.instrumentation?: Instrumentation` — when supplied, `generateText` / `generateStructured` / `runAgent` emit `llm.operation.started` → per-attempt `.started` / `.completed` / `.failed` → `llm.fallback.selected` on chain advancement → `llm.operation.completed` / `.failed` / `.cancelled`. Prompt fingerprint at `attempt.completed` via `Instrumentation.fingerprint?: FingerprintPolicy` (opt-in, off by default per the contract's `CapturePolicy` default).
- **`@llm-ports/core`**: new `warnOnce(state, key, message)` primitive alongside `warnDeprecated` in `utils/deprecation.ts`. Same dedup + suppression + handler infrastructure.
- **`@llm-ports/core`**: new `normalizeTaskType(s)` helper. Applied at the env-parser and both Registry lookup sites so `"STRUCTURED_OUTPUT"`, `"Structured_Output"`, `"structured-output"` all resolve to the same route.
- **`@llm-ports/observability-contract`**: new optional `AttemptCompletedData.request_fingerprint` field (plus Zod schema update) — closes the gap between the alpha.28 `computeRequestFingerprint` helper and its emission surface.
- **`@llm-ports/eval@0.1.0`** — new publishable package. Durable storage for post-hoc evaluations (LLM-judge scores, human annotations, rule-based verdicts) keyed on the alpha.28 `EvaluationRef` shape. In-memory store (default, no deps) + SQLite backend (opt-in peer-dep on `better-sqlite3`). Both implement the same `EvaluationStore` interface. `toObservabilitySink(store)` bridges the store to the contract's `ObservabilitySink` — forwards only `evaluation.recorded` events.

### Fixed

- **`@llm-ports/core`**: Registry now warns once (through the shared `WarningState`) when a caller's `taskType` doesn't match any configured route and the fallback to `"general"` fires. Previously silent — closed the SalesCoach-reported `TD-LLM-TASKTYPE-CASE-MISMATCH-SILENT-GENERAL-FALLBACK` bug where consumers passing SCREAMING_SNAKE task types were silently misrouted to `general` regardless of their `.env` config.

### Changed

- Nothing breaking. Every new surface is additive: `RegistryOptions.instrumentation`, `AttemptCompletedData.request_fingerprint`, `Instrumentation.fingerprint`. Existing callers who don't opt in see identical behavior.

### Migration notes

See [`docs/migration/alpha-28-to-alpha-29.md`](./docs/migration/alpha-28-to-alpha-29.md). Bump every `@llm-ports/*` peer dep in your `package.json` from `alpha.28` to `alpha.29`. No code changes required. Wiring the new observability surface is opt-in.

### Deferred to alpha.30 (per `plans/alpha.29-runtime-instrumentation.md` §7 scope-adjustment)

- Adapter-level operation/attempt emission (`TD-ALPHA29-ADAPTER-EMIT-DEFERRED`)
- Agent step + tool events inside `runAgent` (`TD-ALPHA29-AGENT-STEP-EVENTS-DEFERRED`)
- Provider cache normalization inside in-process adapters (`CacheStats.provider_cache`)
- Streaming instrumentation (`streamText`, `streamStructured`)
- OpenTelemetry semconv adapter (`@llm-ports/telemetry-otel`)

### Known limitations

Consumers who bypass the Registry and import a raw in-process adapter directly see no contract events yet. Direct-adapter observability lands in alpha.30 alongside streaming instrumentation.

## v0.1.0-alpha.28 — 2026-07-22

### What changed

Observability contract foundation. New standalone `@llm-ports/observability-contract` package ships the data model consumers construct and emit conformant events with — no dependency on `@llm-ports/core`. Two subprocess-driven agent adapters (`adapter-codex`, `adapter-aider`) join the family.

### New

- **`@llm-ports/observability-contract@0.1.0`** — new publishable package. Event envelope (`ObservabilityEvent<TType, TData>`); correlation model (`CorrelationContext`, `ObservabilityContext`); sink interface (`ObservabilitySink`, `noopSink`, `createCollectingSink`); W3C Trace Context + Baggage (≤64 members, ≤8192 bytes); nanoid IDs (`newEventId`, `newOperationId`, `newAttemptId`, `newEvaluationId`); 9 lifecycle event types + 4 agent-step event types; `ErrorInfo` + 8-value `CauseCategory` rollup; nested `CacheStats`; `RequestFingerprint` canonicalization rules v1 + SHA-256 / HMAC-SHA-256 primitives + `computeRequestFingerprint` helper + golden vectors; `EvaluationRef` + 7-kind `EvaluationTarget` union + 4-shape `EvaluationScore` union; `CapturePolicy` with strict and permissive presets; full Zod schema catalog; `buildEvent` / `emitLifecycleEvent` / `emitEvaluation` emitter helpers.
- **`@llm-ports/core`**: `withObservabilityContext(port, context)` scoped-port wrapper. Merges caller-supplied `CorrelationContext` + `TraceContext` + `Baggage` into a port-scoped context that adapters can retrieve via `getObservabilityContext(port)`.
- **`@llm-ports/core`**: three new typed error classes — `CreditExhaustionError` (walk-worthy 402), `ProviderMalformed400Error extends BadRequestError` (walk-worthy 400 due to provider request-schema drift), `AdapterInternalError` (abort-worthy adapter-internal JS runtime error).
- **`@llm-ports/core`**: `defaultShouldFallback(err)` walk-table policy function — canonical `shouldFallback` semantics.
- **`@llm-ports/adapter-codex@0.1.0`** — new publishable package. Subprocess-driven adapter for OpenAI Codex CLI (`codex exec --json`). Shape A passthrough governance.
- **`@llm-ports/adapter-aider@0.1.0`** — new publishable package. Subprocess-driven adapter for Aider CLI (`aider --no-stream --yes-always --message`). Shape A passthrough governance.

### Fixed

- **`TD-LLMP-16`**: `wrapProviderError` now propagates `modelId` into `ContextWindowExceededError` and `ContentPolicyViolationError`.
- **`TD-LLMP-17`**: `runAgent` gets a defensive `tools: {}` default; `wrapProviderError` isolates local JS runtime errors as `AdapterInternalError`.
- **`TD-LLMP-18`**: `attemptValidationRepair` normalizes Unicode confusables (hyphens U+2010..U+2015, curly quotes, Unicode spaces) on `invalid_enum_value` retries.

### Changed

Nothing breaking. Everything additive.

## Unreleased

Tracked changesets that haven't shipped yet live under [`.changeset/`](.changeset/). Run `pnpm changeset` to add a new one.

## Format

Each release entry follows this shape:

```markdown
## v0.1.0 — YYYY-MM-DD

### What changed
<!-- 1-2 sentence summary of the release theme -->

### New
<!-- bullet list of new packages, capabilities, adapters, public API surface -->

### Changed
<!-- breaking changes, behavior changes; link to migration notes -->

### Fixed
<!-- bug fixes notable enough for release notes -->

### Migration notes
<!-- how to upgrade from the previous version, if anything is breaking -->

### Known limitations
<!-- carry-overs from the README's "Known Limitations" section that this release didn't fix -->

### Thanks
<!-- contributor handles, including non-PR feedback contributors -->
```

## Versioning

Pre-release: `0.1.0-alpha.0`, `0.1.0-alpha.1`, ... published under the `alpha` npm tag.

Stable: `0.1.0`, `0.1.1`, ... published under the `latest` npm tag once gate B from PUBLISHING is met.

Internal-only packages (`@llm-ports/adapter-contract-tests`, `@llm-ports/benchmarks`) are not published to npm; their changes are not version-bumped here.
