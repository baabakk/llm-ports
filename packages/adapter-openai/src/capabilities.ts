/**
 * Runtime capability discovery for OpenAI-shaped APIs.
 *
 * OpenAI does not expose programmatic capability discovery (no API endpoint
 * tells you "this model rejects custom temperature" or "this model doesn't
 * support response_format: json_object"). Hardcoded capability tables go
 * stale every time a new model ships.
 *
 * Strategy: catch the specific OpenAI error codes that signal a constraint,
 * learn the constraint, remember it for the rest of the process. Subsequent
 * calls don't re-discover; they apply the learned constraint up front.
 *
 * Constraints we discover:
 *   - temperatureLocked: model rejects custom `temperature` value
 *   - jsonModeUnsupported: model rejects `response_format: { type: "json_object" }`
 *   - systemMessageInUserOnly: model rejects a separate `system` message
 *
 * Users who already know their model's constraints can supply them via
 * `ModelCapabilities` in pricingOverrides — that takes precedence over
 * discovery (no first-call learning round-trip).
 *
 * The learner instance + Map machinery is shared across all adapters via
 * `createCapabilityLearner` from `@llm-ports/core`. This file contributes
 * the OpenAI-specific error classifiers.
 */

import { createCapabilityLearner } from "@llm-ports/core";
import type { ModelCapabilities } from "@llm-ports/core";

// ─── Process-wide learned constraints (one learner shared by this adapter) ─

const learner = createCapabilityLearner();

/** Get the effective capabilities for a model: user-supplied OR learned at runtime. */
export function getEffectiveCapabilities(
  modelId: string,
  userSupplied: ModelCapabilities | undefined,
): ModelCapabilities {
  return learner.get(modelId, userSupplied);
}

/** Record a discovered constraint; used by the adapter after a fallback retry. */
export function rememberConstraint(modelId: string, constraint: Partial<ModelCapabilities>): void {
  learner.remember(modelId, constraint);
}

/** Test-only: clear learned state. */
export function _resetLearnedConstraints(): void {
  learner._reset();
}

// ─── Error classification (OpenAI-specific) ──────────────────────────

interface OpenAIErrorShape {
  status?: number;
  code?: unknown;
  param?: unknown;
  type?: unknown;
  message?: unknown;
  error?: { code?: unknown; param?: unknown; type?: unknown; message?: unknown };
}

function getErrorFields(err: unknown): OpenAIErrorShape | null {
  if (!err || typeof err !== "object") return null;
  const e = err as OpenAIErrorShape;
  // OpenAI SDK errors expose these at the top level AND nest them under .error
  return {
    code: e.code ?? e.error?.code,
    param: e.param ?? e.error?.param,
    type: e.type ?? e.error?.type,
    message: e.message ?? e.error?.message,
    status: e.status,
  };
}

/**
 * True if this error is OpenAI rejecting a custom `temperature` value.
 *
 * Observed shapes:
 *   { code: "unsupported_value", param: "temperature", error: { message: "...does not support 0..." } }
 *   { error: { code: "unsupported_value", param: "temperature" } }
 */
export function isTemperatureRejection(err: unknown): boolean {
  const fields = getErrorFields(err);
  if (!fields) return false;
  if (fields.code === "unsupported_value" && fields.param === "temperature") {
    return true;
  }
  // Some providers wrap the message differently; substring fallback
  if (
    typeof fields.message === "string" &&
    /temperature/i.test(fields.message) &&
    /(unsupported|not support|does not)/i.test(fields.message)
  ) {
    return true;
  }
  return false;
}

/**
 * True if this error is OpenAI rejecting `response_format: { type: "json_object" }`.
 * Some reasoning models don't support native JSON mode.
 */
export function isJsonModeRejection(err: unknown): boolean {
  const fields = getErrorFields(err);
  if (!fields) return false;
  if (fields.code === "unsupported_value" && fields.param === "response_format") {
    return true;
  }
  if (
    typeof fields.message === "string" &&
    /response_format/i.test(fields.message) &&
    /(unsupported|not support|does not)/i.test(fields.message)
  ) {
    return true;
  }
  return false;
}

/**
 * True if this error is OpenAI rejecting a separate system message.
 * Some reasoning models require system content folded into the user message.
 */
export function isSystemMessageRejection(err: unknown): boolean {
  const fields = getErrorFields(err);
  if (!fields) return false;
  if (
    typeof fields.message === "string" &&
    /system\b/i.test(fields.message) &&
    /(not support|unsupported|developer message)/i.test(fields.message)
  ) {
    return true;
  }
  return false;
}
