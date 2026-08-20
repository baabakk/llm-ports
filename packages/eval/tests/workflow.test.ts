/**
 * @llm-ports/eval — workflow layer tests (alpha.31.2 part B).
 *
 * Covers the OperationSource port, the analysis functions, batch
 * judging, and A/B comparison. Everything runs against the in-memory
 * store and source, so the suite is offline and has no peer deps.
 *
 * The cases that matter most are the ones asserting the settled
 * decisions from the plan, because those are contract, not behaviour
 * that may drift: content-not-retained is reported rather than thrown,
 * a budget refusal stops the run instead of completing partially,
 * regression detection returns numbers rather than verdicts, and
 * comparison sends no traffic unless replay is explicitly supplied.
 */

import { describe, expect, it } from "vitest";
import type { EvaluationRef } from "@llm-ports/observability-contract";
import {
  aggregateScores,
  createInMemoryEvaluationStore,
  createInMemoryOperationSource,
  defaultIsBudgetError,
  detectRegression,
  runBatchJudge,
  runComparison,
  sampleEvaluations,
  scoreToNumber,
  type EvaluationStore,
  type RecordedOperation,
} from "../src/index.js";

function op(overrides: Partial<RecordedOperation> = {}): RecordedOperation {
  return {
    operation_id: `op-${Math.random().toString(36).slice(2)}`,
    occurred_at: "2026-06-01T00:00:00.000Z",
    task_type: "triage",
    provider_alias: "fast",
    succeeded: true,
    messages: [{ role: "user", content: "hello" }],
    response_text: "hi there",
    ...overrides,
  };
}

