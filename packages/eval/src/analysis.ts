/**
 * Analysis over an `EvaluationStore`: aggregation, regression detection,
 * and sampling.
 *
 * Everything here reads evaluations only, so none of it needs an
 * `OperationSource`. That is why it ships ahead of judging and A/B
 * comparison: it is useful the moment a consumer has evaluations at all.
 *
 * ## Deltas and counts, never verdicts
 *
 * `detectRegression` reports what changed and how much. It does not say
 * whether the change is significant, and it never returns a pass/fail.
 *
 * That is a deliberate limit, not an omission. Doing significance
 * testing properly on the sample sizes typical here (often tens of
 * evaluations, unevenly distributed across providers) is a real
 * statistical problem, and a library that answers it badly is worse than
 * one that declines to answer. A confident "no regression" computed from
 * eleven samples is actively harmful; the number eleven, next to the
 * delta, lets the reader decide.
 *
 * So every result carries its own sample counts, and the consumer sets
 * the threshold that matters for their domain.
 */

import type { EvaluationRef, EvaluationScore } from "@llm-ports/observability-contract";
import type { EvaluationQuery, EvaluationStore } from "./types.js";

// ─── Score reduction ────────────────────────────────────────────────

/**
 * Reduce a score to a number for aggregation, or `undefined` when it has
 * no meaningful numeric reading.
 *
 * - `numeric` uses its value. When `min` and `max` are both present the
 *   value is normalized to 0..1, so a 1-to-5 rubric and a 0-to-1 rubric
 *   can be compared without the caller rescaling by hand. Without both
 *   bounds the raw value is used, since guessing a scale would silently
 *   distort a mean.
 * - `boolean` maps to 1 and 0, which makes the mean a pass rate.
 * - `categorical` and `text` have no ordering this package can invent,
 *   so they are excluded from numeric aggregation and counted instead.
 */
export function scoreToNumber(score: EvaluationScore): number | undefined {
  switch (score.score_type) {
    case "numeric": {
      if (score.min !== undefined && score.max !== undefined && score.max > score.min) {
        return (score.value - score.min) / (score.max - score.min);
      }
      return score.value;
    }
    case "boolean":
      return score.value ? 1 : 0;
    case "categorical":
    case "text":
      return undefined;
  }
}

// ─── Aggregation ────────────────────────────────────────────────────

/** Which field to group an aggregation by. */
export type GroupByField = "evaluator_name" | "evaluator_version" | "rubric_id" | "source";

export interface ScoreAggregate {
  /** The group's value for the requested field; `"(none)"` when absent. */
  key: string;
  /** Evaluations in this group, including ones with no numeric reading. */
  count: number;
  /** Evaluations that produced a numeric reading. `mean` is over these. */
  numericCount: number;
  /** Arithmetic mean of the numeric readings, or `undefined` when none. */
  mean?: number;
  min?: number;
  max?: number;
  /**
   * Counts per categorical or text value, for groups whose scores do not
   * reduce to numbers. Empty when every score was numeric or boolean.
   */
  categoryCounts: Record<string, number>;
}

/** Aggregate the evaluations matching `query`, grouped by one field. */
export async function aggregateScores(
  store: EvaluationStore,
  groupBy: GroupByField,
  query: EvaluationQuery = {},
): Promise<ScoreAggregate[]> {
  return aggregateRefs(await store.find(query), groupBy);
}

