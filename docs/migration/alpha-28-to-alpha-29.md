# Migrating from alpha.28 to alpha.29

> **Impact:** None — fully additive release. Bump peer deps. Opting into the new observability surface is optional.

## Install

```bash
pnpm add @llm-ports/core@alpha @llm-ports/observability-contract@alpha \
         @llm-ports/eval@alpha \
         @llm-ports/adapter-openai@alpha @llm-ports/adapter-anthropic@alpha \
         @llm-ports/adapter-google@alpha @llm-ports/adapter-ollama@alpha \
         @llm-ports/adapter-vercel@alpha @llm-ports/adapter-codex@alpha \
         @llm-ports/adapter-aider@alpha @llm-ports/capabilities@alpha
```

Eleven publishable packages at `0.1.0-alpha.29`. One new package: `@llm-ports/eval`.

## What actually changed

**In one sentence:** the Registry now emits the full alpha.28 observability contract lifecycle when `RegistryOptions.instrumentation` is configured; a new `@llm-ports/eval` package provides durable storage for post-hoc evaluations; and a silent-fallback bug in the Registry's task-type lookup is fixed. No public API is removed or renamed.

**In slightly more detail:**

### Registry-level observability instrumentation

Every call on the Registry's `LLMPort` for `generateText`, `generateStructured`, and `runAgent` now emits contract events when `RegistryOptions.instrumentation` is supplied. Streams (`streamText`, `streamStructured`) are not instrumented yet — alpha.30 wires the streaming path.

Emitted events per operation:

- `llm.operation.started` (with `task_type`, `method`, `provider_chain`)
- One `llm.attempt.started` + one `llm.attempt.completed` per successful provider try
- `llm.attempt.failed` on every failed try
- `llm.fallback.selected` between a failed try and the next provider (with `from_provider_alias`, `to_provider_alias`, `cause`)
- `llm.operation.completed` on success (with `aggregate_usage`, `aggregate_cost`, `attempts_made`, `final_provider_alias`, `total_duration_ms`)
- `llm.operation.failed` when the whole chain fails
- `llm.operation.cancelled` when an `AbortError` propagates

Every event across a single operation shares one `operation_id`. Consecutive attempts get unique `attempt_id`s. The second attempt's `llm.attempt.started` carries `is_fallback: true`.

Wiring it:

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createCollectingSink } from "@llm-ports/observability-contract";

const sink = createCollectingSink();

const registry = createRegistryFromEnv({
  env: process.env as Record<string, string>,
  adapters: { /* ... */ },
  instrumentation: {
    config: {
      sink,
      source: { library: "my-app", library_version: "1.0.0" },
    },
    // Optional: attach a caller-plumbed correlation context so a long-horizon
    // outer scope pins the operation_id across the Registry's calls.
    // context: { operation_id: "op-outer-123" },
    //
    // Optional: opt into prompt fingerprint compute at attempt.completed.
    // fingerprint: { algorithm: "sha256" },
  },
});
```

The alpha.21 fire-and-forget hooks (`RegistryOptions.observability`, with `onCost` / `onTokenUsage` / `onFallback` / `onValidationRetry` / `onCacheHit`) continue to work unchanged. Both surfaces coexist — pick whichever fits your consumer.

### Registry-exclusive events

Two events fire only from the Registry, because only the Registry sees the causal decision:

- `llm.attempt.retry_scheduled` — the Registry decided to retry the same provider after a retriable error. Fires between `llm.attempt.failed` and the next `llm.attempt.started`. Carries `retry_reason: RetryReason`, `backoff_ms: number`, `next_attempt_number: number`.
- `llm.fallback.selected` — the Registry decided to walk to the next provider in the chain. Carries `from_provider_alias`, `to_provider_alias`, and `cause: FallbackCause`.

### Prompt fingerprint at `attempt.completed`

Opt-in via `Instrumentation.fingerprint?: FingerprintPolicy`. Off by default per the contract's `CapturePolicy.fingerprint` default.

When set, the Registry computes a `RequestFingerprint` once per operation (before any attempt runs — the request is the same across every retry and fallback within an operation) and attaches it to every `llm.attempt.completed` event via the new optional `AttemptCompletedData.request_fingerprint` field.

Two calls with identical messages + sampling params produce identical `message_hash` and `request_hash`. HMAC variant available for regulated environments; requires `hmacKey` ≥ 16 UTF-8 bytes.

```ts
instrumentation: {
  config: { sink, source },
  fingerprint: {
    algorithm: "sha256",
    promptId: "triage-classifier",
    promptVersion: "v3.2",
  },
}
```

### SalesCoach task-type case-mismatch fix

Root cause: the env-var parser lowercases and hyphenates suffixes (`LLM_TASK_ROUTE_STRUCTURED_OUTPUT` → key `"structured-output"`), but pre-alpha.29 the Registry's lookup did string-identity matching against the caller-supplied `taskType` and silently fell through to `"general"` on miss. Callers passing `"STRUCTURED_OUTPUT"` from application code never hit the `structured-output` route.

Fix: the parse-side transform (`s.toLowerCase().replace(/_/g, "-")`) is now applied at both Registry lookup sites (`selectModel`, `selectViableChain`) as well. And when the normalized lookup still misses and the fallback to `"general"` fires, a warn-once through the shared `WarningState` surfaces the drift.

- **If your call sites already use kebab-case `taskType`** (e.g. `"structured-output"`) — no change; you were already routing correctly.
- **If your call sites use SCREAMING_SNAKE or mixed-case `taskType`** (e.g. `"STRUCTURED_OUTPUT"`, `"Structured_Output"`) — you were silently misrouted to `general` before. After bumping to alpha.29, your calls hit the correct route. Watch for behavioral changes if your `general` chain differed from the intended route.
- **If you had `taskType` values that didn't match any configured route** — the warn-once fires. Add the missing `LLM_TASK_ROUTE_<...>` to `.env`, or pass a `taskType` that matches a configured route. Suppress via `RegistryOptions.suppressDeprecationWarnings: true` or route through `deprecationWarningHandler` for structured logging.

### New package: `@llm-ports/eval@0.1.0`

Durable storage for post-hoc evaluations keyed on the alpha.28 `EvaluationRef` shape from `@llm-ports/observability-contract`. Consumers construct evaluations using the contract's shape; this package handles storage, retrieval, dedup, and query.

Two backends:

- `createInMemoryEvaluationStore()` — no-dependency in-process store. Suitable for tests and small runtimes.
- `createSqliteEvaluationStore({ dbPath, pragmas?, driver? })` — durable SQLite backend. Peer-dep on `better-sqlite3` (opt-in; install only if you use the SQLite backend).

Both implement the same `EvaluationStore` interface: `write`, `get`, `find` (with `EvaluationQuery` filters), `count`, `close`.

Bridge for the observability sink:

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createSqliteEvaluationStore, toObservabilitySink } from "@llm-ports/eval";

const store = createSqliteEvaluationStore({
  dbPath: "./evaluations.db",
  pragmas: ["journal_mode = WAL", "synchronous = NORMAL"],
});
const sink = toObservabilitySink(store);

const registry = createRegistryFromEnv({
  env: process.env as Record<string, string>,
  adapters: { /* ... */ },
  instrumentation: {
    config: { sink, source: { library: "my-app", library_version: "1.0.0" } },
  },
});
```

