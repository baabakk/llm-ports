/**
 * Batch judging and A/B comparison over recorded operations.
 *
 * ## This package never calls a model
 *
 * Both functions here take a caller-supplied function that does the
 * model work. Nothing in `@llm-ports/eval` imports `@llm-ports/core`,
 * mirroring the zero-core-dependency rule `@llm-ports/observability-contract`
 * already follows.
 *
 * That is not squeamishness about a dependency. It keeps the layering
 * honest: this package is storage and workflow, and the moment it
 * constructs its own port it starts making routing, budget, and
 * retry decisions that belong to the consumer's Registry. Handing the
 * judge in means judging inherits the caller's governance for free,
 * including fallback chains and budget gating, without this package
 * knowing those exist.
 *
 * ## Budget refusal stops the run
 *
 * A judge run over ten thousand operations is a real spend, and it goes
 * through the caller's port, so their budget gates apply. When one
 * refuses, the run stops and reports.
 *
 * It does not quietly complete what it can afford. A partial evaluation
 * that looks complete is worse than a refused one, because the numbers
 * it produces are real and the gap in them is invisible. Every result
 * therefore carries `stoppedEarly` and the counts needed to see the
 * shortfall.
 */

import type {
  EvaluationRef,
  EvaluationScore,
} from "@llm-ports/observability-contract";
import type { EvaluationStore } from "./types.js";
import type {
  OperationQuery,
  OperationSource,
  RecordedMessage,
  RecordedOperation,
} from "./operation-source.js";

// ─── Shared result shapes ───────────────────────────────────────────

/** Why an operation was not judged. */
export type SkipReason =
  /** Capture policy excluded content, so there is nothing to judge. */
  | "content_not_retained"
  /** The operation itself failed; judging a failure is rarely meaningful. */
  | "operation_failed"
  /** The judge returned undefined, declining to score this one. */
  | "judge_declined"
  /** The judge threw for a reason that was not a budget refusal. */
  | "judge_error";

export interface SkippedOperation {
  operation_id: string;
  reason: SkipReason;
  /** Present when `reason` is `judge_error`. */
  error?: string;
}

export interface BatchRunReport {
  /** Operations the query returned. */
  considered: number;
  /** Evaluations written. Excludes dedup hits. */
  written: number;
  /** Judged successfully but already present, so not rewritten. */
  duplicates: number;
  skipped: SkippedOperation[];
  /**
   * True when a budget refusal ended the run before every operation was
   * considered. When true, `considered` is less than the query would
   * have returned and the report is explicitly incomplete.
   */
  stoppedEarly: boolean;
  /** Present when `stoppedEarly`. The refusal that ended the run. */
  stopReason?: string;
}

// ─── Budget classification ──────────────────────────────────────────

/**
 * Default test for "the caller's budget gate refused this".
 *
 * Matches by error name rather than by `instanceof`, because that would
 * require importing core's error classes and taking the dependency this
 * package deliberately avoids. Name matching is looser, so
 * `isBudgetError` is overridable on both entry points for callers whose
 * errors are shaped differently.
 */
export function defaultIsBudgetError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === "BudgetExceededError" || name === "SessionBudgetExceededError";
}

// ─── Batch judging ──────────────────────────────────────────────────

/**
 * Scores one recorded operation.
 *
 * Return `undefined` to decline without failing the run, which is the
 * right response to an operation the rubric does not apply to. Throw to
 * signal a real error; if the thrown value is classified as a budget
 * refusal the whole run stops.
 */
export type JudgeFn = (
  operation: RecordedOperation,
) => Promise<JudgeVerdict | undefined>;

export interface JudgeVerdict {
  score: EvaluationScore;
  explanation?: string;
  correction?: unknown;
}

export interface RunBatchJudgeOptions {
  source: OperationSource;
  store: EvaluationStore;
  judge: JudgeFn;
  /** Which operations to judge. A `limit` is strongly advised. */
  query: OperationQuery;
  /** Recorded on every evaluation written, and used for dedup identity. */
  evaluatorName: string;
  evaluatorVersion?: string;
  rubricId?: string;
  rubricVersion?: string;
  /** Concurrent judge calls in flight. Defaults to 4. */
  concurrency?: number;
  /** Judge failed operations too. Defaults to false. */
  includeFailed?: boolean;
  /** Override budget-refusal classification. */
  isBudgetError?: (err: unknown) => boolean;
  /**
   * Generates evaluation ids. Defaults to a derivation from the operation
   * id and evaluator identity, which makes a re-run write nothing new
   * rather than duplicating every row.
   */
  evaluationId?: (operation: RecordedOperation) => string;
}

