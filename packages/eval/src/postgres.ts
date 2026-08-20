/**
 * Postgres implementation of `EvaluationStore` via the `pg` driver.
 *
 * Opt-in per-consumer: `pg` is declared as an optional peer dependency.
 * Consumers that do NOT install it can still use the in-memory or SQLite
 * stores; calling `createPostgresEvaluationStore` without the peer
 * available throws a helpful error at construction time, not at publish
 * time. Same shape as the SQLite backend's `loadBetterSqlite3`.
 *
 * Persistence contract (identical semantics to the SQLite backend, so the
 * two are swappable without changing call sites):
 *  - Every evaluation is stored as one row in the `evaluations` table.
 *  - Score, correction, and metadata blobs are stored as `jsonb`, not
 *    text. SQLite has no JSON column type so it stores strings; Postgres
 *    does, and using it keeps the door open for querying inside a score
 *    later without a migration. The values written are identical.
 *  - Dedup: `evaluation_id` is PRIMARY KEY; `idempotency_key` is a UNIQUE
 *    (nullable) column. First write wins for both keys; the second write
 *    returns `false` without modifying the row.
 *  - Schema migration runs on connect: `CREATE TABLE IF NOT EXISTS` plus
 *    four supporting indexes. Idempotent; no data mutation on re-connect
 *    against an existing database.
 *
 * ## Why dedup is better here than in SQLite
 *
 * The SQLite backend attempts the insert and catches a unique-constraint
 * error to detect a dedup hit, plus does a pre-read when an
 * `idempotency_key` is set. Postgres expresses the whole thing in one
 * statement: `INSERT ... ON CONFLICT DO NOTHING` reports an exact
 * `rowCount`, which IS the boolean the contract asks for. One round trip,
 * no exception-as-control-flow, no read-then-write race between the
 * pre-check and the insert.
 *
 * Concurrency: unlike `better-sqlite3`, `pg` is genuinely asynchronous and
 * pooled. Two concurrent writes of the same `evaluation_id` are resolved
 * by the database rather than by the caller: exactly one reports `true`.
 */

import type {
  EvaluationRef,
  EvaluationScore,
  EvaluationSource,
  EvaluationTarget,
} from "@llm-ports/observability-contract";
import type { EvaluationQuery, EvaluationStore, EvaluationTargetKind } from "./types.js";

/** Runtime shape of the `pg` Pool we consume. Deliberately minimal. */
interface PgQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

/** `pg`'s Pool constructor, as much of it as we use. */
interface PgPoolConstructor {
  new (config?: Record<string, unknown>): PgPool;
}

/**
 * Options for constructing a Postgres-backed evaluation store.
 */
export interface CreatePostgresEvaluationStoreOptions {
  /**
   * Postgres connection string, e.g.
   * `postgresql://user:pass@host:5432/dbname`. Mutually exclusive with
   * `pool`. Passed straight to `new Pool({ connectionString })`.
   */
  connectionString?: string;

  /**
   * An already-constructed `pg.Pool` (or anything with the same `query`
   * and `end` surface). Use this when the consuming application already
   * manages a pool and does not want a second one. When supplied, the
   * store does NOT close the pool on `close()`, because it does not own
   * it — see `close()`.
   */
  pool?: PgPool;

  /**
   * Table name. Defaults to `evaluations`. Provided for consumers who
   * need a prefix or a dedicated schema, e.g. `"llm_eval.evaluations"`.
   * NOT parameterizable at query time (identifiers cannot be bound), so
   * it is validated against a conservative pattern at construction.
   */
  tableName?: string;

  /**
   * Skip `CREATE TABLE IF NOT EXISTS` on connect. Set true when the
   * schema is managed by the application's own migration tooling, which
   * is the common production arrangement. The store then assumes the
   * table exists with the expected columns.
   */
  skipSchemaSetup?: boolean;

  /**
   * Escape hatch: supply the `pg` Pool constructor explicitly. When
   * omitted, the factory does `require("pg")` and throws a helpful error
   * if the module isn't installed. Injecting is useful in tests and in
   * bundled environments where dynamic require is unavailable.
   */
  driver?: PgPoolConstructor;
}

/** Identifiers cannot be bound as parameters, so constrain them hard. */
const SAFE_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * Construct a durable Postgres-backed evaluation store.
 *
 * @throws {Error} when `pg` is not installed and no `driver` or `pool`
 *   was supplied, or when `tableName` is not a plain identifier.
 */
