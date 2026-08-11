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
export { toObservabilitySink } from "./sink-bridge.js";
export type { ToObservabilitySinkOptions } from "./sink-bridge.js";
export type { EvaluationQuery, EvaluationStore, EvaluationTargetKind } from "./types.js";
