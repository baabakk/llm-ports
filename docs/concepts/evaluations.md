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

---

## Beyond storage: the workflow layer (alpha.31.2)

Storing evaluations is the noun. The workflow layer is the verb: producing them in bulk, sampling them for review, and comparing arms against each other.

### The constraint that shapes all of it

**This package stores evaluations. It does not store what was evaluated.**

`EvaluationTarget` is a `{ kind, id }` pointer, and the sink bridge forwards only `evaluation.recorded` events. Nothing here holds an operation's messages, its response, or its parameters. `request_fingerprint` is a hash, and a hash cannot be replayed.

Regression detection is unaffected, because it aggregates scores. Anything that needs to see what the model actually did (judging, human review, A/B comparison) needs the operation itself.

### `OperationSource`: a port, not a second store

Rather than adding operation storage here, which would duplicate the log pipeline you already run and make this library the external system it exists to abstract, you implement a read-only port over whatever already holds your operations.

```ts
import type { OperationSource } from "@llm-ports/eval";

const source: OperationSource = {
  async get(operationId) { /* read one row from your store */ },
  async find(query)      { /* read many, newest first */ },
};
```

`createInMemoryOperationSource()` ships as a reference implementation for tests and as a worked example of the query semantics.

**Content is optional on purpose.** `CapturePolicy` governs whether request and response content is retained at all, and defaults to strict. A source may legitimately return an operation with identifiers, timings, usage, and cost but no messages and no response. Every function here treats that as a reported outcome, `content_not_retained`, rather than an error, so a strict capture policy shows up as a result field instead of an empty report you misread as "nothing to evaluate."

### Analysis, which needs no source

```ts
import { aggregateScores, detectRegression, sampleEvaluations } from "@llm-ports/eval";

const byEvaluator = await aggregateScores(store, "evaluator_name");

const report = await detectRegression(store, {
  boundary: "2026-08-01T00:00:00.000Z",
  groupBy: "evaluator_name",
});

const queue = await sampleEvaluations(store, { size: 25, seed: 1 });
```

Bounded numeric scores are normalized to 0..1 so a 1-to-5 rubric and a 0-to-1 rubric are comparable without rescaling by hand. Booleans map to 1 and 0, which makes a mean read as a pass rate. Categorical and text scores have no ordering this package can invent, so they are counted rather than averaged.

Sampling accepts a `seed`, which makes a review queue resumable and a test reproducible.

**`detectRegression` returns deltas and counts, never verdicts.** There is no "regressed" field and no significance test. Doing significance properly on the sample sizes typical here is a genuine statistical problem, and a confident answer computed from eleven samples is worse than a number next to the count. Groups thinner than `minSampleSize` are listed in `lowSampleKeys`, reported rather than filtered, because thin data is itself the signal.

### Batch judging

```ts
import { runBatchJudge } from "@llm-ports/eval";

const report = await runBatchJudge({
  source,
  store,
  query: { task_type: "triage", limit: 500 },
  evaluatorName: "helpfulness",
  evaluatorVersion: "1",
  judge: async (op) => ({
    score: { score_type: "numeric", value: await myScore(op), min: 0, max: 1 },
  }),
});
```

**This package never calls a model.** You supply the judge, so judging inherits your Registry's routing, fallback, and budget gating for free, and nothing here needs `@llm-ports/core`.

Runs are **idempotent**: evaluation ids derive from the operation id plus evaluator name and version, so a re-run writes nothing and reports `duplicates`. Bump `evaluatorVersion` when the rubric changes and the same operations become judgeable again.

**A budget refusal stops the run.** It does not quietly finish what it can afford. The report carries `stoppedEarly` and `stopReason` alongside the counts, because a partial evaluation that looks complete is worse than a refused one: the numbers are real and the gap in them is invisible.

### A/B comparison

```ts
// Default: scores the recorded response. Sends nothing, spends nothing.
await runComparison({ source, store, query, arms: ["a", "b"], judge, evaluatorName: "j", comparisonId: "c1" });

// Opt in to real traffic and a real bill.
await runComparison({
  source, store, query, arms: ["fast", "smart"], judge, evaluatorName: "j", comparisonId: "c2",
  replay: async (messages, arm) => (await myPort.generateText({ taskType: arm, messages })).text,
});
```

Omitting `replay` is the default and **sends no requests**: every arm scores the response already recorded. Supplying it re-runs each request once per arm, which is a genuine A/B test and which costs money. The difference is opt-in precisely because it is a bill.

Every evaluation in a comparison shares its `comparisonId` in the id, so the whole comparison can be pulled back out.
