/**
 * In-memory implementation of `EvaluationStore`. Suitable for tests
 * and small runtime workloads. All operations are O(1) get; O(n)
 * find / count over the stored evaluations.
 *
 * Nothing here persists across process restarts. Consumers wanting
 * durable storage should use `createSqliteEvaluationStore` from the
 * sibling module.
 */

import type { EvaluationRef } from "@llm-ports/observability-contract";
import type { EvaluationQuery, EvaluationStore } from "./types.js";

/**
 * Construct a fresh in-memory evaluation store. Each call produces
 * an independent store; no shared global state.
 */
export function createInMemoryEvaluationStore(): EvaluationStore {
  const byId = new Map<string, EvaluationRef>();
  const byIdempotencyKey = new Map<string, string>(); // idempotency_key → evaluation_id

  return {
    async write(ref: EvaluationRef): Promise<boolean> {
      // Idempotency-key dedup takes precedence when set.
      if (ref.idempotency_key !== undefined) {
        const existing = byIdempotencyKey.get(ref.idempotency_key);
        if (existing !== undefined) {
          return false;
        }
        byIdempotencyKey.set(ref.idempotency_key, ref.evaluation_id);
      }
      // Fall through to evaluation_id dedup.
      if (byId.has(ref.evaluation_id)) {
        return false;
      }
      byId.set(ref.evaluation_id, ref);
      return true;
    },

    async get(evaluationId: string): Promise<EvaluationRef | undefined> {
      return byId.get(evaluationId);
    },

    async find(query: EvaluationQuery): Promise<EvaluationRef[]> {
      const matches: EvaluationRef[] = [];
      for (const ref of byId.values()) {
        if (matchesQuery(ref, query)) matches.push(ref);
      }
      // Sort by occurred_at DESC.
      matches.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
      if (typeof query.limit === "number" && query.limit >= 0) {
        return matches.slice(0, query.limit);
      }
      return matches;
    },

    async count(query?: EvaluationQuery): Promise<number> {
      if (!query) return byId.size;
      let n = 0;
      for (const ref of byId.values()) {
        if (matchesQuery(ref, query)) n++;
      }
      return n;
    },

    async close(): Promise<void> {
      // No external resources to release.
    },
  };
}

/** Row-level predicate the in-memory find + count share. */
function matchesQuery(ref: EvaluationRef, query: EvaluationQuery): boolean {
  if (query.target) {
    if (query.target.kind !== undefined && ref.target.kind !== query.target.kind) return false;
    if (query.target.id !== undefined && ref.target.id !== query.target.id) return false;
  }
  if (query.evaluator_name !== undefined && ref.evaluator_name !== query.evaluator_name) return false;
  if (query.evaluator_version !== undefined && ref.evaluator_version !== query.evaluator_version) return false;
  if (query.rubric_id !== undefined && ref.rubric_id !== query.rubric_id) return false;
  if (query.source !== undefined && ref.source !== query.source) return false;
  if (query.since !== undefined && ref.occurred_at < query.since) return false;
  if (query.until !== undefined && ref.occurred_at > query.until) return false;
  return true;
}
