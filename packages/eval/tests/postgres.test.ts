/**
 * @llm-ports/eval — Postgres backend tests.
 *
 * These run against an in-process fake `pg` Pool that implements enough
 * SQL semantics to exercise the store's contract: primary-key and unique
 * dedup via ON CONFLICT, the WHERE builder, DESC ordering, and LIMIT.
 *
 * ## Why a fake rather than a real database
 *
 * The offline suite must run with no network, no container, and no
 * `pg` peer installed, exactly as the SQLite suite runs with no
 * filesystem. The fake is deliberately narrow: it interprets only the
 * statements this store actually issues, and throws on anything it does
 * not recognize, so a future change to the SQL cannot silently pass
 * against a permissive stub.
 *
 * What this suite proves: parameter binding is positional and correctly
 * ordered, the dedup contract holds on both keys, serialization
 * round-trips every optional field and score variant, and query
 * semantics match the SQLite backend. What it does NOT prove: that the
 * DDL is valid Postgres, or that jsonb/TIMESTAMPTZ behave as expected on
 * a real server. That belongs in a live test behind an env guard,
 * alongside the other live suites, and is not part of the offline gate.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvaluationRef } from "@llm-ports/observability-contract";
import {
  createPostgresEvaluationStore,
  type EvaluationStore,
} from "../src/index.js";
import { peerMissingError } from "../src/postgres.js";

// ─── A minimal in-process fake of the `pg` Pool surface ─────────────

interface FakeRow {
  evaluation_id: string;
  idempotency_key: string | null;
  target_kind: string;
  target_id: string;
  evaluator_name: string;
  evaluator_version: string | null;
  rubric_id: string | null;
  rubric_version: string | null;
  score_json: unknown;
  source: string;
  explanation: string | null;
  correction_json: unknown;
  occurred_at: string;
}

const COLUMNS: readonly (keyof FakeRow)[] = [
  "evaluation_id",
  "idempotency_key",
  "target_kind",
  "target_id",
  "evaluator_name",
  "evaluator_version",
  "rubric_id",
  "rubric_version",
  "score_json",
  "source",
  "explanation",
  "correction_json",
  "occurred_at",
];

class FakePool {
  rows: FakeRow[] = [];
  ended = false;
  /** Every statement issued, for assertions about SQL shape. */
  statements: string[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.statements.push(sql);
    const trimmed = sql.trim();

    if (trimmed.startsWith("CREATE TABLE")) return { rows: [], rowCount: 0 };

    if (trimmed.startsWith("INSERT INTO")) {
      const row = Object.fromEntries(
        COLUMNS.map((col, i) => [col, params[i]]),
      ) as unknown as FakeRow;
      // ON CONFLICT DO NOTHING across BOTH unique constraints.
      const collides = this.rows.some(
        (r) =>
          r.evaluation_id === row.evaluation_id ||
          (row.idempotency_key !== null && r.idempotency_key === row.idempotency_key),
      );
      if (collides) return { rows: [], rowCount: 0 };
      // jsonb parses server-side, so reads come back as objects.
      this.rows.push({
        ...row,
        score_json: JSON.parse(row.score_json as unknown as string),
        correction_json:
          row.correction_json === null
            ? null
            : JSON.parse(row.correction_json as unknown as string),
      });
      return { rows: [], rowCount: 1 };
    }

    if (trimmed.startsWith("SELECT")) {
      const isCount = /^SELECT COUNT\(\*\)/i.test(trimmed);
      let matched = this.rows.filter((r) => matchesWhere(r, trimmed, params));
      if (isCount) {
        // Real Postgres returns bigint as a string; mimic that so the
        // store's Number() conversion is actually exercised.
        return { rows: [{ n: String(matched.length) }], rowCount: 1 };
      }
      matched = [...matched].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
      const limit = /LIMIT (\d+)/.exec(trimmed);
      if (limit) matched = matched.slice(0, Number(limit[1]));
      return { rows: matched, rowCount: matched.length };
    }

    throw new Error(`FakePool received an unrecognized statement: ${trimmed.slice(0, 60)}`);
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

/** Interpret the store's generated WHERE clause against one row. */
function matchesWhere(row: FakeRow, sql: string, params: unknown[]): boolean {
  const whereIdx = sql.indexOf(" WHERE ");
  if (whereIdx === -1) return true;
  const clause = sql.slice(whereIdx + 7).split(" ORDER BY ")[0].split(" LIMIT ")[0];
  return clause.split(" AND ").every((part) => {
    const m = /^(\w+)\s*(>=|<=|=)\s*\$(\d+)$/.exec(part.trim());
    if (!m) throw new Error(`FakePool cannot interpret WHERE fragment: ${part}`);
    const [, column, op, idx] = m;
    const actual = row[column as keyof FakeRow];
    const expected = params[Number(idx) - 1];
    if (op === "=") return actual === expected;
    const a = String(actual);
    const b = String(expected);
    return op === ">=" ? a >= b : a <= b;
  });
}

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

describe("Postgres store", () => {
  let pool: FakePool;
  let store: EvaluationStore;

  beforeEach(() => {
    pool = new FakePool();
    store = createPostgresEvaluationStore({ pool });
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
    const ref = makeRef({ evaluation_id: "eval-B", target: { kind: "attempt", id: "att-1" } });
    await store.write(ref);
    const got = await store.get("eval-B");
    expect(got?.evaluation_id).toBe("eval-B");
    expect(got?.target).toEqual({ kind: "attempt", id: "att-1" });
  });

  it("get returns undefined for a missing ID", async () => {
    expect(await store.get("nope")).toBeUndefined();
  });

  it("idempotency_key dedups independently of evaluation_id", async () => {
    // Same idempotency key, DIFFERENT evaluation_id: still a dedup hit.
    // ON CONFLICT covers both unique constraints in one statement, which
    // is what removes SQLite's separate pre-read.
    expect(await store.write(makeRef({ evaluation_id: "e1", idempotency_key: "k" }))).toBe(true);
    expect(await store.write(makeRef({ evaluation_id: "e2", idempotency_key: "k" }))).toBe(false);
    expect(await store.count()).toBe(1);
  });

  it("a null idempotency_key never collides with another null", async () => {
    expect(await store.write(makeRef({ evaluation_id: "n1" }))).toBe(true);
    expect(await store.write(makeRef({ evaluation_id: "n2" }))).toBe(true);
    expect(await store.count()).toBe(2);
  });

  it("preserves all optional fields through a serialization roundtrip", async () => {
    const ref = makeRef({
      evaluation_id: "eval-full",
      idempotency_key: "idem-1",
      evaluator_version: "v2",
      rubric_id: "rubric-x",
      rubric_version: "3",
      explanation: "because",
      correction: { corrected_output: "better" } as EvaluationRef["correction"],
    });
    await store.write(ref);
    const got = await store.get("eval-full");
    expect(got).toEqual(ref);
  });

  it("omits absent optional fields rather than returning nulls", async () => {
    await store.write(makeRef({ evaluation_id: "eval-min" }));
    const got = await store.get("eval-min");
    expect(got).toBeDefined();
    expect("idempotency_key" in got!).toBe(false);
    expect("explanation" in got!).toBe(false);
    expect("correction" in got!).toBe(false);
  });

  it("round-trips every score variant", async () => {
    const scores: EvaluationRef["score"][] = [
      { score_type: "numeric", value: 0.75 },
      { score_type: "boolean", value: true },
      { score_type: "categorical", value: "good" },
    ];
    for (const [i, score] of scores.entries()) {
      await store.write(makeRef({ evaluation_id: `s-${i}`, score }));
      expect((await store.get(`s-${i}`))?.score).toEqual(score);
    }
  });

  // ─── Query semantics ──────────────────────────────────────────

  it("find filters by target kind and id, and orders DESC", async () => {
    await store.write(
      makeRef({
        evaluation_id: "old",
        target: { kind: "operation", id: "op-1" },
        occurred_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    await store.write(
      makeRef({
        evaluation_id: "new",
        target: { kind: "operation", id: "op-1" },
        occurred_at: "2026-06-01T00:00:00.000Z",
      }),
    );
    await store.write(
      makeRef({ evaluation_id: "other", target: { kind: "operation", id: "op-2" } }),
    );

    const found = await store.find({ target: { kind: "operation", id: "op-1" } });
    expect(found.map((r) => r.evaluation_id)).toEqual(["new", "old"]);
  });

  it("find respects an inclusive since / until range", async () => {
    for (const [id, at] of [
      ["a", "2026-01-01T00:00:00.000Z"],
      ["b", "2026-02-01T00:00:00.000Z"],
      ["c", "2026-03-01T00:00:00.000Z"],
    ] as const) {
      await store.write(makeRef({ evaluation_id: id, occurred_at: at }));
    }
    const found = await store.find({
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
    });
    expect(found.map((r) => r.evaluation_id).sort()).toEqual(["a", "b"]);
  });

  it("find respects limit, applied after ordering", async () => {
    for (const [id, at] of [
      ["a", "2026-01-01T00:00:00.000Z"],
      ["b", "2026-02-01T00:00:00.000Z"],
      ["c", "2026-03-01T00:00:00.000Z"],
    ] as const) {
      await store.write(makeRef({ evaluation_id: id, occurred_at: at }));
    }
    expect((await store.find({ limit: 2 })).map((r) => r.evaluation_id)).toEqual(["c", "b"]);
  });

  it("an empty query returns every row", async () => {
    await store.write(makeRef());
    await store.write(makeRef());
    expect(await store.find({})).toHaveLength(2);
  });

  it("applies AND semantics across multiple criteria", async () => {
    await store.write(
      makeRef({ evaluation_id: "hit", evaluator_name: "judge", rubric_id: "r1", source: "model" }),
    );
    await store.write(
      makeRef({ evaluation_id: "miss", evaluator_name: "judge", rubric_id: "r2", source: "model" }),
    );
    const found = await store.find({ evaluator_name: "judge", rubric_id: "r1" });
    expect(found.map((r) => r.evaluation_id)).toEqual(["hit"]);
  });

  it("count with no argument equals the total row count", async () => {
    await store.write(makeRef());
    await store.write(makeRef());
    expect(await store.count()).toBe(2);
  });

  it("count applies the same filter as find", async () => {
    await store.write(makeRef({ evaluator_name: "a" }));
    await store.write(makeRef({ evaluator_name: "b" }));
    expect(await store.count({ evaluator_name: "a" })).toBe(1);
  });

  // ─── Lifecycle ────────────────────────────────────────────────

  it("close is idempotent", async () => {
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("write, get, find and count all throw after close", async () => {
    await store.close();
    await expect(store.write(makeRef())).rejects.toThrow(/closed/);
    await expect(store.get("x")).rejects.toThrow(/closed/);
    await expect(store.find({})).rejects.toThrow(/closed/);
    await expect(store.count()).rejects.toThrow(/closed/);
  });
});

// ─── Pool ownership ─────────────────────────────────────────────────

describe("Postgres store — pool ownership", () => {
  it("does NOT end a caller-supplied pool on close", async () => {
    const pool = new FakePool();
    const store = createPostgresEvaluationStore({ pool });
    await store.close();
    // The caller's pool may be serving the rest of their application.
    expect(pool.ended).toBe(false);
  });

  it("ends a pool it constructed itself on close", async () => {
    const constructed: FakePool[] = [];
    class TrackingPool extends FakePool {
      constructor() {
        super();
        constructed.push(this);
      }
    }
    const store = createPostgresEvaluationStore({
      driver: TrackingPool as unknown as never,
      connectionString: "postgresql://localhost/test",
    });
    await store.close();
    expect(constructed[0]?.ended).toBe(true);
  });
});

// ─── Construction guards ────────────────────────────────────────────

describe("Postgres store — construction", () => {
  it("names the missing peer, the fix, and the underlying cause", () => {
    // Asserted against the error builder rather than by calling the
    // factory, because whether `pg` is resolvable depends on what else
    // the workspace has installed. A test that called the factory would
    // pass in a clean checkout and fail the moment anything pulled `pg`
    // in, which is the module graph deciding the result rather than the
    // code under test.
    const err = peerMissingError(new Error("Cannot find module 'pg'"));
    expect(err.message).toMatch(/requires the `pg` peer dependency/);
    expect(err.message).toMatch(/npm i pg/);
    expect(err.message).toMatch(/createInMemoryEvaluationStore/);
    expect(err.message).toMatch(/Cannot find module 'pg'/);
  });

  it("stringifies a non-Error cause rather than printing [object Object]", () => {
    expect(peerMissingError("boom").message).toMatch(/Underlying error: boom/);
  });

  it("rejects a tableName that is not a plain identifier", () => {
    // Identifiers cannot be bound as parameters, so this is validated
    // rather than escaped. Anything else would be an injection vector.
    for (const bad of ['evals"; DROP TABLE x; --', "evals evals", "1evals", ""]) {
      expect(() => createPostgresEvaluationStore({ pool: new FakePool(), tableName: bad })).toThrow(
        /not a plain SQL identifier/,
      );
    }
  });

  it("accepts a schema-qualified tableName", () => {
    expect(() =>
      createPostgresEvaluationStore({ pool: new FakePool(), tableName: "llm_eval.evaluations" }),
    ).not.toThrow();
  });

  it("skips schema setup when asked", async () => {
    const pool = new FakePool();
    const store = createPostgresEvaluationStore({ pool, skipSchemaSetup: true });
    await store.count();
    expect(pool.statements.some((s) => s.trim().startsWith("CREATE TABLE"))).toBe(false);
    await store.close();
  });

  it("runs schema setup exactly once, not per call", async () => {
    const pool = new FakePool();
    const store = createPostgresEvaluationStore({ pool });
    await store.write(makeRef());
    await store.count();
    await store.find({});
    expect(pool.statements.filter((s) => s.trim().startsWith("CREATE TABLE"))).toHaveLength(1);
    await store.close();
  });
});
