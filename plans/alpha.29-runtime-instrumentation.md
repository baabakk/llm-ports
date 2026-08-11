# @llm-ports alpha.29 — Runtime Instrumentation

**Filed:** 2026-08-10T17:14:09 -07:00
**Author:** Babak Abbaschian
**Target ship date:** No hard deadline; correctness > speed.
**Release cadence:** Fourth of the observability contract's four-release plan (alpha.28 shipped 2026-07-22; alpha.29 → alpha.30 → alpha.31 remaining).
**Status:** Approved 2026-08-10 (this session).

---

## §1 Purpose

Alpha.28 shipped the observability contract as data types and helpers — event envelopes, correlation identifiers, error info, cache stats, prompt-fingerprint canonicalization, evaluation refs, capture policy, W3C Trace Context. That release said "here is the shape callers should emit," but left the actual emission to callers.

Alpha.29 makes the library itself do the emitting. Every generation-method call and every `runAgent` call, whether it goes through the Registry or straight through an adapter, fires the standard lifecycle events without the caller doing any bookkeeping. Consumers stop keeping their own "did that call succeed / how long did it take / what was the effective model" records and start reading the library's stream.

## §2 Scope

Seven sub-tasks from the four-release plan §5.2, plus one folded-in defect fix. All land in one alpha.29 release.

### §2.1 Instrumentation at the Registry AND at every adapter, via one shared service

The load-bearing architectural decision for this release. Instead of scattering emit calls across the Registry and every adapter (6-7 sites that must all stay consistent forever), a single instrumentation service in `packages/core/src/observability/` owns:

- **Event construction.** The exact shape of every lifecycle event (`llm.operation.started`, `llm.attempt.started`, `llm.attempt.completed`, `llm.attempt.failed`, `llm.operation.completed`, `llm.operation.failed`, `llm.operation.cancelled`, `llm.attempt.retry_scheduled`, `llm.fallback.selected`, and the agent-step variants). If a field is added later, it changes in one place.
- **ID lifecycle.** Generating `operation_id` at the outer boundary and threading it through every inner `attempt_id`. Reading the caller's `withObservabilityContext(port, ctx)` context if one was set, so a long-horizon agent run keeps the same `operation_id` across many retries.
- **Timing.** Starting the clock on `attempt.started`, recording `latency_ms` on `attempt.completed` / `attempt.failed`.
- **Error handling.** Every emit wrapped in a `.catch()` so a slow or throwing sink never breaks the primary LLM call.

The primary API is a pair of higher-order wrappers that own the try/finally lifecycle so a caller can't forget the `.failed` emit path:

```ts
withOperation(ctx, { taskType, method }, async (opCtx) => {
  return withAttempt(opCtx, { providerAlias, modelId, attemptNumber }, async () => {
    return actualProviderCall();
  });
});
```

The Registry wraps every generation-method call in `withOperation`. Each adapter wraps its provider call in `withAttempt`. They nest cleanly because `opCtx` flows through as a first-class argument. A manual-emit escape hatch (`emitter.startAttempt(...) / completeAttempt(...)`) is exposed for streaming, where the completion happens over time and the wrap-around doesn't fit — but the vast majority of the surface uses the higher-order form.

### §2.2 Registry-exclusive events

Two events fire only from the Registry, because only the Registry sees the causal decision:

- `llm.attempt.retry_scheduled` — Registry decided to retry within the same provider (rate limit, transient auth, capability fallback, reasoning starvation, validation feedback).
- `llm.fallback.selected` — Registry decided to move to the next provider in the fallback chain.

Both use the shared service to construct the event; they just live at emission sites the adapters can't see.

### §2.3 Prompt fingerprint at the call site

Every call computes `message_hash` and `request_hash` per the canonicalization spec that shipped in alpha.28. The compute lives inside the shared service and fires as part of `attempt.started`. Optional per the `CapturePolicy` — off by default per §4.10 of the contract.

### §2.4 Provider cache normalization

The five in-process adapters (`openai`, `anthropic`, `google`, `ollama`, `vercel`) map their native cache fields into the contract's nested `CacheStats.provider_cache`. Adapters that don't expose cache metrics (`ollama`, `vercel` in most modes) emit nothing for the cache field, which is the intended contract behavior.

### §2.5 Agent step + tool events

The tool-use loop inside `runAgent` fires `agent.step.*` (per-step boundaries) and `agent.tool.*` (per-tool-call boundaries) events. Codex and Aider adapters (shipped alpha.28) get their inline event emission refactored to use the shared service — no behavior change, just consistency.

### §2.6 `@llm-ports/eval@0.1.0`

New publishable package under the same MIT/public flow as `@llm-ports/observability-contract`. Ships:

- The `EvaluationSink` interface that consumers implement.
- In-memory writer (default).
- SQLite writer (opt-in, peer-dep on `better-sqlite3`).
- Helpers keyed on `EvaluationRef` from alpha.28.

Storage schema is defined; the reference implementation lives here; consumer-specific evaluators layer on top.

### §2.7 SalesCoach task-type case-mismatch fix (folded in from 2026-08-10 review)

