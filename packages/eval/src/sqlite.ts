/**
 * SQLite implementation of `EvaluationStore` via `better-sqlite3`.
 *
 * Opt-in per-consumer: `better-sqlite3` is declared as an optional
 * peer dependency. Consumers that do NOT install it can still use the
 * in-memory store; calling `createSqliteEvaluationStore` without the
 * peer available throws a helpful error at construction time, not at
 * publish time.
 *
 * Persistence contract:
 *  - Every evaluation is stored as one row in the `evaluations` table.
 *  - Score, correction, and metadata blobs are JSON-encoded strings.
 *  - Dedup: `evaluation_id` is PRIMARY KEY; `idempotency_key` is a
 *    UNIQUE (nullable) column checked before insert. First write
 *    wins for both keys; the second write returns `false` without
 *    modifying the row.
 *  - Schema migration runs on connect: `CREATE TABLE IF NOT EXISTS`
 *    plus four supporting indexes. Idempotent; no data mutation on
 *    re-connect against an existing database.
 *
 * Concurrency: better-sqlite3 is fully synchronous. The async
 * `EvaluationStore` interface is preserved for interface parity with
 * the in-memory store; every method resolves immediately with the
 * synchronous result. Consumers hitting SQLite from a hot loop should
 * consider WAL mode via a caller-supplied `pragmas` option.
 */

import type {
  EvaluationRef,
  EvaluationScore,
  EvaluationSource,
  EvaluationTarget,
} from "@llm-ports/observability-contract";
import type { EvaluationQuery, EvaluationStore, EvaluationTargetKind } from "./types.js";

/** Runtime shape of the `better-sqlite3` Database class we consume. */
interface BetterSqlite3Database {
  exec(sql: string): unknown;
  prepare(sql: string): BetterSqlite3Statement;
  pragma(pragma: string): unknown;
  close(): unknown;
}

interface BetterSqlite3Statement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** better-sqlite3's constructor signature. */
interface BetterSqlite3Constructor {
  new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }): BetterSqlite3Database;
}

/**
 * Options for constructing a SQLite-backed evaluation store.
 */
export interface CreateSqliteEvaluationStoreOptions {
  /**
   * Filesystem path to the SQLite database file. Pass `":memory:"`
   * for an in-process database (useful in tests, but note the
   * in-memory `EvaluationStore` from `./in-memory.js` is a simpler
   * option for that case).
   */
  dbPath: string;

  /**
   * Optional list of SQL `PRAGMA` statements to apply after connect.
   * Common choices: `"journal_mode = WAL"`, `"synchronous = NORMAL"`,
   * `"foreign_keys = ON"`. Applied in order, before schema migration.
   */
  pragmas?: string[];

  /**
   * Escape hatch: supply the `better-sqlite3` constructor explicitly.
   * When omitted, the factory does `require("better-sqlite3")` and
   * throws a helpful error if the module isn't installed. Injecting
   * the constructor is useful in tests, in bundled environments where
   * dynamic require is unavailable, or when using an alternate build
   * (`better-sqlite3-multiple-ciphers`, etc.) with the same API.
   */
  driver?: BetterSqlite3Constructor;
}

/**
 * Construct a durable SQLite-backed evaluation store.
 *
 * @throws {Error} when `better-sqlite3` is not installed and no
 *   `driver` was supplied.
 */