function ref(overrides: Partial<EvaluationRef> = {}): EvaluationRef {
  return {
    evaluation_id: `e-${Math.random().toString(36).slice(2)}`,
    target: { kind: "operation", id: "op-1" },
    evaluator_name: "judge",
    score: { score_type: "numeric", value: 1 },
    source: "model",
    occurred_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

async function seeded(refs: EvaluationRef[]): Promise<EvaluationStore> {
  const store = createInMemoryEvaluationStore();
  for (const r of refs) await store.write(r);
  return store;
}

// ─── OperationSource ────────────────────────────────────────────────

describe("createInMemoryOperationSource", () => {
  it("filters, orders descending, and limits", async () => {
    const source = createInMemoryOperationSource([
      op({ operation_id: "a", occurred_at: "2026-01-01T00:00:00.000Z" }),
      op({ operation_id: "b", occurred_at: "2026-02-01T00:00:00.000Z" }),
      op({ operation_id: "c", occurred_at: "2026-03-01T00:00:00.000Z", task_type: "other" }),
    ]);
    expect((await source.find({})).map((o) => o.operation_id)).toEqual(["c", "b", "a"]);
    expect((await source.find({ task_type: "triage" })).map((o) => o.operation_id)).toEqual([
      "b",
      "a",
    ]);
    expect((await source.find({ limit: 1 })).map((o) => o.operation_id)).toEqual(["c"]);
  });

  it("applies since and until inclusively", async () => {
    const source = createInMemoryOperationSource([
      op({ operation_id: "a", occurred_at: "2026-01-01T00:00:00.000Z" }),
      op({ operation_id: "b", occurred_at: "2026-02-01T00:00:00.000Z" }),
    ]);
    const found = await source.find({
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-01T00:00:00.000Z",
    });
    expect(found.map((o) => o.operation_id)).toEqual(["a"]);
  });

  it("get returns undefined for an unknown id", async () => {
    expect(await createInMemoryOperationSource().get("nope")).toBeUndefined();
  });
});

// ─── Score reduction and aggregation ────────────────────────────────

describe("scoreToNumber", () => {
  it("normalizes a bounded numeric score to 0..1", () => {
    // A 1-to-5 rubric and a 0-to-1 rubric must be comparable without the
    // caller rescaling by hand.
    expect(scoreToNumber({ score_type: "numeric", value: 4, min: 1, max: 5 })).toBeCloseTo(0.75);
  });

  it("leaves an unbounded numeric score alone rather than guessing a scale", () => {
    expect(scoreToNumber({ score_type: "numeric", value: 4 })).toBe(4);
  });

  it("maps boolean to 1 and 0 so the mean reads as a pass rate", () => {
    expect(scoreToNumber({ score_type: "boolean", value: true })).toBe(1);
    expect(scoreToNumber({ score_type: "boolean", value: false })).toBe(0);
  });

  it("declines to order categorical and text scores", () => {
    expect(scoreToNumber({ score_type: "categorical", value: "good" })).toBeUndefined();
    expect(scoreToNumber({ score_type: "text", value: "prose" })).toBeUndefined();
  });
});

describe("aggregateScores", () => {
  it("groups, means, and separates numeric from categorical", async () => {
    const store = await seeded([
      ref({ evaluator_name: "a", score: { score_type: "numeric", value: 1 } }),
      ref({ evaluator_name: "a", score: { score_type: "numeric", value: 0 } }),
      ref({ evaluator_name: "b", score: { score_type: "categorical", value: "good" } }),
      ref({ evaluator_name: "b", score: { score_type: "categorical", value: "good" } }),
    ]);
    const [a, b] = await aggregateScores(store, "evaluator_name");
    expect(a).toMatchObject({ key: "a", count: 2, numericCount: 2, mean: 0.5, min: 0, max: 1 });
    // Categorical scores are counted, not averaged, and leave mean unset.
    expect(b).toMatchObject({ key: "b", count: 2, numericCount: 0 });
    expect(b!.mean).toBeUndefined();
    expect(b!.categoryCounts).toEqual({ good: 2 });
  });

  it("buckets a missing group field under (none)", async () => {
    const store = await seeded([ref({})]);
    expect((await aggregateScores(store, "rubric_id"))[0]?.key).toBe("(none)");
  });
});

// ─── Regression detection ───────────────────────────────────────────

describe("detectRegression", () => {
  it("reports deltas and counts, and never a verdict", async () => {
    const store = await seeded([
      ref({ evaluator_name: "j", occurred_at: "2026-01-01T00:00:00.000Z", score: { score_type: "numeric", value: 1 } }),
      ref({ evaluator_name: "j", occurred_at: "2026-01-02T00:00:00.000Z", score: { score_type: "numeric", value: 1 } }),
      ref({ evaluator_name: "j", occurred_at: "2026-03-01T00:00:00.000Z", score: { score_type: "numeric", value: 0 } }),
    ]);
    const report = await detectRegression(store, { boundary: "2026-02-01T00:00:00.000Z" });
    const change = report.changes[0]!;
    expect(change).toMatchObject({ key: "j", beforeMean: 1, afterMean: 0, delta: -1, beforeCount: 2, afterCount: 1 });
    // The shape carries no verdict field at all. Asserting its absence is
    // the point: a consumer cannot come to depend on one.
    expect("regressed" in change).toBe(false);
    expect("significant" in change).toBe(false);
  });

  it("assigns an evaluation exactly on the boundary to the after window", async () => {
    const boundary = "2026-02-01T00:00:00.000Z";
    const store = await seeded([ref({ occurred_at: boundary })]);
    const report = await detectRegression(store, { boundary });
    expect(report.beforeTotal).toBe(0);
    expect(report.afterTotal).toBe(1);
  });

  it("flags a group present on only one side rather than reporting a delta", async () => {
    const store = await seeded([
      ref({ evaluator_name: "gone", occurred_at: "2026-01-01T00:00:00.000Z" }),
      ref({ evaluator_name: "new", occurred_at: "2026-03-01T00:00:00.000Z" }),
    ]);
    const report = await detectRegression(store, { boundary: "2026-02-01T00:00:00.000Z" });
    for (const change of report.changes) {
      expect(change.appearedOrDisappeared).toBe(true);
      expect(change.delta).toBeUndefined();
    }
  });

  it("lists thin groups instead of hiding or judging them", async () => {
    const store = await seeded([
      ref({ occurred_at: "2026-01-01T00:00:00.000Z" }),
      ref({ occurred_at: "2026-03-01T00:00:00.000Z" }),
    ]);
    const report = await detectRegression(store, {
      boundary: "2026-02-01T00:00:00.000Z",
      minSampleSize: 10,
    });
    expect(report.lowSampleKeys).toEqual(["judge"]);
    // Still reported in changes; low sample is a caveat, not a filter.
    expect(report.changes).toHaveLength(1);
  });
});

// ─── Sampling ───────────────────────────────────────────────────────

describe("sampleEvaluations", () => {
  it("returns the whole pool when the sample size meets or exceeds it", async () => {
    const store = await seeded([ref(), ref()]);
    expect(await sampleEvaluations(store, { size: 5 })).toHaveLength(2);
  });

  it("is deterministic for a given seed, so a review queue can resume", async () => {
    const store = await seeded(Array.from({ length: 20 }, (_, i) => ref({ evaluation_id: `e${i}` })));
    const first = await sampleEvaluations(store, { size: 5, seed: 42 });
    const again = await sampleEvaluations(store, { size: 5, seed: 42 });
    expect(again.map((r) => r.evaluation_id)).toEqual(first.map((r) => r.evaluation_id));
  });

  it("draws a different sample for a different seed", async () => {
    const store = await seeded(Array.from({ length: 50 }, (_, i) => ref({ evaluation_id: `e${i}` })));
    const a = await sampleEvaluations(store, { size: 5, seed: 1 });
    const b = await sampleEvaluations(store, { size: 5, seed: 2 });
    expect(a.map((r) => r.evaluation_id)).not.toEqual(b.map((r) => r.evaluation_id));
  });
});

// ─── Batch judging ──────────────────────────────────────────────────

describe("runBatchJudge", () => {
  const good = async () => ({ score: { score_type: "boolean", value: true } as const });

  it("judges and persists, keyed on the operation", async () => {
    const source = createInMemoryOperationSource([op({ operation_id: "o1" })]);
    const store = createInMemoryEvaluationStore();
    const report = await runBatchJudge({ source, store, judge: good, query: {}, evaluatorName: "j" });

    expect(report).toMatchObject({ considered: 1, written: 1, duplicates: 0, stoppedEarly: false });
    const stored = await store.find({ target: { kind: "operation", id: "o1" } });
    expect(stored[0]?.evaluator_name).toBe("j");
    // The contract's value for an LLM-judge-produced score is "model".
    expect(stored[0]?.source).toBe("model");
  });

  it("is idempotent: a re-run writes nothing and reports duplicates", async () => {
    const source = createInMemoryOperationSource([op({ operation_id: "o1" })]);
    const store = createInMemoryEvaluationStore();
    const args = { source, store, judge: good, query: {}, evaluatorName: "j" };
    await runBatchJudge(args);
    const second = await runBatchJudge(args);
    expect(second).toMatchObject({ written: 0, duplicates: 1 });
    expect(await store.count()).toBe(1);
  });

  it("treats a bumped evaluator version as new work", async () => {
    const source = createInMemoryOperationSource([op({ operation_id: "o1" })]);
    const store = createInMemoryEvaluationStore();
    await runBatchJudge({ source, store, judge: good, query: {}, evaluatorName: "j" });
    await runBatchJudge({ source, store, judge: good, query: {}, evaluatorName: "j", evaluatorVersion: "2" });
    expect(await store.count()).toBe(2);
  });

  it("reports content-not-retained rather than throwing", async () => {
    // The settled decision: a strict capture policy is an outcome, not a
    // fault, and must never surface as an exception or a silent skip.
    const source = createInMemoryOperationSource([
      op({ operation_id: "bare", messages: undefined, response_text: undefined }),
    ]);
    const store = createInMemoryEvaluationStore();
    const report = await runBatchJudge({ source, store, judge: good, query: {}, evaluatorName: "j" });
    expect(report.written).toBe(0);
    expect(report.skipped).toEqual([{ operation_id: "bare", reason: "content_not_retained" }]);
  });

  it("skips failed operations unless asked to include them", async () => {
    const source = createInMemoryOperationSource([op({ operation_id: "bad", succeeded: false })]);
    const store = createInMemoryEvaluationStore();
    const base = { source, store, judge: good, query: {}, evaluatorName: "j" };
    expect((await runBatchJudge(base)).skipped[0]?.reason).toBe("operation_failed");
    expect((await runBatchJudge({ ...base, includeFailed: true })).written).toBe(1);
  });

  it("records a declining judge without failing the run", async () => {
    const source = createInMemoryOperationSource([op({ operation_id: "o1" })]);
    const store = createInMemoryEvaluationStore();
    const report = await runBatchJudge({
      source,
      store,
      judge: async () => undefined,
      query: {},
      evaluatorName: "j",
    });
    expect(report.skipped[0]?.reason).toBe("judge_declined");
    expect(report.stoppedEarly).toBe(false);
  });

  it("records a throwing judge as an error and keeps going", async () => {
    const source = createInMemoryOperationSource([
      op({ operation_id: "o1" }),
      op({ operation_id: "o2" }),
    ]);
    const store = createInMemoryEvaluationStore();
    let calls = 0;
    const report = await runBatchJudge({
      source,
      store,
      query: {},
      evaluatorName: "j",
      concurrency: 1,
      judge: async () => {
        if (calls++ === 0) throw new Error("transient");
        return { score: { score_type: "boolean", value: true } as const };
      },
    });
    expect(report.skipped[0]).toMatchObject({ reason: "judge_error", error: "transient" });
    expect(report.written).toBe(1);
    expect(report.stoppedEarly).toBe(false);
  });

  it("STOPS the whole run on a budget refusal rather than finishing partially", async () => {
    // The settled decision. A partial evaluation that looks complete is
    // worse than a refused one, so the report must say it stopped.
    const source = createInMemoryOperationSource(
      Array.from({ length: 10 }, (_, i) => op({ operation_id: `o${i}` })),
    );
    const store = createInMemoryEvaluationStore();
    let calls = 0;
    const report = await runBatchJudge({
      source,
      store,
      query: {},
      evaluatorName: "j",
      concurrency: 1,
      judge: async () => {
        if (++calls > 3) {
          const err = new Error("daily cap reached");
          err.name = "BudgetExceededError";
          throw err;
        }
        return { score: { score_type: "boolean", value: true } as const };
      },
    });
    expect(report.stoppedEarly).toBe(true);
    expect(report.stopReason).toBe("daily cap reached");
    expect(report.written).toBe(3);
    expect(report.considered).toBeLessThan(10);
  });

  it("accepts a custom budget-error classifier", async () => {
    const source = createInMemoryOperationSource([op()]);
    const store = createInMemoryEvaluationStore();
    const report = await runBatchJudge({
      source,
      store,
      query: {},
      evaluatorName: "j",
      isBudgetError: (e) => (e as Error).message === "out of credit",
      judge: async () => {
        throw new Error("out of credit");
      },
    });
    expect(report.stoppedEarly).toBe(true);
  });

  it("honours concurrency without double-judging an operation", async () => {
    const source = createInMemoryOperationSource(
      Array.from({ length: 25 }, (_, i) => op({ operation_id: `o${i}` })),
    );
    const store = createInMemoryEvaluationStore();
    const seen: string[] = [];
    const report = await runBatchJudge({
      source,
      store,
      query: {},
      evaluatorName: "j",
      concurrency: 5,
      judge: async (operation) => {
        seen.push(operation.operation_id);
        return { score: { score_type: "boolean", value: true } as const };
      },
    });
    expect(report.written).toBe(25);
    expect(new Set(seen).size).toBe(25);
  });
});

describe("defaultIsBudgetError", () => {
  it("matches by error name so core need not be imported", () => {
    const budget = new Error("x");
    budget.name = "BudgetExceededError";
    const session = new Error("x");
    session.name = "SessionBudgetExceededError";
    expect(defaultIsBudgetError(budget)).toBe(true);
    expect(defaultIsBudgetError(session)).toBe(true);
    expect(defaultIsBudgetError(new Error("x"))).toBe(false);
    expect(defaultIsBudgetError(undefined)).toBe(false);
  });
});

// ─── A/B comparison ─────────────────────────────────────────────────

describe("runComparison", () => {
  const judge = async () => ({ score: { score_type: "numeric", value: 1 } as const });

  it("refuses a single-arm comparison and says what to use instead", async () => {
    await expect(
      runComparison({
        source: createInMemoryOperationSource(),
        store: createInMemoryEvaluationStore(),
        query: {},
        arms: ["only"],
        judge,
        evaluatorName: "j",
        comparisonId: "c1",
      }),
    ).rejects.toThrow(/at least two arms/);
  });

  it("sends NO traffic by default, scoring the recorded response", async () => {
    // The settled decision: the default mode must never spend money.
    let replayCalls = 0;
    const source = createInMemoryOperationSource([op({ operation_id: "o1" })]);
    const store = createInMemoryEvaluationStore();
    const seen: string[] = [];
    const report = await runComparison({
      source,
      store,
      query: {},
      arms: ["a", "b"],
      evaluatorName: "j",
      comparisonId: "c1",
      judge: async (_o, _arm, text) => {
        seen.push(text);
        replayCalls += 0;
        return { score: { score_type: "numeric", value: 1 } as const };
      },
    });
    expect(report.liveReplay).toBe(false);
    expect(replayCalls).toBe(0);
    expect(seen).toEqual(["hi there", "hi there"]);
    expect(report.perArmWritten).toEqual({ a: 1, b: 1 });
  });

  it("re-runs each request per arm when replay is supplied", async () => {
    const source = createInMemoryOperationSource([op({ operation_id: "o1" })]);
    const store = createInMemoryEvaluationStore();
    const scored: string[] = [];
    const report = await runComparison({
      source,
      store,
      query: {},
      arms: ["fast", "smart"],
      evaluatorName: "j",
      comparisonId: "c2",
      replay: async (_messages, arm) => `response from ${arm}`,
      judge: async (_o, _arm, text) => {
        scored.push(text);
        return { score: { score_type: "numeric", value: 1 } as const };
      },
    });
    expect(report.liveReplay).toBe(true);
    expect(scored).toEqual(["response from fast", "response from smart"]);
  });

  it("needs request content for replay and response content without it", async () => {
    const store = createInMemoryEvaluationStore();
    const base = { store, query: {}, arms: ["a", "b"], judge, evaluatorName: "j" };

    // No messages: fine for stored-output scoring, fatal for replay.
    const noMessages = createInMemoryOperationSource([
      op({ operation_id: "m", messages: undefined }),
    ]);
    expect(
      (await runComparison({ ...base, source: noMessages, comparisonId: "c3" })).written,
    ).toBe(2);
    const replayed = await runComparison({
      ...base,
      source: noMessages,
      comparisonId: "c4",
      replay: async () => "x",
    });
    expect(replayed.skipped[0]?.reason).toBe("content_not_retained");

    // No response: the mirror image.
    const noResponse = createInMemoryOperationSource([
      op({ operation_id: "r", response_text: undefined }),
    ]);
    const stored = await runComparison({ ...base, source: noResponse, comparisonId: "c5" });
    expect(stored.skipped[0]?.reason).toBe("content_not_retained");
  });

  it("groups every arm under one comparison id and is idempotent", async () => {
    const source = createInMemoryOperationSource([op({ operation_id: "o1" })]);
    const store = createInMemoryEvaluationStore();
    const args = {
      source,
      store,
      query: {},
      arms: ["a", "b"],
      judge,
      evaluatorName: "j",
      comparisonId: "cmp",
    };
    await runComparison(args);
    const second = await runComparison(args);
    expect(second).toMatchObject({ written: 0, duplicates: 2 });
    expect(await store.count()).toBe(2);
  });

  it("stops the whole comparison on a budget refusal during replay", async () => {
    const source = createInMemoryOperationSource(
      Array.from({ length: 5 }, (_, i) => op({ operation_id: `o${i}` })),
    );
    const store = createInMemoryEvaluationStore();
    const report = await runComparison({
      source,
      store,
      query: {},
      arms: ["a", "b"],
      judge,
      evaluatorName: "j",
      comparisonId: "cmp",
      concurrency: 1,
      replay: async () => {
        const err = new Error("cap");
        err.name = "SessionBudgetExceededError";
        throw err;
      },
    });
    expect(report.stoppedEarly).toBe(true);
    expect(report.stopReason).toBe("cap");
    expect(report.written).toBe(0);
  });
});
