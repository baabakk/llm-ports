/**
 * `OperationSource` — a read-only port over recorded LLM operations.
 *
 * ## Why this exists
 *
 * `EvaluationStore` stores evaluations. It does not store what was
 * evaluated. `EvaluationTarget` is a `{ kind, id }` pointer, and the
 * sink bridge forwards only `evaluation.recorded` events, so nothing in
 * this package holds an operation's messages, response, or parameters.
 *
 * That is fine for regression detection, which aggregates scores. It is
 * not enough for anything that needs to look at what the model actually
 * did: batch judging, human review, or A/B comparison.
 *
 * ## Why a port and not a store
 *
 * The obvious fix is to add durable operation storage here. That would
 * be wrong twice over.
 *
 * Consumers already have this data. One ships lifecycle events into a
 * columnar log store; another keeps them somewhere else. A second store
 * inside this package would duplicate infrastructure they already run
 * and force a choice between two copies of the same rows.
 *
 * And it is against the architecture. This library abstracts external
 * systems behind ports; it does not become one. So the consumer
 * implements this interface over whatever they already have, and the
 * workflow layer reads through it.
 *
 * ## Content is optional, deliberately
 *
 * `CapturePolicy` governs whether request and response content is
 * captured at all, and it defaults to strict, meaning no content. A
 * source is therefore entitled to return an operation with identifiers,
 * timings, usage and cost but no messages and no response text.
 *
 * That is a first-class case, not an error. Every workflow function in
 * this package reports "content not retained" as an explicit outcome
 * rather than throwing or silently skipping, so a consumer whose capture
 * policy excludes content learns that from a result field instead of
 * from an empty report they misread as "nothing to evaluate."
 */

import type { CostUsage, TokenUsage } from "@llm-ports/observability-contract";

/**
 * One message from a recorded operation's request.
 *
 * Structural on purpose. This package does not depend on
 * `@llm-ports/core`, mirroring the zero-core-dependency rule that
 * `@llm-ports/observability-contract` already follows, so the message
 * shape here is the minimum a judge or a replay needs rather than a
 * re-export of the port's richer `LLMMessage`. A source adapting from
 * core's shape maps `content` to text; multimodal parts that do not
 * reduce to text are the source's concern, not this port's.
 */
export interface RecordedMessage {
  role: string;
  content: string;
}

/**
 * A recorded LLM operation, as much of one as the consumer's capture
 * policy retained.
 *
 * Identity and outcome fields are required, because any source worth
 * implementing knows them. Everything a capture policy can suppress is
 * optional.
 */
export interface RecordedOperation {
  /** Correlates with `EvaluationTarget { kind: "operation" }`. */
  operation_id: string;

  /** ISO-8601. Orders results and bounds queries. */
  occurred_at: string;

  /** The routing key the call was made under. */
  task_type?: string;

  /** Which provider alias and model actually served the operation. */
  provider_alias?: string;
  model_id?: string;

  /** Wall-clock duration in milliseconds. */
  duration_ms?: number;

  /** How many provider attempts the operation took, including fallbacks. */
  attempts_made?: number;

  usage?: TokenUsage;
  cost?: CostUsage;

  /**
   * The request as sent. Absent when the capture policy excluded
   * content. Required for A/B replay; without it an operation can be
   * counted but not re-run.
   */
  messages?: RecordedMessage[];

  /**
   * The assistant's response text. Absent when the capture policy
   * excluded content. Required for judging stored outputs.
   */
  response_text?: string;

  /**
   * Whether the operation succeeded. A failed operation is still worth
   * recording and counting, and is normally excluded from judging.
   */
  succeeded?: boolean;

  /** Escape hatch for source-specific fields the workflow layer ignores. */
  metadata?: Record<string, unknown>;
}

/**
 * Query criteria for finding recorded operations. All fields optional;
 * an empty query matches everything the source is willing to return.
 *
 * Deliberately narrower than `EvaluationQuery`. A source may be backed
 * by a columnar store where arbitrary predicates are expensive, so this
 * asks only for filters any reasonable backing store indexes.
 */
export interface OperationQuery {
  task_type?: string;
  provider_alias?: string;
  model_id?: string;
  /** Inclusive lower bound on `occurred_at` (ISO-8601). */
  since?: string;
  /** Inclusive upper bound on `occurred_at` (ISO-8601). */
  until?: string;
  /** Only operations that succeeded, or only those that failed. */
  succeeded?: boolean;
  /**
   * Maximum rows to return, applied after ordering by `occurred_at`
   * descending. A source SHOULD impose its own ceiling regardless: the
   * workflow functions in this package always pass a limit, but a
   * source is the last line of defence against an unbounded scan.
   */
  limit?: number;
}

/**
 * The read-only port. Implement over whatever already holds your
 * operations.
 */
export interface OperationSource {
  /** Fetch one operation by id, or `undefined` when unavailable. */
  get(operationId: string): Promise<RecordedOperation | undefined>;

  /** Find operations matching a query, ordered `occurred_at` descending. */
  find(query: OperationQuery): Promise<RecordedOperation[]>;
}

/**
 * In-memory reference implementation.
 *
 * For tests, small runtimes, and as a worked example of the query
 * semantics a real source should honour. It is not a durable store and
 * makes no attempt to be one; the whole point of the port is that the
 * durable copy lives in the consumer's own infrastructure.
 */
export function createInMemoryOperationSource(
  seed: readonly RecordedOperation[] = [],
): OperationSource & { add(op: RecordedOperation): void; clear(): void } {
  const ops = new Map<string, RecordedOperation>();
  for (const op of seed) ops.set(op.operation_id, op);

  return {
    add(op: RecordedOperation): void {
      ops.set(op.operation_id, op);
    },

    clear(): void {
      ops.clear();
    },

    async get(operationId: string): Promise<RecordedOperation | undefined> {
      return ops.get(operationId);
    },

    async find(query: OperationQuery): Promise<RecordedOperation[]> {
      let out = [...ops.values()].filter((op) => {
        if (query.task_type !== undefined && op.task_type !== query.task_type) return false;
        if (query.provider_alias !== undefined && op.provider_alias !== query.provider_alias) {
          return false;
        }
        if (query.model_id !== undefined && op.model_id !== query.model_id) return false;
        if (query.succeeded !== undefined && op.succeeded !== query.succeeded) return false;
        if (query.since !== undefined && op.occurred_at < query.since) return false;
        if (query.until !== undefined && op.occurred_at > query.until) return false;
        return true;
      });
      out.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
      if (typeof query.limit === "number" && query.limit >= 0) {
        out = out.slice(0, Math.floor(query.limit));
      }
      return out;
    },
  };
}
