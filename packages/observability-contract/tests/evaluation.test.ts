/**
 * EvaluationRef + EvaluationTarget + EvaluationScore union tests.
 */

import { describe, expect, it } from "vitest";
import {
  EVALUATION_EVENT_TYPE,
  EVALUATION_SCORE_TYPES,
  EVALUATION_TARGET_KINDS,
  newEvaluationId,
  type EvaluationRef,
  type EvaluationScore,
  type EvaluationSource,
  type EvaluationTarget,
} from "../src/index.js";

describe("Evaluation (§4.9)", () => {
  describe("EVALUATION_TARGET_KINDS enumeration", () => {
    it("contains the 7 target kinds", () => {
      expect(EVALUATION_TARGET_KINDS).toHaveLength(7);
      for (const kind of ["operation", "attempt", "response", "agent_step", "trace", "session", "artifact"] as const) {
        expect(EVALUATION_TARGET_KINDS).toContain(kind);
      }
    });

    it("all kinds are unique", () => {
      expect(new Set(EVALUATION_TARGET_KINDS).size).toBe(EVALUATION_TARGET_KINDS.length);
    });
  });

  describe("EVALUATION_SCORE_TYPES enumeration", () => {
    it("contains the 4 score types", () => {
      expect(EVALUATION_SCORE_TYPES).toEqual(["numeric", "boolean", "categorical", "text"]);
    });
  });

  describe("EVALUATION_EVENT_TYPE literal", () => {
    it("is 'evaluation.recorded'", () => {
      expect(EVALUATION_EVENT_TYPE).toBe("evaluation.recorded");
    });
  });

  describe("EvaluationTarget discriminated union", () => {
    it("compiles operation target (points at operation_id)", () => {
      const target: EvaluationTarget = { kind: "operation", id: "op-abc123" };
      expect(target.kind).toBe("operation");
      expect(target.id).toBe("op-abc123");
    });

    it("compiles attempt target (points at attempt_id)", () => {
      const target: EvaluationTarget = { kind: "attempt", id: "att-xyz789" };
      expect(target.kind).toBe("attempt");
    });

    it("compiles response target (provider_response_id like chatcmpl-abc)", () => {
      const target: EvaluationTarget = { kind: "response", id: "chatcmpl-abc123" };
      expect(target.kind).toBe("response");
    });

    it("compiles agent_step target (consumer-defined agent step id)", () => {
      const target: EvaluationTarget = { kind: "agent_step", id: "step-1" };
      expect(target.kind).toBe("agent_step");
    });

    it("compiles trace target (W3C trace-id from traceparent)", () => {
      const target: EvaluationTarget = { kind: "trace", id: "4bf92f3577b34da6a3ce929d0e0e4736" };
      expect(target.kind).toBe("trace");
    });

    it("compiles session target (consumer-defined session id)", () => {
      const target: EvaluationTarget = { kind: "session", id: "sess-42" };
      expect(target.kind).toBe("session");
    });

    it("compiles artifact target (consumer-defined artifact id)", () => {
      const target: EvaluationTarget = { kind: "artifact", id: "pr-123" };
      expect(target.kind).toBe("artifact");
    });

    it("switch narrowing pattern works exhaustively", () => {
      const targets: EvaluationTarget[] = [
        { kind: "operation", id: "op-1" },
        { kind: "attempt", id: "att-1" },
        { kind: "response", id: "resp-1" },
        { kind: "agent_step", id: "step-1" },
        { kind: "trace", id: "trace-1" },
        { kind: "session", id: "sess-1" },
        { kind: "artifact", id: "art-1" },
      ];
      const kinds = targets.map((t) => t.kind);
      expect(new Set(kinds).size).toBe(EVALUATION_TARGET_KINDS.length);
    });
  });

  describe("EvaluationScore discriminated union", () => {
    it("compiles numeric score with optional range hints", () => {
      const s1: EvaluationScore = { score_type: "numeric", value: 0.85 };
      const s2: EvaluationScore = { score_type: "numeric", value: 0.85, min: 0, max: 1 };
      expect(s1.value).toBe(0.85);
      expect(s2.min).toBe(0);
      expect(s2.max).toBe(1);
    });

    it("compiles boolean score (thumbs-up/down, pass/fail)", () => {
      const s: EvaluationScore = { score_type: "boolean", value: true };
      expect(s.value).toBe(true);
    });

    it("compiles categorical score (labeled)", () => {
      const s: EvaluationScore = { score_type: "categorical", value: "high" };
      expect(s.value).toBe("high");
    });

    it("compiles text score (free-form feedback)", () => {
      const s: EvaluationScore = {
        score_type: "text",
        value: "The answer was mostly right but missed the caveat about edge cases.",
      };
      expect(s.value.length).toBeGreaterThan(0);
    });

    it("switch narrowing exhaustive", () => {
      const scores: EvaluationScore[] = [
        { score_type: "numeric", value: 1 },
        { score_type: "boolean", value: false },
        { score_type: "categorical", value: "medium" },
        { score_type: "text", value: "..." },
      ];
      const types = scores.map((s) => s.score_type);
      expect(new Set(types).size).toBe(EVALUATION_SCORE_TYPES.length);
    });
  });

  describe("EvaluationSource enum", () => {
    it("has the four documented values", () => {
      const sources: EvaluationSource[] = ["human", "model", "rule", "api"];
      expect(sources).toHaveLength(4);
    });
  });

  describe("EvaluationRef shape", () => {
    it("compiles the minimum-required fields", () => {
      const ref: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "operation", id: "op-abc" },
        evaluator_name: "reviewer_verdict",
        score: { score_type: "categorical", value: "approved" },
        source: "human",
        occurred_at: "2026-08-05T00:00:00Z",
      };
      expect(ref.evaluator_name).toBe("reviewer_verdict");
    });

    it("compiles the full shape with optional fields", () => {
      const ref: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "attempt", id: "att-42" },
        evaluator_name: "llm_judge_helpfulness",
        evaluator_version: "v3.2",
        rubric_id: "helpfulness_rubric",
        rubric_version: "2026-07-15",
        score: { score_type: "numeric", value: 0.87, min: 0, max: 1 },
        source: "model",
        explanation: "Response addressed the user's question directly and cited the relevant policy.",
        correction: null,
        occurred_at: "2026-08-05T00:15:00Z",
        idempotency_key: "run_abc:eval_42",
      };
      expect(ref.evaluator_version).toBe("v3.2");
      expect(ref.idempotency_key).toBe("run_abc:eval_42");
    });

    it("supports the ADW reviewer-verdict use case", () => {
      // ADW's reviewer verdicts: approved / revision_needed + concerns.
      const approvedVerdict: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "artifact", id: "review-guardrails-slice-3" },
        evaluator_name: "tpm_reviewer",
        rubric_id: "arch_guardrails_v1",
        score: { score_type: "categorical", value: "approved" },
        source: "model",
        explanation: "Guardrails artifact satisfies all functional and non-functional requirements from the approved contract.",
        occurred_at: "2026-07-21T14:52:46Z",
      };

      const revisionVerdict: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "artifact", id: "review-guardrails-slice-3" },
        evaluator_name: "tpm_reviewer",
        rubric_id: "arch_guardrails_v1",
        score: { score_type: "categorical", value: "revision_needed" },
        source: "model",
        explanation: "Concerns: (1) interface X is not documented; (2) contract Y is missing acceptance criteria.",
        occurred_at: "2026-07-21T14:53:12Z",
      };

      expect(approvedVerdict.score.score_type).toBe("categorical");
      expect(revisionVerdict.score.score_type).toBe("categorical");
    });

    it("supports the BEPA approval-outcome use case", () => {
      // BEPA's ApprovalOutcome: approved / edited / rejected / expired / override.
      const approved: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "operation", id: "op-triage-42" },
        evaluator_name: "user_approval",
        score: { score_type: "categorical", value: "approved" },
        source: "human",
        occurred_at: "2026-08-05T09:00:00Z",
      };
      const edited: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "operation", id: "op-triage-42" },
        evaluator_name: "user_approval",
        score: { score_type: "categorical", value: "edited" },
        source: "human",
        correction: "The user edited the draft; keeping the corrected form.",
        occurred_at: "2026-08-05T09:00:00Z",
      };
      expect(approved.score.score_type).toBe("categorical");
      expect(edited.correction).toBeDefined();
    });

    it("supports idempotency key for late-arriving evaluations", () => {
      const key = "dataset_run_42:eval_llm_judge_helpfulness:op-abc";
      const ref: EvaluationRef = {
        evaluation_id: newEvaluationId(),
        target: { kind: "operation", id: "op-abc" },
        evaluator_name: "llm_judge_helpfulness",
        score: { score_type: "numeric", value: 0.9 },
        source: "api",
        occurred_at: "2026-08-05T12:00:00Z",
        idempotency_key: key,
      };
      // Consumer sinks dedup on idempotency_key so a re-run of the
      // dataset evaluation does not count twice.
      expect(ref.idempotency_key).toBe(key);
    });
  });
});
