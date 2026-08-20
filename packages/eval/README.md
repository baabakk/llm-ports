# @llm-ports/eval

Durable storage for post-hoc evaluations — LLM-judge scores, human annotations, rule-based verdicts, and API-driven scoring pipelines — keyed on the `EvaluationRef` shape from [`@llm-ports/observability-contract`](../observability-contract/README.md).

## Why post-hoc storage

Evaluations arrive **late**. An LLM-judge score runs offline after the request completed. A human annotator labels a conversation hours later. A dataset replay produces retrospective scores days after the original operation. Storing these as append-only rows keyed on `EvaluationRef` makes them queryable per target (operation, attempt, response, agent step, session, artifact) and per evaluator (name, version, rubric, rubric version).

## Backends

Three ship in the box, sharing the same `EvaluationStore` interface:

| Backend | When to use |
|---|---|
| **In-memory** (`createInMemoryEvaluationStore()`) | Tests, ephemeral runtimes, small workloads. No dependencies. Nothing persists across process restart. |
| **SQLite** (`createSqliteEvaluationStore({ dbPath })`) | Durable single-node storage. Opt-in peer dep on `better-sqlite3`. |
| **Postgres** (`createPostgresEvaluationStore({ connectionString })`) | Durable shared storage for multi-process deployments. Opt-in peer dep on `pg`. Accepts an existing pool instead of opening its own. (alpha.31.2+) |

All three implement the same `EvaluationStore` interface, so consumers can swap without changing call sites.

**No ClickHouse backend, deliberately.** The contract requires exact idempotent writes, and ClickHouse deduplicates only during background merges at unpredictable times. Its own documentation states that the `FINAL` read modifier "offers eventual correctness only, it does not guarantee rows will be deduplicated, and you should not rely on it." `insert_deduplication_token` fits better but is bounded to a rolling window and still cannot produce the exact boolean `write()` returns. The mismatch is structural, not a matter of effort.

## Install

```bash
npm i @llm-ports/eval @llm-ports/observability-contract
# For the SQLite backend only:
npm i better-sqlite3
# For the Postgres backend only:
npm i pg
```

## Usage — in-memory store

```typescript
import { createInMemoryEvaluationStore } from "@llm-ports/eval";

const store = createInMemoryEvaluationStore();

await store.write({
  evaluation_id: "eval-abc",
  target: { kind: "operation", id: "op-123" },
  evaluator_name: "llm_judge_helpfulness",
  evaluator_version: "v2.1",
  rubric_id: "helpfulness-rubric",
  rubric_version: "2024-Q3",
  score: { score_type: "numeric", value: 0.87, min: 0, max: 1 },
  source: "model",
  explanation: "Response addresses all three sub-questions with citations.",
  occurred_at: new Date().toISOString(),
});

const perOperation = await store.find({
  target: { kind: "operation", id: "op-123" },
});
console.log(perOperation); // → [{ evaluation_id: "eval-abc", ... }]

await store.close(); // no-op for in-memory; safe to call
```

## Usage — SQLite store

```typescript
import { createSqliteEvaluationStore } from "@llm-ports/eval";

const store = createSqliteEvaluationStore({
  dbPath: "./evaluations.db",
  pragmas: ["journal_mode = WAL", "synchronous = NORMAL"],
});

await store.write(ref);

const recentHumanAnnotations = await store.find({
  source: "human",
  since: "2026-08-01T00:00:00Z",
  limit: 100,
});

await store.close(); // closes the underlying better-sqlite3 handle
```

The SQLite backend uses schema migration on connect (`CREATE TABLE IF NOT EXISTS` plus four supporting indexes). Idempotent; no data mutation on re-connect against an existing database.

## Usage — Postgres store

```typescript
import { createPostgresEvaluationStore } from "@llm-ports/eval";

const store = createPostgresEvaluationStore({
  connectionString: process.env.DATABASE_URL,
});

await store.write(ref);
await store.close();
```

Pass an existing pool when your application already manages one. A caller-supplied pool is **never closed** by `close()`, since it may be serving the rest of your application; only a pool the store opened itself is closed.

```typescript
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = createPostgresEvaluationStore({ pool, tableName: "llm_eval.evaluations" });
```

Set `skipSchemaSetup: true` when your own migration tooling owns the schema, which is the usual production arrangement. `tableName` is validated against a plain-identifier pattern rather than escaped, because SQL identifiers cannot be bound as parameters.

## The workflow layer (alpha.31.2+)

Storing evaluations is one thing. Producing them in bulk, sampling them for review, and comparing arms is another.

### `OperationSource`: a port, not a second store

**This package stores evaluations, not what was evaluated.** `EvaluationTarget` is a `{ kind, id }` pointer and the sink bridge forwards only `evaluation.recorded` events, so nothing here holds an operation's messages or response. Regression detection is unaffected, because it aggregates scores. Judging, review, and comparison are not.

Rather than adding operation storage here, which would duplicate the log pipeline you already run, you implement a read-only port over whatever already holds your operations:

```typescript
import type { OperationSource } from "@llm-ports/eval";

const source: OperationSource = {
  async get(operationId) { /* one row from your store */ },
  async find(query)      { /* many, newest first */ },
};
```