export function createPostgresEvaluationStore(
  options: CreatePostgresEvaluationStoreOptions,
): EvaluationStore {
  const table = options.tableName ?? "evaluations";
  if (!SAFE_TABLE_NAME.test(table)) {
    throw new Error(
      `@llm-ports/eval: tableName ${JSON.stringify(table)} is not a plain SQL identifier. ` +
        "Expected something like `evaluations` or `schema.evaluations`. " +
        "Table names cannot be passed as bound parameters, so this is validated rather than escaped.",
    );
  }

  const ownsPool = options.pool === undefined;
  let pool: PgPool;
  if (options.pool) {
    pool = options.pool;
  } else {
    const Driver = options.driver ?? loadPg();
    pool = new Driver(
      options.connectionString === undefined ? {} : { connectionString: options.connectionString },
    );
  }

  let closed = false;
  // Schema setup is async but the factory is sync, matching the SQLite
  // backend's signature. Every method awaits this before touching the
  // table, so callers cannot observe a partially-migrated database.
  const ready: Promise<void> = options.skipSchemaSetup
    ? Promise.resolve()
    : pool.query(schemaSql(table)).then(() => undefined);
  // A rejected `ready` must not become an unhandled rejection before the
  // first method call attaches its own handler.
  ready.catch(() => {});

  function assertOpen(): void {
    if (closed) throw new Error("PostgresEvaluationStore is closed");
  }

  return {
    async write(ref: EvaluationRef): Promise<boolean> {
      assertOpen();
      await ready;
      const row = refToRow(ref);
      // ON CONFLICT covers BOTH unique constraints (the evaluation_id
      // primary key and the idempotency_key unique index), so a single
      // statement expresses the whole dedup contract. rowCount is 1 when
      // a row was written and 0 when either constraint matched.
      const result = await pool.query(insertSql(table), [
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
      ]);
      return (result.rowCount ?? 0) > 0;
    },

    async get(evaluationId: string): Promise<EvaluationRef | undefined> {
      assertOpen();
      await ready;
      const result = await pool.query(
        `SELECT * FROM ${table} WHERE evaluation_id = $1`,
        [evaluationId],
      );
      const row = result.rows[0] as StoredRow | undefined;
      return row ? rowToRef(row) : undefined;
    },

    async find(query: EvaluationQuery): Promise<EvaluationRef[]> {
      assertOpen();
      await ready;
      const { sql, params } = buildFindSql(table, query);
      const result = await pool.query(sql, params);
      return (result.rows as StoredRow[]).map(rowToRef);
    },

    async count(query?: EvaluationQuery): Promise<number> {
      assertOpen();
      await ready;
      const { sql, params } = buildCountSql(table, query);
      const result = await pool.query(sql, params);
      const row = result.rows[0] as { n: string | number } | undefined;
      // Postgres COUNT(*) comes back as bigint, which `pg` surfaces as a
      // string to avoid precision loss. Number() is safe here: exceeding
      // 2^53 evaluation rows is not a scenario this store is for.
      return row === undefined ? 0 : Number(row.n);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Only end a pool we created. A caller-supplied pool belongs to the
      // caller and may be serving the rest of their application; closing
      // it here would be a surprising side effect of closing this store.
      if (ownsPool) await pool.end();
    },
  };
}

// ─── Internal: dynamic loading of pg ────────────────────────────────

function loadPg(): PgPoolConstructor {
  try {
    // Dynamic-load a CJS optional peer-dep. If the peer is not installed
    // we want to catch the error and re-throw a helpful message; a static
    // import would fail at module load time before the catch can run.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("pg");
    const Pool = (mod?.Pool ?? mod?.default?.Pool) as PgPoolConstructor | undefined;
    if (!Pool) throw new Error("`pg` module did not export a Pool constructor");
    return Pool;
  } catch (err) {
    throw peerMissingError(err);
  }
}

/**
 * The error a consumer sees when the `pg` peer cannot be loaded.
 *
 * Split out of `loadPg` so it can be tested directly. A test that
 * asserted this path by calling the factory would depend on whether `pg`
 * happens to be resolvable in the workspace at that moment, which is not
 * something a test controls: it passes in a clean checkout and fails
 * once anything installs `pg`. Testing the message instead of the
 * module graph keeps the assertion deterministic.
 *
 * @internal Exported for tests, not part of the public API.
 */
