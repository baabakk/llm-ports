/**
 * @llm-ports/eval — in-memory store tests.
 *
 * Covers the CRUD surface, dedup semantics, query filters, ordering,
 * limit, and idempotency-key precedence over evaluation_id.
 */

import { describe, expect, it } from "vitest";
import type { EvaluationRef } from "@llm-ports/observability-contract";
import { createInMemoryEvaluationStore } from "../src/index.js";

// Small helper: produce a valid EvaluationRef with defaulted fields
// so tests can override only what they care about.
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

// ─── Write + get ────────────────────────────────────────────────────

describe("in-memory store — write + get", () => {
  it("write returns true on new insert, false on dedup by evaluation_id", async () => {
    const store = createInMemoryEvaluationStore();
    const ref = makeRef({ evaluation_id: "eval-1" });
    expect(await store.write(ref)).toBe(true);
    expect(await store.write(ref)).toBe(false);
  });

  it("get returns the stored ref by evaluation_id", async () => {
    const store = createInMemoryEvaluationStore();
    const ref = makeRef({
      evaluation_id: "eval-2",
      explanation: "reasoned rationale",
    });
    await store.write(ref);
    const got = await store.get("eval-2");
    expect(got).toEqual(ref);
  });

  it("get returns undefined for a missing ID", async () => {
    const store = createInMemoryEvaluationStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("idempotency_key takes precedence over evaluation_id for dedup", async () => {
    const store = createInMemoryEvaluationStore();
    const first = makeRef({
      evaluation_id: "eval-first",
      idempotency_key: "replay-key-A",
    });
    const second = makeRef({
      evaluation_id: "eval-second", // different ID
      idempotency_key: "replay-key-A", // same idempotency key
    });
    expect(await store.write(first)).toBe(true);
    expect(await store.write(second)).toBe(false);
    expect(await store.get("eval-first")).toBeDefined();
    expect(await store.get("eval-second")).toBeUndefined(); // second was deduped
  });
});

// ─── Find + query filters ───────────────────────────────────────────

describe("in-memory store — find with query filters", () => {
  async function seed() {
    const store = createInMemoryEvaluationStore();
    await store.write(
      makeRef({
        evaluation_id: "e1",
        target: { kind: "operation", id: "op-A" },
        evaluator_name: "judge_a",
        source: "model",
        occurred_at: "2026-08-10T10:00:00Z",
      }),
    );
    await store.write(
      makeRef({
        evaluation_id: "e2",
        target: { kind: "operation", id: "op-A" },
        evaluator_name: "judge_b",
        source: "human",
        occurred_at: "2026-08-10T12:00:00Z",
      }),
    );
    await store.write(
      makeRef({
        evaluation_id: "e3",
        target: { kind: "attempt", id: "att-1" },
        evaluator_name: "judge_a",
        source: "model",
        occurred_at: "2026-08-11T08:00:00Z",
      }),
    );
    return store;
  }

  it("filters by target.kind + target.id", async () => {
    const store = await seed();
    const rows = await store.find({ target: { kind: "operation", id: "op-A" } });
    expect(rows.map((r) => r.evaluation_id).sort()).toEqual(["e1", "e2"]);
  });

  it("filters by target.kind only", async () => {
    const store = await seed();
    const rows = await store.find({ target: { kind: "attempt" } });
    expect(rows.map((r) => r.evaluation_id)).toEqual(["e3"]);
  });

  it("filters by evaluator_name", async () => {
    const store = await seed();
    const rows = await store.find({ evaluator_name: "judge_a" });
    // ordered DESC by occurred_at: e3 (Aug 11) before e1 (Aug 10)
    expect(rows.map((r) => r.evaluation_id)).toEqual(["e3", "e1"]);
  });

  it("filters by source", async () => {
    const store = await seed();
    const rows = await store.find({ source: "human" });
    expect(rows.map((r) => r.evaluation_id)).toEqual(["e2"]);
  });

  it("filters by since / until range (inclusive)", async () => {
    const store = await seed();
    const rows = await store.find({
      since: "2026-08-10T11:00:00Z",
      until: "2026-08-10T13:00:00Z",
    });
    expect(rows.map((r) => r.evaluation_id)).toEqual(["e2"]);
  });

  it("orders results by occurred_at DESC", async () => {
    const store = await seed();
    const rows = await store.find({});
    expect(rows.map((r) => r.evaluation_id)).toEqual(["e3", "e2", "e1"]);
  });

  it("respects limit", async () => {
    const store = await seed();
    const rows = await store.find({ limit: 2 });
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.evaluation_id)).toEqual(["e3", "e2"]);
  });

  it("empty query returns every row", async () => {
    const store = await seed();
    expect((await store.find({})).length).toBe(3);
  });

  it("AND semantics across multiple criteria", async () => {
    const store = await seed();
    const rows = await store.find({
      target: { kind: "operation" },
      evaluator_name: "judge_a",
    });
    expect(rows.map((r) => r.evaluation_id)).toEqual(["e1"]);
  });
});

// ─── Count ──────────────────────────────────────────────────────────

describe("in-memory store — count", () => {
  it("count() with no arg equals total row count", async () => {
    const store = createInMemoryEvaluationStore();
    await store.write(makeRef({ evaluation_id: "c-1" }));
    await store.write(makeRef({ evaluation_id: "c-2" }));
    expect(await store.count()).toBe(2);
  });

  it("count(query) applies the same filter as find", async () => {
    const store = createInMemoryEvaluationStore();
    await store.write(
      makeRef({
        evaluation_id: "c-1",
        source: "model",
      }),
    );
    await store.write(
      makeRef({
        evaluation_id: "c-2",
        source: "human",
      }),
    );
    expect(await store.count({ source: "model" })).toBe(1);
    expect(await store.count({ source: "human" })).toBe(1);
  });
});

// ─── close ──────────────────────────────────────────────────────────

describe("in-memory store — close", () => {
  it("close() is a no-op that resolves", async () => {
    const store = createInMemoryEvaluationStore();
    await expect(store.close()).resolves.toBeUndefined();
    // Idempotent: safe to call twice.
    await expect(store.close()).resolves.toBeUndefined();
  });
});