Root cause. `packages/core/src/registry/config.ts:85` lowercases and hyphenates env-var suffixes at parse time (`LLM_TASK_ROUTE_STRUCTURED_OUTPUT` → key `"structured-output"`). `packages/core/src/registry/registry.ts:298` and `:424` do a string-identity lookup against the caller-supplied `taskType`, then silently fall through to `"general"` on miss. A caller passing `"STRUCTURED_OUTPUT"` never hits the `structured-output` route. SalesCoach filed this as `TD-LLM-TASKTYPE-CASE-MISMATCH-SILENT-GENERAL-FALLBACK` (their tracker `f7af4eb`). Nothing is broken today only because SalesCoach's `.env` has identical chains for every task; the fallback picks the same provider the correct lookup would.

Fix. Two small changes plus tests:

1. Extract the parse-side transform (`s.toLowerCase().replace(/_/g, "-")`) into a shared helper, and call it at both lookup sites and the parse site. Now `"STRUCTURED_OUTPUT"`, `"Structured_Output"`, `"structured-output"` all find the same route.
2. When the normalized lookup still misses and the fallback to `"general"` fires, warn-once through the existing `WarningState` infrastructure. Dedup by normalized task-type string.

Tests. Three unit tests: (a) case-insensitive lookup finds the right chain; (b) unknown task type warns exactly once; (c) known kebab-case task type doesn't warn.

### §2.8 What's excluded (cross-repo)

The four-release plan §5.2 also names a "non-port caller proof" that involves BEPA (`src/ai/quality-tracker.ts` re-keys on `operation_id` and emits `EvaluationRef` values) and ADW (`ClaudeCodeDriver` emits conformant lifecycle events). Those cutovers do NOT ship with alpha.29's tarball. Alpha.29 ships the surface; BEPA and ADW plan and consume it in their own repos on their own timelines. This is the U-4 boundary — llm-ports work lives in the llm-ports repo, not in downstream consumer repos.

## §3 Acceptance criteria

- One shared instrumentation service exists at `packages/core/src/observability/instrumentation.ts` (name TBD during implementation). Every emission site — Registry, five in-process adapters, both subprocess adapters — calls it. No emission code lives outside it except in the pure Registry-exclusive path for `retry_scheduled` and `fallback.selected`.
- Every generation method (`generateText`, `generateStructured`, `streamText`, `streamStructured`, `runAgent`) fires the happy-path 4-event sequence on success and the failure-path 3-event sequence on error, regardless of whether the caller goes through the Registry or a raw adapter.
- Adding a new field to any event body is a one-file change in the shared service (plus schema update in `@llm-ports/observability-contract`).
- SalesCoach's TD closes when they bump to alpha.29 with zero code changes on their side.
- Test coverage per the four-release plan §5.2: +150 runtime tests, +50 adapter-parity tests, +30 non-port emission tests. Approximate targets, not hard floors.

## §4 Test coverage plan

Three test tiers, all under `@llm-ports/core` unless otherwise noted:

- **Runtime instrumentation tests** — one per lifecycle event × one per method × happy/failure path. Uses a `CollectingSink` (already in the contract package) to assert the exact event sequence.
- **Adapter-parity tests** — for each of the 7 adapters (5 in-process + 2 subprocess), the same test suite runs against a mocked provider and asserts identical event shapes come out. Prevents "adapter X emits differently from adapter Y" drift.
- **Non-port emission tests** — a fixture that constructs events without importing the Registry, using only `@llm-ports/observability-contract`. Proves the non-port emission story stays viable for downstream consumers who want to emit events from their own code (BEPA, ADW).

The SalesCoach fix gets its own three-test unit suite as described in §2.7.

## §5 Non-goals

Not in alpha.29:

- Streaming instrumentation (TTFT, chunk-count, inter-chunk latency). Alpha.30.
- OTel semconv integration. Alpha.30.
- Persistence backends beyond SQLite (ClickHouse writer, OTel exporter). Alpha.31.
- BEPA / ADW consumer cutovers. Their own repos, their own timelines.
- Any change to the observability event envelope shape shipped in alpha.28. Additive only.

## §6 Delivery mechanics

- Same release plumbing as alpha.28: linked bump under `@llm-ports/*` (`migrate` stays excluded), pre-release mode continues, `alpha` dist-tag re-rolled forward.
- New package `@llm-ports/eval@0.1.0` publishes as its first version (uses the `--tag alpha` explicit flag to avoid the "cannot publish prerelease to `latest`" gotcha we hit for the alpha.28 new packages).
- Changeset entry lives at `.changeset/alpha-29-runtime-instrumentation.md`. It lists every `@llm-ports/*` publishable package at `patch` per the same linked-bump pattern alpha.28 used.
- All planning documents for this release live in this repo (`plans/`), not in the BEPA repo.

## §7 Changelog

- **2026-08-10T17:14:09 -07:00** — Filed as approved plan. Scope frozen: the seven §2 sub-tasks plus the SalesCoach fix. Cross-repo consumer cutovers explicitly out of scope.
