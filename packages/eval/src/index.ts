/**
 * @llm-ports/eval — durable storage for post-hoc evaluations.
 *
 * Builds on the `EvaluationRef` / `EvaluationTarget` /
 * `EvaluationScore` types from `@llm-ports/observability-contract`
 * (shipped alpha.28, per Plan 58 §4.9). Consumers construct
 * evaluations using the contract's shape; this package handles
 * storage, retrieval, dedup, and query.
 *
 * Two backends:
 *  - `createInMemoryEvaluationStore()` — no-dependency in-process
 *    store. Ideal for tests and small runtimes.
 *  - `createSqliteEvaluationStore({ dbPath })` — durable SQLite
 *    backend. Peer-dep on `better-sqlite3`; consumers opt in by
 *    installing that package.
 *  - `createPostgresEvaluationStore({ connectionString })` — durable
 *    Postgres backend. Peer-dep on `pg`. Accepts an existing pool
 *    instead, for applications that already manage one.
 *
 * Workflow layer (alpha.31.2):
 *  - `OperationSource` — a read-only port over recorded operations.
 *    This package stores evaluations, not what was evaluated, so
 *    anything needing the prompt or response reads through a source the
 *    consumer implements over infrastructure they already run.
 *  - `aggregateScores` / `detectRegression` / `sampleEvaluations` —
 *    analysis over the store alone; no source required.
 *  - `runBatchJudge` / `runComparison` — judging and A/B comparison.
 *    Both take caller-supplied functions to do the model work, so this
 *    package never calls a model and never depends on `@llm-ports/core`.
 *
 * Bridge for the observability sink:
 *  - `toObservabilitySink(store)` — adapt any `EvaluationStore` to
 *    the contract's `ObservabilitySink` interface, forwarding only
 *    `evaluation.recorded` events. Plug into a Registry's
 *    `instrumentation.config.sink` to persist evaluations
 *    automatically.
 */

export { createInMemoryEvaluationStore } from "./in-memory.js";
export { createSqliteEvaluationStore } from "./sqlite.js";
export type { CreateSqliteEvaluationStoreOptions } from "./sqlite.js";
export { createPostgresEvaluationStore } from "./postgres.js";
export type { CreatePostgresEvaluationStoreOptions } from "./postgres.js";
export { toObservabilitySink } from "./sink-bridge.js";
export type { ToObservabilitySinkOptions } from "./sink-bridge.js";
export type { EvaluationQuery, EvaluationStore, EvaluationTargetKind } from "./types.js";

// ─── Workflow layer (alpha.31.2) ────────────────────────────────────

export { createInMemoryOperationSource } from "./operation-source.js";
export type {
  OperationQuery,
  OperationSource,
  RecordedMessage,
  RecordedOperation,
} from "./operation-source.js";

export {
  aggregateRefs,
  aggregateScores,
  detectRegression,
  sampleEvaluations,
  scoreToNumber,
} from "./analysis.js";
export type {
  DetectRegressionOptions,
  GroupByField,
  RegressionChange,
  RegressionReport,
  SampleOptions,
  ScoreAggregate,
} from "./analysis.js";

export { defaultIsBudgetError, runBatchJudge, runComparison } from "./judge.js";
export type {
  BatchRunReport,
  CompareJudgeFn,
  ComparisonReport,
  JudgeFn,
  JudgeVerdict,
  ReplayFn,
  RunBatchJudgeOptions,
  RunComparisonOptions,
  SkipReason,
  SkippedOperation,
} from "./judge.js";
