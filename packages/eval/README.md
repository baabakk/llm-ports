# @llm-ports/eval

Durable storage for post-hoc evaluations — LLM-judge scores, human annotations, rule-based verdicts, and API-driven scoring pipelines — keyed on the `EvaluationRef` shape from [`@llm-ports/observability-contract`](../observability-contract/README.md).

## Why post-hoc storage

Evaluations arrive **late**. An LLM-judge score runs offline after the request completed. A human annotator labels a conversation hours later. A dataset replay produces retrospective scores days after the original operation. Storing these as append-only rows keyed on `EvaluationRef` makes them queryable per target (operation, attempt, response, agent step, session, artifact) and per evaluator (name, version, rubric, rubric version).

## Backends

Two ship in the box, sharing the same `EvaluationStore` interface:

| Backend | When to use |
|---|---|
| **In-memory** (`createInMemoryEvaluationStore()`) | Tests, ephemeral runtimes, small workloads. No dependencies. Nothing persists across process restart. |
| **SQLite** (`createSqliteEvaluationStore({ dbPath })`) | Durable production storage. Opt-in peer dep on `better-sqlite3`. |

Both implement the same `EvaluationStore` interface, so consumers can swap without changing call sites.

## Install

```bash
npm i @llm-ports/eval @llm-ports/observability-contract
# For SQLite backend only:
npm i better-sqlite3
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
- Both dedup checks happen before insert. First write wins; the second returns `false`.

## Query surface

`EvaluationQuery` supports filtering by target kind + id, evaluator name + version, rubric id, source, and inclusive `occurred_at` range, plus a `limit`. Ordering is `occurred_at DESC` (most recent first). Consumers wanting ascending order can invert the returned array.

## Non-goals

- No aggregation surface (histograms, cohort analysis, dashboards). This package is the write layer; analytics live downstream.
- No cross-store replication or sync. Each store is standalone.
- No indexed metadata beyond the SQL columns. Consumers wanting rich metadata filtering should either write their own store implementing `EvaluationStore` or wrap this one.
- No purge / retention policy. Consumers can delete rows out-of-band; the store just doesn't offer a retention primitive today.

## License

MIT.