`createInMemoryOperationSource()` ships as a reference implementation and a worked example of the query semantics.

**Content is optional on purpose.** `CapturePolicy` governs whether request and response content is retained and defaults to strict, so a source may legitimately return an operation with timings, usage, and cost but no messages. Every function here reports that as `content_not_retained` rather than throwing or silently skipping.

### Analysis, which needs no source

```typescript
import { aggregateScores, detectRegression, sampleEvaluations } from "@llm-ports/eval";

const byEvaluator = await aggregateScores(store, "evaluator_name");
const report = await detectRegression(store, { boundary: "2026-08-01T00:00:00.000Z" });
const queue = await sampleEvaluations(store, { size: 25, seed: 1 });
```

Bounded numeric scores normalize to 0..1, so a 1-to-5 rubric and a 0-to-1 rubric are comparable without rescaling. Booleans map to 1 and 0, which makes a mean read as a pass rate. Categorical and text scores are counted rather than averaged.

**`detectRegression` returns deltas and counts, never a verdict.** No significance testing, no pass/fail. Doing significance properly at these sample sizes is a genuine statistical problem, and a confident answer from eleven samples is worse than a number beside the count. Thin groups are listed in `lowSampleKeys`, reported rather than filtered.

`sampleEvaluations` accepts a `seed`, which makes a review queue resumable and a test reproducible.

### Batch judging

```typescript
import { runBatchJudge } from "@llm-ports/eval";

const report = await runBatchJudge({
  source, store,
  query: { task_type: "triage", limit: 500 },
  evaluatorName: "helpfulness",
  evaluatorVersion: "1",
  judge: async (op) => ({
    score: { score_type: "numeric", value: await myScore(op), min: 0, max: 1 },
  }),
});
```

Runs are **idempotent**: ids derive from the operation id plus evaluator name and version, so a re-run writes nothing and reports `duplicates`. Bump `evaluatorVersion` when the rubric changes.

**A budget refusal stops the run.** It does not quietly finish what it can afford. The report carries `stoppedEarly` and `stopReason` alongside the counts, because a partial evaluation that looks complete is worse than a refused one: the numbers are real and the gap in them is invisible.

### A/B comparison

```typescript
// Default: scores the recorded response. Sends nothing, spends nothing.
await runComparison({ source, store, query, arms: ["a", "b"], judge, evaluatorName: "j", comparisonId: "c1" });

// Opt in to real traffic and a real bill.
await runComparison({
  source, store, query, arms: ["fast", "smart"], judge, evaluatorName: "j", comparisonId: "c2",
  replay: async (messages, arm) => (await myPort.generateText({ taskType: arm, messages })).text,
});
```

Omitting `replay` **sends no requests**. Supplying it re-runs each request once per arm, which is a genuine A/B test and costs money. The difference is opt-in precisely because it is a bill.

## Bridging to a Registry sink

Consumers who want the Registry to persist evaluations automatically pass the eval store through the observability-sink bridge:

```typescript
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

Only `evaluation.recorded` events go to the store; lifecycle events (`llm.operation.started`, `llm.attempt.completed`, etc.) are silently ignored by the bridge. Consumers wanting BOTH lifecycle logging AND evaluation storage compose a fan-out sink themselves:

```typescript
const sink = {
  emit(event) {
    logSink.emit(event);
    evalBridgeSink.emit(event);
  },
};
```

## Dedup semantics

- `evaluation_id` is the primary dedup key. Two writes with the same `evaluation_id` produce one row; the second returns `false`.
- `idempotency_key` (optional caller-supplied) takes precedence when set. Use it when the same evaluation may be re-emitted (retries, dataset replay) and consumers must not count it twice.
- First write wins on either key; the second returns `false`.

The guarantee is identical across backends, but Postgres enforces it more strongly. It expresses both constraints in a single `INSERT ... ON CONFLICT DO NOTHING` and reads the exact `rowCount`, so two genuinely concurrent writes of the same id are resolved by the database and exactly one reports `true`. SQLite pre-reads the idempotency key and then catches a unique-constraint error, which leaves a narrow read-then-write window between the two.

## Query surface

`EvaluationQuery` supports filtering by target kind + id, evaluator name + version, rubric id, source, and inclusive `occurred_at` range, plus a `limit`. Ordering is `occurred_at DESC` (most recent first). Consumers wanting ascending order can invert the returned array.

## Non-goals

- **This package never calls a model.** Judges and replay functions are caller-supplied, so evaluation inherits your Registry's routing, fallback, and budget gating rather than reimplementing them. There is no dependency on `@llm-ports/core`.
- **No operation storage.** It stores evaluations, not what was evaluated. Anything needing the prompt or response reads through an `OperationSource` you implement.
- No dashboards or charting. `aggregateScores` and `detectRegression` return numbers; rendering them is yours.
- No significance testing. `detectRegression` reports deltas and counts and deliberately has no verdict field.
- No cross-store replication or sync. Each store is standalone.
- No indexed metadata beyond the SQL columns. Consumers wanting rich metadata filtering should either write their own store implementing `EvaluationStore` or wrap this one.
- No purge / retention policy. Consumers can delete rows out-of-band; the store just doesn't offer a retention primitive today.

## License

MIT.
