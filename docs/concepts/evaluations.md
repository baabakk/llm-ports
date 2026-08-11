# Evaluations

Evaluations are post-hoc scores you attach to observability data. An LLM-judge runs offline and gives every response a helpfulness rating. A human annotator labels a conversation hours later as "resolved" or "escalated." A dataset replay computes retrospective accuracy across a week of calls. A regex-based rule flags responses that leak PII.

Every one of these is an **evaluation**. They share a shape (`EvaluationRef`) and land on a queryable store keyed on that shape.

## The two moving parts

- **[`@llm-ports/observability-contract`](../../packages/observability-contract/README.md)** — defines the data shape. `EvaluationRef`, `EvaluationTarget` (a discriminated union of 7 kinds: operation, attempt, response, agent step, trace, session, artifact), `EvaluationScore` (a discriminated union of 4 shapes: numeric, boolean, categorical, text), plus provenance fields (`evaluator_name`, `evaluator_version`, `rubric_id`, `rubric_version`, `source`, `occurred_at`, `explanation`, `correction`, `idempotency_key`). Shipped alpha.28.
- **[`@llm-ports/eval`](../../packages/eval/README.md)** — provides the storage backends. Two implementations of a shared `EvaluationStore` interface: an in-memory store (default, no dependencies) and a SQLite-backed store (opt-in, peer-dep on `better-sqlite3`). Both implement `write`, `get`, `find` (with `EvaluationQuery` filters), `count`, and `close`. Shipped alpha.29.

## Anatomy of an evaluation

```ts
import { type EvaluationRef } from "@llm-ports/observability-contract";

const ref: EvaluationRef = {
  // Unique write ID. Primary dedup key. Use a nanoid or similar.
  evaluation_id: "eval-abc123",

  // Discriminated union — what this evaluation attaches to.
  // Other kinds: "attempt", "response", "agent_step", "trace", "session", "artifact".
  target: { kind: "operation", id: "op-99a41" },

  // Human-readable evaluator name.
  evaluator_name: "llm_judge_helpfulness",

  // Optional: version identifier for the evaluator itself (semver, git sha, whatever).
  evaluator_version: "v2.1.0",

  // Optional: identifier for the rubric this evaluation was scored against.
  rubric_id: "helpfulness-rubric",
  rubric_version: "2024-Q3",

  // Discriminated score union. Pick the shape at author time.
  score: { score_type: "numeric", value: 0.87, min: 0, max: 1 },
  // Other shapes:
  //   { score_type: "boolean", value: true }
  //   { score_type: "categorical", value: "high" }
  //   { score_type: "text", value: "well-reasoned but incomplete" }

  // Where the evaluation came from: "human", "model", "rule", or "api".
  source: "model",

  // Free-form rationale. Common for LLM-judge chain-of-thought or annotator comments.
  explanation: "Response addresses all three sub-questions with citations.",

  // Optional: corrected value alongside the score (LangSmith-style `correction` field).
  correction: { corrected_answer: "42" },

  // ISO-8601 timestamp. When the evaluation was made.
  occurred_at: "2026-08-11T14:30:00Z",

  // Optional dedup key. When set, takes precedence over `evaluation_id`. Use
  // for retries or dataset replays where the same evaluation may be re-emitted.
  idempotency_key: "eval-abc-replay-key",
};
```

## Storing evaluations

Two backends, both implementing the same `EvaluationStore` interface, so consumers can swap without changing call sites.

### In-memory (default)

Zero dependencies. `O(1)` `get` via a Map; `O(n)` `find` / `count` via array scan. Perfect for tests and small runtimes.

```ts
import { createInMemoryEvaluationStore } from "@llm-ports/eval";

const store = createInMemoryEvaluationStore();

await store.write(ref);
const found = await store.get("eval-abc123");
```

Nothing persists across process restarts.

### SQLite (durable)

Peer-dep on `better-sqlite3`. Consumers who install the peer opt in.

```ts
import { createSqliteEvaluationStore } from "@llm-ports/eval";

const store = createSqliteEvaluationStore({
  dbPath: "./evaluations.db",
  pragmas: ["journal_mode = WAL", "synchronous = NORMAL"],
});

await store.write(ref);
```

Schema migration runs on connect (`CREATE TABLE IF NOT EXISTS evaluations (...)` plus four indexes on target, evaluator, rubric, and occurred_at). Idempotent; no data mutation on re-connect against an existing database.

## Dedup semantics

Both backends share the same dedup contract:

- `evaluation_id` is the primary dedup key. Two writes with the same `evaluation_id` produce one row; the second returns `false`.
- `idempotency_key` (optional) takes precedence when set. Use it when the same evaluation may be re-emitted (retries, dataset replay) and consumers must not double-count.
- First write wins; the second returns `false`.

