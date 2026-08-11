/**
 * @llm-ports/eval — SQLite backend tests.
 *
 * Uses in-process `:memory:` databases so nothing hits the filesystem.
 * Every test constructs its own fresh store; tearDown via close().
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvaluationRef } from "@llm-ports/observability-contract";
import {
  createSqliteEvaluationStore,
  type EvaluationStore,
} from "../src/index.js";

function makeRef(overrides: Partial<EvaluationRef> = {}): EvaluationRef {
  return {
    evaluation_id: `eval-${Math.random().toString(36).slice(2)}`,
    target: { kind: "operation", id: "op-default" },
    evaluator_name: "test_evaluator",
    score: { score_type: "numeric", value: 1 },
    source: "model",
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("SQLite store", () => {
  let store: EvaluationStore;

  beforeEach(() => {
    store = createSqliteEvaluationStore({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    await store.close();
  });

  // ─── Write + get ──────────────────────────────────────────────

  it("write returns true on new insert, false on dedup by evaluation_id", async () => {
    const ref = makeRef({ evaluation_id: "eval-A" });
    expect(await store.write(ref)).toBe(true);
    expect(await store.write(ref)).toBe(false);
  });

  it("get returns the stored ref by evaluation_id", async () => {
    const ref = makeRef({
      evaluation_id: "eval-B",
      explanation: "reasoned rationale",
      score: { score_type: "boolean", value: true },
    });
    await store.write(ref);
    const got = await store.get("eval-B");
    expect(got).toEqual(ref);
  });

  it("get returns undefined for a missing ID", async () => {
    expect(await store.get("missing-id")).toBeUndefined();
  });

  it("idempotency_key takes precedence over evaluation_id for dedup", async () => {
    const first = makeRef({
      evaluation_id: "eval-first",
      idempotency_key: "replay-A",
    });
    const second = makeRef({
      evaluation_id: "eval-second",
      idempotency_key: "replay-A",
    });
    expect(await store.write(first)).toBe(true);
    expect(await store.write(second)).toBe(false);
    expect(await store.get("eval-first")).toBeDefined();
    expect(await store.get("eval-second")).toBeUndefined();
  });

  it("preserves all optional fields through serialization roundtrip", async () => {
    const ref = makeRef({
      evaluation_id: "eval-full",
      target: { kind: "response", id: "chatcmpl-abc123" },
      evaluator_name: "gpt_judge",
      evaluator_version: "2024-Q3",
      rubric_id: "helpfulness",
      rubric_version: "1.4.0",
      score: { score_type: "numeric", value: 0.87, min: 0, max: 1 },
      source: "model",
      explanation: "The response addresses all three sub-questions with citations.",
      correction: { corrected_answer: "42" },
      idempotency_key: "eval-full-key",
      occurred_at: "2026-08-11T09:30:00Z",
    });
    await store.write(ref);
    const got = await store.get("eval-full");
    expect(got).toEqual(ref);
  });

  // ─── Score-shape roundtrip ────────────────────────────────────

  it("supports every score type in the discriminated union", async () => {
    const specs: Array<{ id: string; score: EvaluationRef["score"] }> = [
      { id: "sc-num", score: { score_type: "numeric", value: 0.5, min: 0, max: 1 } },
      { id: "sc-bool", score: { score_type: "boolean", value: false } },
      { id: "sc-cat", score: { score_type: "categorical", value: "high" } },
      { id: "sc-txt", score: { score_type: "text", value: "well-argued but incomplete" } },
    ];
    for (const s of specs) {
      await store.write(makeRef({ evaluation_id: s.id, score: s.score }));
    }
    for (const s of specs) {
      const got = await store.get(s.id);
      expect(got?.score).toEqual(s.score);
    }
  });

  // ─── Find + query filters ─────────────────────────────────────

  it("find filters by target.kind + target.id and orders DESC", async () => {
    await store.write(
      makeRef({
        evaluation_id: "f-1",
        target: { kind: "operation", id: "op-A" },
        occurred_at: "2026-08-10T10:00:00Z",
      }),
    );
    await store.write(
      makeRef({
        evaluation_id: "f-2",
        target: { kind: "operation", id: "op-A" },
        occurred_at: "2026-08-10T12:00:00Z",
      }),
    );
    await store.write(
      makeRef({
        evaluation_id: "f-3",
        target: { kind: "attempt", id: "att-1" },
        occurred_at: "2026-08-11T08:00:00Z",
      }),
    );
    const rows = await store.find({ target: { kind: "operation", id: "op-A" } });
    // Ordered by occurred_at DESC.
    expect(rows.map((r) => r.evaluation_id)).toEqual(["f-2", "f-1"]);
  });

  it("find respects since / until range (inclusive)", async () => {
    await store.write(
      makeRef({
        evaluation_id: "r-1",
        occurred_at: "2026-08-10T10:00:00Z",
      }),
    );
    await store.write(
      makeRef({
        evaluation_id: "r-2",
        occurred_at: "2026-08-11T10:00:00Z",
      }),
    );
    const rows = await store.find({
      since: "2026-08-10T00:00:00Z",
      until: "2026-08-10T23:59:59Z",
    });
    expect(rows.map((r) => r.evaluation_id)).toEqual(["r-1"]);
  });

  it("find respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.write(
        makeRef({
          evaluation_id: `lim-${i}`,
          occurred_at: `2026-08-1${i}T00:00:00Z`,
        }),
      );
    }
    const rows = await store.find({ limit: 3 });
    expect(rows.length).toBe(3);
    // DESC order: lim-4, lim-3, lim-2
    expect(rows[0]!.evaluation_id).toBe("lim-4");
  });

  it("empty query returns every row", async () => {
    for (let i = 0; i < 4; i++) {
      await store.write(makeRef({ evaluation_id: `all-${i}` }));
    }
    const rows = await store.find({});
    expect(rows.length).toBe(4);
  });

  it("AND semantics across multiple criteria", async () => {
    await store.write(
      makeRef({
        evaluation_id: "and-1",
        evaluator_name: "judge_a",
        source: "model",
      }),
    );
    await store.write(
      makeRef({
        evaluation_id: "and-2",
        evaluator_name: "judge_a",
        source: "human",
      }),
    );
    const rows = await store.find({
      evaluator_name: "judge_a",
      source: "model",
    });
    expect(rows.map((r) => r.evaluation_id)).toEqual(["and-1"]);
  });

  // ─── Count ────────────────────────────────────────────────────

  it("count() with no arg equals total row count", async () => {
    await store.write(makeRef());
    await store.write(makeRef());
    expect(await store.count()).toBe(2);
  });

  it("count(query) applies the same filter as find", async () => {
    await store.write(makeRef({ evaluation_id: "c-1", source: "model" }));
    await store.write(makeRef({ evaluation_id: "c-2", source: "human" }));
    expect(await store.count({ source: "model" })).toBe(1);
    expect(await store.count({ source: "human" })).toBe(1);
  });

  // ─── close ────────────────────────────────────────────────────

  it("close() is idempotent", async () => {
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
    // Overriding the afterEach close on the reused variable.
    store = createSqliteEvaluationStore({ dbPath: ":memory:" });
  });

  it("write/get/find after close throws", async () => {
    await store.close();
    await expect(store.write(makeRef())).rejects.toThrow(/closed/);
    await expect(store.get("x")).rejects.toThrow(/closed/);
    await expect(store.find({})).rejects.toThrow(/closed/);
    await expect(store.count()).rejects.toThrow(/closed/);
    // Re-open a fresh store for afterEach's close() call to succeed.
    store = createSqliteEvaluationStore({ dbPath: ":memory:" });
  });
});

// ─── driver-injection escape hatch ──────────────────────────────────

describe("SQLite store — driver injection", () => {
  it("throws helpful error when better-sqlite3 driver is unavailable", () => {
    // Simulate an environment where require() returns nothing sensible.
    const brokenDriver = ((): never => {
      throw new Error("Cannot find module 'better-sqlite3'");
    }) as unknown as new (path: string) => never;
    expect(() => createSqliteEvaluationStore({ dbPath: ":memory:", driver: brokenDriver })).toThrow();
  });
});
