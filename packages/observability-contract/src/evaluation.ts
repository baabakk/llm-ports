/**
 * EvaluationRef + EvaluationTarget per Plan 58 v0.4 §4.9.
 *
 * The write surface for post-hoc scores that consumers attach to
 * observability data. Distinct from lifecycle events because
 * evaluations arrive LATE: an LLM-judge score runs offline, a human
 * annotator labels an interaction hours later, a dataset replay
 * produces retrospective scores days after the original operation.
 *
 * Design decisions per the outsider critique §7:
 *
 *   - Generalized target via discriminated union. Evaluations attach to
 *     operations, attempts, response IDs, agent steps, traces, sessions,
 *     or artifacts. Not hardcoded to operation_id.
 *
 *   - Discriminated score union. Score shape is one of numeric,
 *     boolean, categorical, text; consumer picks the shape when the
 *     evaluation is authored. No "score_type + score_value" pair
 *     where value's type is polymorphic; the union makes the shape
 *     explicit at every use site.
 *
 *   - Dedup key is `evaluation_id` OR caller-supplied `idempotency_key`.
 *     NOT `(target, evaluator_name, timestamp_ms)`, which is unsafe
 *     (retries produce different timestamps; two legitimate
 *     evaluations can share the same name).
 *
 *   - `evaluator_version` and `rubric_id` / `rubric_version` are
 *     first-class fields. Consumers running evaluations against
 *     versioned rubrics can index the results by rubric version and
 *     detect rubric drift over time.
 */

/**
 * Every kind of thing an evaluation can attach to. Covers the four
 * observability-contract entities (operation, attempt, response,
 * agent_step) plus three consumer-domain entities (trace, session,
 * artifact) so consumer sinks can attach LLM-judge scores to
 * higher-level artifacts than a single LLM call.
 */
export type EvaluationTarget =
  | { kind: "operation"; id: string }        // an operation_id
  | { kind: "attempt"; id: string }          // an attempt_id
  | { kind: "response"; id: string }         // provider_response_id (e.g. "chatcmpl-abc")
  | { kind: "agent_step"; id: string }       // an agent step id (consumer-defined)
  | { kind: "trace"; id: string }            // W3C trace-id (from traceparent)
  | { kind: "session"; id: string }          // consumer-defined session id
  | { kind: "artifact"; id: string };        // consumer-defined artifact id (e.g. a doc, review, PR)

/**
 * The set of target kinds as a readonly array; useful for switch
 * exhaustiveness checks or picker UIs.
 */
export const EVALUATION_TARGET_KINDS: readonly EvaluationTarget["kind"][] = [
  "operation",
  "attempt",
  "response",
  "agent_step",
  "trace",
  "session",
  "artifact",
] as const;

/**
 * Discriminated score union. The `score_type` tag names the payload
 * shape unambiguously.
 *
 * - "numeric": a continuous or discrete number; range hints on `min`
 *   and `max` are optional (they document the intended range but do
 *   not enforce validation at emit time).
 * - "boolean": pass/fail, thumbs-up/down.
 * - "categorical": one of a fixed set of labels (e.g. "high", "med",
 *   "low"; consumer-defined labels).
 * - "text": free-form textual feedback.
 */
export type EvaluationScore =
  | { score_type: "numeric"; value: number; min?: number; max?: number }
  | { score_type: "boolean"; value: boolean }
  | { score_type: "categorical"; value: string }
  | { score_type: "text"; value: string };

/**
 * The set of score types as a readonly array; useful for switch
 * exhaustiveness checks.
 */
export const EVALUATION_SCORE_TYPES: readonly EvaluationScore["score_type"][] = [
  "numeric",
  "boolean",
  "categorical",
  "text",
] as const;

/**
 * Where the evaluation came from. "human" is annotator-supplied,
 * "model" is LLM-judge-produced, "rule" is programmatic (regex,
 * predicate), "api" is a scheduled scoring pipeline or external
 * system.
 */
export type EvaluationSource = "human" | "model" | "rule" | "api";

/**
 * The full write surface. Consumers construct these and emit them
 * to any ObservabilitySink via the `evaluation.recorded` event
 * envelope (emitter helpers land in a follow-up commit).
 */
export interface EvaluationRef {
  /** nanoid; primary key for dedup at any sink. */
  evaluation_id: string;

  /** What this evaluation attaches to. */
  target: EvaluationTarget;

  /**
   * Human-readable evaluator name. Examples: "llm_judge_helpfulness",
   * "reviewer_verdict", "human_thumbs_up_down",
   * "regex_pii_check".
   */
  evaluator_name: string;

  /**
   * Version identifier for the evaluator (semver, git sha, whatever
   * consumer picks). Distinct from evaluator_name to keep the two
   * independently orderable across time.
   */
  evaluator_version?: string;

  /**
   * Identifier for the rubric this evaluation was scored against.
   * Consumer-defined; enables "same rubric applied at different
   * times" analysis.
   */
  rubric_id?: string;

  /** Version qualifier for the rubric. */
  rubric_version?: string;

  /** The score itself, as one of the discriminated union shapes. */
  score: EvaluationScore;

  /** Where the evaluation came from. */
  source: EvaluationSource;

  /**
   * Free-form explanation. For LLM-judge scores this is often the
   * chain-of-thought or rationale; for human annotations it's a
   * comment; for rule-based it's optional.
   */
  explanation?: string;

  /**
   * Optional corrected value when the evaluator produced a correction
   * alongside the score (e.g. LangSmith `correction` field). Shape
   * is consumer-defined; typically the corrected structured-output
   * value or corrected text.
   */
  correction?: unknown;

  /** ISO-8601 with timezone; when the evaluation was made. */
  occurred_at: string;

  /**
   * Caller-supplied dedup key. When present, sinks deduplicate on
   * this instead of evaluation_id. Use when the same evaluation may
   * be re-emitted (retries, dataset replay) and consumers must not
   * count it twice.
   */
  idempotency_key?: string;
}

/**
 * The event type name for the emitter helpers (arriving in a follow-up
 * commit). Sinks switching on event_type match this literal.
 */
export const EVALUATION_EVENT_TYPE = "evaluation.recorded" as const;

/**
 * String literal for the event type. Exported as a type so downstream
 * ObservabilityEvent<...> generics can pin it.
 */
export type EvaluationEventType = typeof EVALUATION_EVENT_TYPE;
