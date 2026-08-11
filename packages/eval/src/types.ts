/**
 * Public types for @llm-ports/eval.
 *
 * The package builds ON alpha.28's `@llm-ports/observability-contract`
 * `EvaluationRef` / `EvaluationTarget` / `EvaluationScore` types.
 * Consumers construct `EvaluationRef` values using the contract's
 * shape; this package handles storage, retrieval, and dedup.
 */

import type {
  EvaluationRef,
  EvaluationSource,
  EvaluationTarget,
} from "@llm-ports/observability-contract";

/** Just the `kind` discriminator from `EvaluationTarget`. */
export type EvaluationTargetKind = EvaluationTarget["kind"];

/**
 * Query criteria for finding stored evaluations. All fields are
 * optional; an empty query matches every row.
 *
 * Combined via AND: rows must satisfy every non-undefined field.
 *
 * Ordering is `occurred_at DESC` by default (most recent first);
 * consumers who want ascending order can invert the returned array.
 */
export interface EvaluationQuery {
  /**
   * Filter by target. Nested to support partial target queries:
   * `{ kind: "operation" }` matches every operation evaluation
   * regardless of id; `{ kind: "operation", id: "op-abc" }` matches
   * one specific operation; `{ id: "abc" }` matches any target
   * kind with that id (rare but supported).
   */
  target?: {
    kind?: EvaluationTargetKind;
    id?: string;
  };

  /** Match on `evaluator_name` exactly (case-sensitive). */
  evaluator_name?: string;

  /** Match on `evaluator_version` exactly. */
  evaluator_version?: string;

  /** Match on `rubric_id` exactly. */
  rubric_id?: string;

  /** Match on `source` exactly. */
  source?: EvaluationSource;

  /** Inclusive lower bound on `occurred_at` (ISO-8601 string). */
  since?: string;

  /** Inclusive upper bound on `occurred_at` (ISO-8601 string). */
  until?: string;

  /**
   * Maximum rows to return. Applied AFTER the DESC ordering, so
   * `{ limit: 10 }` returns the 10 most recent matches. Default:
   * no limit (return every match).
   */
  limit?: number;
}

/**
 * The durable evaluation store.
 *
 * Two implementations ship: an in-memory store for tests and small
 * workloads, and a SQLite-backed store for durable production use.
 * Both implement this same surface, so consumers can swap without
 * changing call sites.
 */
export interface EvaluationStore {
  /**
   * Persist one evaluation. Idempotent by `evaluation_id`, or by
   * `idempotency_key` when the caller sets one — a repeat write
   * with the same key is a no-op that returns `false`.
   *
   * @returns `true` when a new row was written; `false` when the
   * evaluation was already present (dedup hit).
   */
  write(ref: EvaluationRef): Promise<boolean>;

  /**
   * Read one evaluation by its `evaluation_id`. Returns `undefined`
   * when no row matches.
   */
  get(evaluationId: string): Promise<EvaluationRef | undefined>;

  /**
   * Find every evaluation matching the query. Ordered by
   * `occurred_at DESC`. Empty query returns every row.
   */
  find(query: EvaluationQuery): Promise<EvaluationRef[]>;

  /**
   * Count evaluations matching the query. Empty or omitted query
   * counts every row.
   */
  count(query?: EvaluationQuery): Promise<number>;

  /**
   * Release any external resources (database handles, file locks).
   * Idempotent. In-memory is a no-op; SQLite closes the underlying
   * `better-sqlite3` handle.
   */
  close(): Promise<void>;
}