export function createSqliteEvaluationStore(
  options: CreateSqliteEvaluationStoreOptions,
): EvaluationStore {
  const Driver = options.driver ?? loadBetterSqlite3();
  const db = new Driver(options.dbPath);

  if (options.pragmas) {
    for (const pragma of options.pragmas) {
      db.pragma(pragma);
    }
  }

  db.exec(SCHEMA_SQL);

  const stmtInsert = db.prepare(SQL_INSERT);
  const stmtGetById = db.prepare(SQL_GET_BY_ID);
  const stmtGetByIdempotency = db.prepare(SQL_GET_BY_IDEMPOTENCY);
  let closed = false;

  return {
    async write(ref: EvaluationRef): Promise<boolean> {
      if (closed) throw new Error("SqliteEvaluationStore is closed");
      // Idempotency-key dedup takes precedence when set.
      if (ref.idempotency_key !== undefined) {
        const existing = stmtGetByIdempotency.get(ref.idempotency_key);
        if (existing !== undefined) return false;
      }
      const row = refToRow(ref);
      try {
        const result = stmtInsert.run(
          row.evaluation_id,
          row.idempotency_key,
          row.target_kind,
          row.target_id,
          row.evaluator_name,
          row.evaluator_version,
          row.rubric_id,
          row.rubric_version,
          row.score_json,
          row.source,
          row.explanation,
          row.correction_json,
          row.occurred_at,
        );
        return result.changes > 0;
      } catch (err) {
        // Primary-key collision on evaluation_id → dedup hit.
        if (isUniqueConstraintError(err)) return false;
        throw err;
      }
    },

    async get(evaluationId: string): Promise<EvaluationRef | undefined> {
      if (closed) throw new Error("SqliteEvaluationStore is closed");
      const row = stmtGetById.get(evaluationId) as StoredRow | undefined;
      return row ? rowToRef(row) : undefined;
    },

    async find(query: EvaluationQuery): Promise<EvaluationRef[]> {
      if (closed) throw new Error("SqliteEvaluationStore is closed");
      const { sql, params } = buildFindSql(query);
      const rows = db.prepare(sql).all(...params) as StoredRow[];
      return rows.map(rowToRef);
    },

    async count(query?: EvaluationQuery): Promise<number> {
      if (closed) throw new Error("SqliteEvaluationStore is closed");
      const { sql, params } = buildCountSql(query);
      const row = db.prepare(sql).get(...params) as { n: number } | undefined;
      return row?.n ?? 0;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

// ─── Internal: dynamic loading of better-sqlite3 ────────────────────

function loadBetterSqlite3(): BetterSqlite3Constructor {
  try {
    const mod = require("better-sqlite3");
    return (mod?.default ?? mod) as BetterSqlite3Constructor;
  } catch (err) {
    throw new Error(
      "@llm-ports/eval: SQLite backend requires the `better-sqlite3` peer dependency. " +
        "Install it (`npm i better-sqlite3`) or use `createInMemoryEvaluationStore()` instead. " +
        `Underlying error: ${(err as Error).message}`,
    );
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("UNIQUE constraint failed");
}

// ─── SQL constants ──────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS evaluations (
  evaluation_id      TEXT PRIMARY KEY,
  idempotency_key    TEXT UNIQUE,
  target_kind        TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  evaluator_name     TEXT NOT NULL,
  evaluator_version  TEXT,
  rubric_id          TEXT,
  rubric_version     TEXT,
  score_json         TEXT NOT NULL,
  source             TEXT NOT NULL,
  explanation        TEXT,
  correction_json    TEXT,
  occurred_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_target      ON evaluations (target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_eval_evaluator   ON evaluations (evaluator_name);
CREATE INDEX IF NOT EXISTS idx_eval_rubric      ON evaluations (rubric_id);
CREATE INDEX IF NOT EXISTS idx_eval_occurred    ON evaluations (occurred_at);
`;

const SQL_INSERT = `
INSERT INTO evaluations (
  evaluation_id, idempotency_key,
  target_kind, target_id,
  evaluator_name, evaluator_version,
  rubric_id, rubric_version,
  score_json, source, explanation, correction_json, occurred_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SQL_GET_BY_ID = "SELECT * FROM evaluations WHERE evaluation_id = ?";
const SQL_GET_BY_IDEMPOTENCY = "SELECT evaluation_id FROM evaluations WHERE idempotency_key = ?";

// ─── Row shape + serialization ──────────────────────────────────────

interface StoredRow {
  evaluation_id: string;
  idempotency_key: string | null;
  target_kind: string;
  target_id: string;
  evaluator_name: string;
  evaluator_version: string | null;
  rubric_id: string | null;
  rubric_version: string | null;
  score_json: string;
  source: string;
  explanation: string | null;
  correction_json: string | null;
  occurred_at: string;
}

function refToRow(ref: EvaluationRef): StoredRow {
  return {
    evaluation_id: ref.evaluation_id,
    idempotency_key: ref.idempotency_key ?? null,
    target_kind: ref.target.kind,
    target_id: ref.target.id,
    evaluator_name: ref.evaluator_name,
    evaluator_version: ref.evaluator_version ?? null,
    rubric_id: ref.rubric_id ?? null,
    rubric_version: ref.rubric_version ?? null,
    score_json: JSON.stringify(ref.score),
    source: ref.source,
    explanation: ref.explanation ?? null,
    correction_json: ref.correction === undefined ? null : JSON.stringify(ref.correction),
    occurred_at: ref.occurred_at,
  };
}

function rowToRef(row: StoredRow): EvaluationRef {
  const target: EvaluationTarget = {
    kind: row.target_kind as EvaluationTargetKind,
    id: row.target_id,
  } as EvaluationTarget;
  const ref: EvaluationRef = {
    evaluation_id: row.evaluation_id,
    target,
    evaluator_name: row.evaluator_name,
    score: JSON.parse(row.score_json) as EvaluationScore,
    source: row.source as EvaluationSource,
    occurred_at: row.occurred_at,
  };
  if (row.idempotency_key !== null) ref.idempotency_key = row.idempotency_key;
  if (row.evaluator_version !== null) ref.evaluator_version = row.evaluator_version;
  if (row.rubric_id !== null) ref.rubric_id = row.rubric_id;
  if (row.rubric_version !== null) ref.rubric_version = row.rubric_version;
  if (row.explanation !== null) ref.explanation = row.explanation;
  if (row.correction_json !== null) ref.correction = JSON.parse(row.correction_json);
  return ref;
}

// ─── Query builder ──────────────────────────────────────────────────

function buildFindSql(query: EvaluationQuery): { sql: string; params: unknown[] } {
  const { where, params } = buildWhere(query);
  const limit = typeof query.limit === "number" && query.limit >= 0 ? ` LIMIT ${Math.floor(query.limit)}` : "";
  const sql = `SELECT * FROM evaluations${where} ORDER BY occurred_at DESC${limit}`;
  return { sql, params };
}

function buildCountSql(query?: EvaluationQuery): { sql: string; params: unknown[] } {
  if (!query) return { sql: "SELECT COUNT(*) AS n FROM evaluations", params: [] };
  const { where, params } = buildWhere(query);
  return { sql: `SELECT COUNT(*) AS n FROM evaluations${where}`, params };
}

function buildWhere(query: EvaluationQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.target?.kind !== undefined) {
    clauses.push("target_kind = ?");
    params.push(query.target.kind);
  }
  if (query.target?.id !== undefined) {
    clauses.push("target_id = ?");
    params.push(query.target.id);
  }
  if (query.evaluator_name !== undefined) {
    clauses.push("evaluator_name = ?");
    params.push(query.evaluator_name);
  }
  if (query.evaluator_version !== undefined) {
    clauses.push("evaluator_version = ?");
    params.push(query.evaluator_version);
  }
  if (query.rubric_id !== undefined) {
    clauses.push("rubric_id = ?");
    params.push(query.rubric_id);
  }
  if (query.source !== undefined) {
    clauses.push("source = ?");
    params.push(query.source);
  }
  if (query.since !== undefined) {
    clauses.push("occurred_at >= ?");
    params.push(query.since);
  }
  if (query.until !== undefined) {
    clauses.push("occurred_at <= ?");
    params.push(query.until);
  }
  return {
    where: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
    params,
  };
}