export function peerMissingError(cause: unknown): Error {
  return new Error(
    "@llm-ports/eval: Postgres backend requires the `pg` peer dependency. " +
      "Install it (`npm i pg`) or use `createInMemoryEvaluationStore()` / " +
      "`createSqliteEvaluationStore()` instead. " +
      `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

// ─── SQL ────────────────────────────────────────────────────────────

function schemaSql(table: string): string {
  // Index names are derived from the table so two stores on different
  // tables in one database do not collide.
  const prefix = table.replace(/\./g, "_");
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  evaluation_id      TEXT PRIMARY KEY,
  idempotency_key    TEXT UNIQUE,
  target_kind        TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  evaluator_name     TEXT NOT NULL,
  evaluator_version  TEXT,
  rubric_id          TEXT,
  rubric_version     TEXT,
  score_json         JSONB NOT NULL,
  source             TEXT NOT NULL,
  explanation        TEXT,
  correction_json    JSONB,
  occurred_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_${prefix}_target    ON ${table} (target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_${prefix}_evaluator ON ${table} (evaluator_name);
CREATE INDEX IF NOT EXISTS idx_${prefix}_rubric    ON ${table} (rubric_id);
CREATE INDEX IF NOT EXISTS idx_${prefix}_occurred  ON ${table} (occurred_at);
`;
}

function insertSql(table: string): string {
  return `
INSERT INTO ${table} (
  evaluation_id, idempotency_key,
  target_kind, target_id,
  evaluator_name, evaluator_version,
  rubric_id, rubric_version,
  score_json, source, explanation, correction_json, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT DO NOTHING
`;
}

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
  score_json: unknown;
  source: string;
  explanation: string | null;
  correction_json: unknown;
  occurred_at: string | Date;
}

interface InsertRow {
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

function refToRow(ref: EvaluationRef): InsertRow {
  return {
    evaluation_id: ref.evaluation_id,
    idempotency_key: ref.idempotency_key ?? null,
    target_kind: ref.target.kind,
    target_id: ref.target.id,
    evaluator_name: ref.evaluator_name,
    evaluator_version: ref.evaluator_version ?? null,
    rubric_id: ref.rubric_id ?? null,
    rubric_version: ref.rubric_version ?? null,
    // jsonb columns accept a JSON string on the wire and parse it server
    // side, so the serialization here matches the SQLite backend exactly.
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
    // jsonb comes back already parsed from `pg`, unlike SQLite's TEXT.
    // Tolerate a string too, in case a consumer's schema used text.
    score: parseJsonColumn(row.score_json) as EvaluationScore,
    source: row.source as EvaluationSource,
    occurred_at: toIsoString(row.occurred_at),
  };
  if (row.idempotency_key !== null) ref.idempotency_key = row.idempotency_key;
  if (row.evaluator_version !== null) ref.evaluator_version = row.evaluator_version;
  if (row.rubric_id !== null) ref.rubric_id = row.rubric_id;
  if (row.rubric_version !== null) ref.rubric_version = row.rubric_version;
  if (row.explanation !== null) ref.explanation = row.explanation;
  if (row.correction_json !== null && row.correction_json !== undefined) {
    ref.correction = parseJsonColumn(row.correction_json) as EvaluationRef["correction"];
  }
  return ref;
}

function parseJsonColumn(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * `pg` returns TIMESTAMPTZ as a JS Date by default. The contract's
 * `occurred_at` is an ISO-8601 string, so normalize back. A consumer who
 * disabled `pg`'s date parsing gets a string already; pass it through.
 */
function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

// ─── Query builder ──────────────────────────────────────────────────

function buildFindSql(table: string, query: EvaluationQuery): { sql: string; params: unknown[] } {
  const { where, params } = buildWhere(query);
  const limit =
    typeof query.limit === "number" && query.limit >= 0
      ? ` LIMIT ${Math.floor(query.limit)}`
      : "";
  return {
    sql: `SELECT * FROM ${table}${where} ORDER BY occurred_at DESC${limit}`,
    params,
  };
}

function buildCountSql(table: string, query?: EvaluationQuery): { sql: string; params: unknown[] } {
  if (!query) return { sql: `SELECT COUNT(*) AS n FROM ${table}`, params: [] };
  const { where, params } = buildWhere(query);
  return { sql: `SELECT COUNT(*) AS n FROM ${table}${where}`, params };
}

function buildWhere(query: EvaluationQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown): void => {
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  };

  if (query.target?.kind !== undefined) add("target_kind", query.target.kind);
  if (query.target?.id !== undefined) add("target_id", query.target.id);
  if (query.evaluator_name !== undefined) add("evaluator_name", query.evaluator_name);
  if (query.evaluator_version !== undefined) add("evaluator_version", query.evaluator_version);
  if (query.rubric_id !== undefined) add("rubric_id", query.rubric_id);
  if (query.source !== undefined) add("source", query.source);
  if (query.since !== undefined) {
    params.push(query.since);
    clauses.push(`occurred_at >= $${params.length}`);
  }
  if (query.until !== undefined) {
    params.push(query.until);
    clauses.push(`occurred_at <= $${params.length}`);
  }

  return {
    where: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
    params,
  };
}