## Querying

`EvaluationQuery` accepts filters combined via AND. Ordering is `occurred_at DESC` (most recent first).

```ts
// All evaluations attached to a specific operation.
const perOp = await store.find({
  target: { kind: "operation", id: "op-99a41" },
});

// All human annotations from the last week.
const recentHuman = await store.find({
  source: "human",
  since: "2026-08-04T00:00:00Z",
  limit: 100,
});

// All LLM-judge scores using a specific rubric.
const rubricScores = await store.find({
  evaluator_name: "llm_judge_helpfulness",
  rubric_id: "helpfulness-rubric",
});
```

`count(query?)` uses the same filter surface.

## Wiring to the Registry sink

Consumers who want the Registry to persist evaluations automatically (rather than calling `store.write` by hand) wrap their store with the observability-sink bridge:

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createSqliteEvaluationStore, toObservabilitySink } from "@llm-ports/eval";

const store = createSqliteEvaluationStore({ dbPath: "./evaluations.db" });
const sink = toObservabilitySink(store, {
  onError: (err) => console.warn("[eval-sink] write failed", err),
});

const registry = createRegistryFromEnv({
  env: process.env as Record<string, string>,
  adapters: { /* ... */ },
  instrumentation: {
    config: { sink, source: { library: "my-app", library_version: "1.0.0" } },
  },
});
```

The bridge forwards only `evaluation.recorded` events. Lifecycle events (`llm.operation.started`, `llm.attempt.completed`, etc.) are silently ignored — the intended shape for a "sink that only cares about evaluations."

## Both lifecycle capture AND evaluation storage

The bridge does not fan out on its own — consumers who want both compose their own fan-out sink so they control failure semantics for each side:

```ts
const combinedSink = {
  emit(event) {
    myLifecycleSink.emit(event);
    evalBridgeSink.emit(event);
  },
};
```

## Firing evaluations

Alpha.29 does not auto-generate evaluations. Nothing in the Registry currently emits `evaluation.recorded` on its own — evaluations are consumer-driven artifacts. To fire one, either:

- **Emit through an `ObservabilitySink` using the contract's helper.** Consumers who have wired a sink can fire evaluations from anywhere in their code:

  ```ts
  import { emitEvaluation, type EmitterConfig } from "@llm-ports/observability-contract";

  const config: EmitterConfig = { sink, source: { library: "my-eval-pipeline", library_version: "1.0.0" } };

  emitEvaluation(config, ref);
  ```

  The bridge (`toObservabilitySink(store)`) then persists this into the store.

- **Write to the store directly.** For simple pipelines that don't need the sink indirection:

  ```ts
  await store.write(ref);
  ```

Both paths hit the same dedup, so mixing them is safe.

## When to attach an evaluation to which target kind

- **`operation`** — the top-level unit of work the caller invoked (`op-...`). Attach when scoring the whole call as a unit ("was this triage decision correct").
- **`attempt`** — one physical provider attempt inside an operation (`att-...`). Attach when a specific provider's output is what you scored (e.g. the OpenAI response was blocked but the Anthropic fallback succeeded, and you want to attribute the score to the fallback attempt).
- **`response`** — a provider-issued response ID (`chatcmpl-...`, Anthropic's `request-id`). Attach when your reference data uses provider IDs rather than internal correlation IDs.
- **`agent_step`** — one step inside a `runAgent` tool-use loop. Attach when scoring an individual agent step's output.
- **`trace`** — a W3C trace ID (from `traceparent`). Attach when your evaluation crosses services and the LLM call is only one span in a larger workflow.
- **`session`** — a consumer-defined conversational session ID. Attach when scoring a whole multi-turn conversation.
- **`artifact`** — a consumer-defined domain artifact (a document, a PR, a customer support case). Attach when the evaluation targets the output of a pipeline whose steps were LLM calls but whose identity is the artifact itself.

## Non-goals

- No aggregation surface (histograms, cohort dashboards, calibration analysis). This package is the write + query layer; analytics live downstream.
- No cross-store replication or sync. Each store is standalone.
- No retention policy primitive. Consumers can delete out-of-band.
- No auto-firing of evaluations from the Registry. Evaluations are consumer-driven.

## Related

- [`docs/concepts/observability.md`](./observability.md) — the full observability contract surface, including the alpha.29 Registry-level lifecycle emission.
- [`packages/eval/README.md`](../../packages/eval/README.md) — the package-level reference including CRUD API details and full option lists.
- [`packages/observability-contract/README.md`](../../packages/observability-contract/README.md) — the contract package itself.