/**
 * Judge a batch of recorded operations and persist the verdicts.
 *
 * Idempotent by construction: both `evaluation_id` and
 * `idempotency_key` default to a derivation of the operation id plus
 * evaluator name and version, so re-running the same batch with the same
 * judge writes nothing and reports the repeats as `duplicates`. Bump
 * `evaluatorVersion` when the rubric changes and the same operations
 * become judgeable again.
 */
export async function runBatchJudge(options: RunBatchJudgeOptions): Promise<BatchRunReport> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const isBudgetError = options.isBudgetError ?? defaultIsBudgetError;
  const identity = `${options.evaluatorName}@${options.evaluatorVersion ?? "0"}`;
  const makeId =
    options.evaluationId ?? ((op: RecordedOperation) => `judge:${identity}:${op.operation_id}`);

  const operations = await options.source.find(options.query);

  const report: BatchRunReport = {
    considered: 0,
    written: 0,
    duplicates: 0,
    skipped: [],
    stoppedEarly: false,
  };

  let cursor = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped) return;
      const index = cursor++;
      const op = operations[index];
      if (op === undefined) return;
      report.considered++;

      if (op.succeeded === false && !options.includeFailed) {
        report.skipped.push({ operation_id: op.operation_id, reason: "operation_failed" });
        continue;
      }
      // Judging needs something to look at. Absent content is a capture
      // policy outcome, not a fault, so it is reported rather than thrown.
      if (op.response_text === undefined && op.messages === undefined) {
        report.skipped.push({ operation_id: op.operation_id, reason: "content_not_retained" });
        continue;
      }

      let verdict: JudgeVerdict | undefined;
      try {
        verdict = await options.judge(op);
      } catch (err) {
        if (isBudgetError(err)) {
          // Stop the whole run. Other workers observe `stopped` and return
          // rather than starting another judge call.
          stopped = true;
          report.stoppedEarly = true;
          report.stopReason = errorMessage(err);
          return;
        }
        report.skipped.push({
          operation_id: op.operation_id,
          reason: "judge_error",
          error: errorMessage(err),
        });
        continue;
      }

      if (verdict === undefined) {
        report.skipped.push({ operation_id: op.operation_id, reason: "judge_declined" });
        continue;
      }

      const ref = buildRef({
        evaluationId: makeId(op),
        idempotencyKey: makeId(op),
        operationId: op.operation_id,
        evaluatorName: options.evaluatorName,
        evaluatorVersion: options.evaluatorVersion,
        rubricId: options.rubricId,
        rubricVersion: options.rubricVersion,
        verdict,
        occurredAt: nowIso(),
      });
      if (await options.store.write(ref)) report.written++;
      else report.duplicates++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return report;
}

// ─── A/B comparison ─────────────────────────────────────────────────

/**
 * Produces a response for one arm of a comparison.
 *
 * Only called in live-replay mode. Receives the recorded request and the
 * arm's label, and returns the arm's response text. The caller decides
 * what the label means: a provider alias, a prompt variant, a model.
 */
export type ReplayFn = (
  messages: readonly RecordedMessage[],
  arm: string,
  operation: RecordedOperation,
) => Promise<string>;

/** Scores one arm's output. Return `undefined` to decline. */
export type CompareJudgeFn = (
  operation: RecordedOperation,
  arm: string,
  responseText: string,
) => Promise<JudgeVerdict | undefined>;

export interface RunComparisonOptions {
  source: OperationSource;
  store: EvaluationStore;
  query: OperationQuery;
  /** Two or more arm labels. With `replay` these are what gets re-run. */
  arms: readonly string[];
  judge: CompareJudgeFn;
  evaluatorName: string;
  evaluatorVersion?: string;
  rubricId?: string;
  rubricVersion?: string;
  /**
   * Groups the arms of one comparison. Written into every evaluation's
   * id so a reader can pull the whole comparison back out.
   */
  comparisonId: string;
  concurrency?: number;
  isBudgetError?: (err: unknown) => boolean;
  /**
   * Live replay. **Omitted by default, and omitting it means no request
   * is sent and no money is spent**: every arm is scored against the
   * response already recorded, which compares what actually ran.
   *
   * Supplying this re-runs each operation's request once per arm through
   * the given function, which sends real traffic and incurs real cost.
   * That is a genuine A/B test rather than a re-reading of history, and
   * it is opt-in precisely because the difference is a bill.
   *
   * Requires `messages` on each operation; operations without retained
   * request content are skipped as `content_not_retained`.
   */
  replay?: ReplayFn;
}

export interface ComparisonReport extends BatchRunReport {
  comparisonId: string;
  /** True when `replay` was supplied and real requests were sent. */
  liveReplay: boolean;
  /** Evaluations written per arm label. */
  perArmWritten: Record<string, number>;
}