/** Aggregate an already-fetched set of evaluations. Exported for reuse. */
export function aggregateRefs(refs: readonly EvaluationRef[], groupBy: GroupByField): ScoreAggregate[] {
  const groups = new Map<string, EvaluationRef[]>();
  for (const ref of refs) {
    const key = (ref[groupBy] as string | undefined) ?? "(none)";
    const bucket = groups.get(key);
    if (bucket) bucket.push(ref);
    else groups.set(key, [ref]);
  }

  const out: ScoreAggregate[] = [];
  for (const [key, bucket] of groups) {
    const numbers: number[] = [];
    const categoryCounts: Record<string, number> = {};
    for (const ref of bucket) {
      const n = scoreToNumber(ref.score);
      if (n === undefined) {
        const value = String((ref.score as { value: unknown }).value);
        categoryCounts[value] = (categoryCounts[value] ?? 0) + 1;
      } else {
        numbers.push(n);
      }
    }
    const aggregate: ScoreAggregate = {
      key,
      count: bucket.length,
      numericCount: numbers.length,
      categoryCounts,
    };
    if (numbers.length > 0) {
      aggregate.mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
      aggregate.min = Math.min(...numbers);
      aggregate.max = Math.max(...numbers);
    }
    out.push(aggregate);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// ─── Regression detection ───────────────────────────────────────────

export interface RegressionChange {
  key: string;
  /** Mean before the boundary, `undefined` when the group had no numeric scores. */
  beforeMean?: number;
  afterMean?: number;
  /** `afterMean - beforeMean`, `undefined` when either side is missing. */
  delta?: number;
  beforeCount: number;
  afterCount: number;
  /**
   * True when this group exists on only one side of the boundary. Such a
   * group has no delta and is NOT a regression; it is usually a provider
   * that was added or removed. Flagged so a reader does not misread a
   * missing delta as a zero one.
   */
  appearedOrDisappeared: boolean;
}

export interface RegressionReport {
  /** The ISO-8601 instant separating "before" from "after". */
  boundary: string;
  changes: RegressionChange[];
  /** Total evaluations on each side, across all groups. */
  beforeTotal: number;
  afterTotal: number;
  /**
   * Groups whose sample count on either side is below
   * `minSampleSize`. Reported rather than filtered, because "we have
   * too little data here" is itself the useful signal.
   */
  lowSampleKeys: string[];
}

export interface DetectRegressionOptions {
  /** ISO-8601 instant splitting the two windows. Required. */
  boundary: string;
  /** Field to group by. Defaults to `evaluator_name`. */
  groupBy?: GroupByField;
  /** Extra filter applied to both windows. */
  query?: EvaluationQuery;
  /**
   * Groups with fewer than this many evaluations on either side are
   * listed in `lowSampleKeys`. Defaults to 10. This flags thin data; it
   * does not compute significance, and no threshold here turns a delta
   * into a verdict.
   */
  minSampleSize?: number;
}

/**
 * Compare evaluation scores either side of a point in time.
 *
 * Returns deltas and counts. It does not decide whether a change
 * matters, and it deliberately has no notion of "regressed": see the
 * module header for why.
 */
export async function detectRegression(
  store: EvaluationStore,
  options: DetectRegressionOptions,
): Promise<RegressionReport> {
  const groupBy = options.groupBy ?? "evaluator_name";
  const minSampleSize = options.minSampleSize ?? 10;
  const base = options.query ?? {};

  // `until` is inclusive in EvaluationQuery, and `since` is too, so an
  // evaluation exactly ON the boundary would otherwise be counted twice.
  // It is assigned to the "after" window, matching the usual reading of
  // "the change landed at this instant."
  const [before, after] = await Promise.all([
    store.find({ ...base, until: options.boundary }),
    store.find({ ...base, since: options.boundary }),
  ]);
  const beforeRefs = before.filter((r) => r.occurred_at < options.boundary);
  const afterRefs = after.filter((r) => r.occurred_at >= options.boundary);

  const beforeAgg = new Map(aggregateRefs(beforeRefs, groupBy).map((a) => [a.key, a]));
  const afterAgg = new Map(aggregateRefs(afterRefs, groupBy).map((a) => [a.key, a]));

  const changes: RegressionChange[] = [];
  const lowSampleKeys: string[] = [];
  for (const key of [...new Set([...beforeAgg.keys(), ...afterAgg.keys()])].sort()) {
    const b = beforeAgg.get(key);
    const a = afterAgg.get(key);
    const change: RegressionChange = {
      key,
      beforeCount: b?.count ?? 0,
      afterCount: a?.count ?? 0,
      appearedOrDisappeared: b === undefined || a === undefined,
    };
    if (b?.mean !== undefined) change.beforeMean = b.mean;
    if (a?.mean !== undefined) change.afterMean = a.mean;
    if (change.beforeMean !== undefined && change.afterMean !== undefined) {
      change.delta = change.afterMean - change.beforeMean;
    }
    if (change.beforeCount < minSampleSize || change.afterCount < minSampleSize) {
      lowSampleKeys.push(key);
    }
    changes.push(change);
  }

  return {
    boundary: options.boundary,
    changes,
    beforeTotal: beforeRefs.length,
    afterTotal: afterRefs.length,
    lowSampleKeys,
  };
}

// ─── Sampling ───────────────────────────────────────────────────────

export interface SampleOptions {
  /** How many evaluations to return. */
  size: number;
  /** Filter applied before sampling. */
  query?: EvaluationQuery;
  /**
   * Deterministic seed. With a seed, the same store contents and query
   * always yield the same sample, which is what makes a review queue
   * resumable and a test reproducible. Without one, sampling is random.
   */
  seed?: number;
}

/**
 * Draw a sample of evaluations for human review.
 *
 * Note on reviewable content: an evaluation carries a score, an optional
 * explanation, and a pointer to its target. It does not carry the prompt
 * or the response. A reviewer who needs to see what the model did must
 * resolve the target through an `OperationSource`, and whether that
 * yields content depends on the capture policy in force when the
 * operation ran.
 */
export async function sampleEvaluations(
  store: EvaluationStore,
  options: SampleOptions,
): Promise<EvaluationRef[]> {
  const pool = await store.find(options.query ?? {});
  if (options.size >= pool.length) return pool;

  // Fisher-Yates over a copy, drawing from a seeded generator when a seed
  // is supplied so a review queue can be resumed and a test can assert.
  const rand = options.seed === undefined ? Math.random : mulberry32(options.seed);
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, Math.max(0, Math.floor(options.size)));
}

/**
 * Small deterministic PRNG. Not cryptographic, and not trying to be:
 * this seeds a review queue, it does not protect anything.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