The bridge forwards only `evaluation.recorded` events to the store; lifecycle events (`llm.operation.started`, etc.) are silently ignored. Consumers wanting BOTH lifecycle capture AND evaluation storage compose a fan-out sink themselves.

## Migration steps

There are no code changes required. The migration is:

1. Update `package.json` peer deps for every `@llm-ports/*` you consume:
   - `"@llm-ports/core": "^0.1.0-alpha.29"`
   - `"@llm-ports/observability-contract": "^0.1.0-alpha.29"`
   - Every adapter you use, and `@llm-ports/capabilities`.
   - **Optional:** `"@llm-ports/eval": "^0.1.0-alpha.29"` if you'll persist evaluations.
2. `pnpm install`.
3. `pnpm build` — confirm nothing broke.

That's it for the mechanical migration. Wiring the observability surface is opt-in and can happen at your own pace.

## Deferred to alpha.30

The following alpha.29-scope items were carved out and land in alpha.30:

- **Adapter-level operation/attempt emission.** Consumers who bypass the Registry and import a raw in-process adapter directly see no contract events yet. Filed as `TD-ALPHA29-ADAPTER-EMIT-DEFERRED` in the repo's `TECH-DEBT.md`.
- **Agent step + tool events** (`agent.step.*`, `agent.tool.*`) inside `runAgent`. Filed as `TD-ALPHA29-AGENT-STEP-EVENTS-DEFERRED`.
- **Provider cache normalization** (`CacheStats.provider_cache`) across in-process adapters.
- **Streaming instrumentation** for `streamText` / `streamStructured`.
- **OpenTelemetry semconv adapter** (`@llm-ports/telemetry-otel`).

## When to consider adopting

- **You use the Registry and want contract-shaped observability today.** Bump; wire `instrumentation`; done.
- **You want to persist LLM-judge scores, human annotations, or rule-based verdicts.** Bump; adopt `@llm-ports/eval`.
- **You had SCREAMING_SNAKE `taskType` in your call sites.** Bump; verify your routes are now hitting the intended chain (`registry.listTasks()` shows the configured routes).
- **You bypass the Registry and import a raw adapter.** Wait for alpha.30 for full adapter-level emission. In the meantime, wrap your adapter call in your own `withOperation` + `withAttempt` from `@llm-ports/core` — the shared service is exported and callable directly.

## Downgrade / rollback

Trivial: revert the version pins to `0.1.0-alpha.28` and remove `@llm-ports/eval` from your deps if you added it. Nothing else to undo.