/**
 * Compare two or more arms over the same recorded operations, writing
 * one evaluation per operation per arm, all sharing a comparison id.
 *
 * Default mode scores the recorded response for every arm, which is only
 * meaningful when the arms are different judges or rubrics applied to
 * the same output. Supply `replay` to actually re-run each request per
 * arm and compare genuinely different outputs.
 */
export async function runComparison(options: RunComparisonOptions): Promise<ComparisonReport> {
  if (options.arms.length < 2) {
    throw new Error(
      `@llm-ports/eval: runComparison needs at least two arms, received ${options.arms.length}. ` +
        "A one-arm comparison is a batch judge run; use runBatchJudge instead.",
    );
  }

  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const isBudgetError = options.isBudgetError ?? defaultIsBudgetError;
  const operations = await options.source.find(options.query);

  const report: ComparisonReport = {
    comparisonId: options.comparisonId,
    liveReplay: options.replay !== undefined,
    considered: 0,
    written: 0,
    duplicates: 0,
    skipped: [],
    stoppedEarly: false,
    perArmWritten: Object.fromEntries(options.arms.map((a) => [a, 0])),
  };

  let cursor = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped) return;
      const op = operations[cursor++];
      if (op === undefined) return;
      report.considered++;

      if (op.succeeded === false) {
        report.skipped.push({ operation_id: op.operation_id, reason: "operation_failed" });
        continue;
      }
      // Replay needs the request; scoring stored output needs the response.
      const missingContent = options.replay
        ? op.messages === undefined
        : op.response_text === undefined;
      if (missingContent) {
        report.skipped.push({ operation_id: op.operation_id, reason: "content_not_retained" });
        continue;
      }

      for (const arm of options.arms) {
        if (stopped) return;
        let responseText: string;
        try {
          responseText = options.replay
            ? await options.replay(op.messages!, arm, op)
            : op.response_text!;
        } catch (err) {
          if (isBudgetError(err)) {
            stopped = true;
            report.stoppedEarly = true;
            report.stopReason = errorMessage(err);
            return;
          }
          report.skipped.push({
            operation_id: op.operation_id,
            reason: "judge_error",
            error: errorMessage(err),
          });
          break;
        }

        let verdict: JudgeVerdict | undefined;
        try {
          verdict = await options.judge(op, arm, responseText);
        } catch (err) {
          if (isBudgetError(err)) {
            stopped = true;
            report.stoppedEarly = true;
            report.stopReason = errorMessage(err);
            return;
          }
          report.skipped.push({
            operation_id: op.operation_id,
            reason: "judge_error",
            error: errorMessage(err),
          });
          break;
        }

        if (verdict === undefined) {
          report.skipped.push({ operation_id: op.operation_id, reason: "judge_declined" });
          continue;
        }

        const id = `cmp:${options.comparisonId}:${arm}:${op.operation_id}`;
        const ref = buildRef({
          evaluationId: id,
          idempotencyKey: id,
          operationId: op.operation_id,
          evaluatorName: options.evaluatorName,
          evaluatorVersion: options.evaluatorVersion,
          rubricId: options.rubricId,
          rubricVersion: options.rubricVersion,
          verdict,
          occurredAt: nowIso(),
        });
        if (await options.store.write(ref)) {
          report.written++;
          report.perArmWritten[arm] = (report.perArmWritten[arm] ?? 0) + 1;
        } else {
          report.duplicates++;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return report;
}

// ─── Internals ──────────────────────────────────────────────────────

function buildRef(input: {
  evaluationId: string;
  idempotencyKey: string;
  operationId: string;
  evaluatorName: string;
  evaluatorVersion?: string;
  rubricId?: string;
  rubricVersion?: string;
  verdict: JudgeVerdict;
  occurredAt: string;
}): EvaluationRef {
  const ref: EvaluationRef = {
    evaluation_id: input.evaluationId,
    idempotency_key: input.idempotencyKey,
    target: { kind: "operation", id: input.operationId },
    evaluator_name: input.evaluatorName,
    score: input.verdict.score,
    // "model" is the contract's value for an LLM-judge-produced score.
    source: "model",
    occurred_at: input.occurredAt,
  };
  if (input.evaluatorVersion !== undefined) ref.evaluator_version = input.evaluatorVersion;
  if (input.rubricId !== undefined) ref.rubric_id = input.rubricId;
  if (input.rubricVersion !== undefined) ref.rubric_version = input.rubricVersion;
  if (input.verdict.explanation !== undefined) ref.explanation = input.verdict.explanation;
  if (input.verdict.correction !== undefined) ref.correction = input.verdict.correction;
  return ref;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nowIso(): string {
  return new Date().toISOString();
}
