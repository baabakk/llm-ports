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
import type { KnownModelConstraint, ModelCapabilities } from "@llm-ports/core";

// ─── Model-ID normalization (alpha.22+) ──────────────────────────────
//
// OpenAI-compat providers expose models under HuggingFace-style namespaced
// IDs: DeepInfra uses `openai/gpt-oss-120b`, `deepseek-ai/DeepSeek-V4-Flash`,
// `google/gemma-4-31B-it`; Parasail uses `XiaomiMiMo/MiMo-V2.5`; Groq uses
// `openai/gpt-oss-120b`. The same canonical model served by different
// providers shows up with different prefixes (Cerebras's `gpt-oss-120b`
// is the same model as DeepInfra's `openai/gpt-oss-120b`, but the catalog
// patterns are anchored at `^` and don't match the prefixed form).
//
// Architecture choice: rather than maintain a per-(model × provider) regex
// matrix, normalize every model ID to its canonical name (the part after
// the last `/`) before any catalog or learner lookup. The catalog stays a
// small list of anchored patterns against canonical names; new providers
// hosting an already-known model require zero catalog edits.
//
// The raw model ID is still used in the SDK request body — DeepInfra
// expects `openai/gpt-oss-120b`, not `gpt-oss-120b`. Normalization is
// scoped to the capability-learning layer only.
//
// OpenAI-native IDs (`gpt-5`, `o3`, `gpt-4o-mini`) have no slash and pass
// through unchanged. Anthropic + Google adapters don't use namespaced IDs.
//
// See llm-ports#46 / discussion #49 for the originating ADW + Dramma
// findings and the architectural critique that motivated this design.

/**
 * Strip a provider/namespace prefix from a model ID, returning the
 * canonical name. The canonical name is the substring after the last `/`.
 * Model IDs with no `/` pass through unchanged.
 *
 * Examples:
 *   gpt-oss-120b                       → gpt-oss-120b   (OpenAI native, unchanged)
 *   openai/gpt-oss-120b                → gpt-oss-120b   (DeepInfra/Groq form)
 *   deepseek-ai/DeepSeek-V4-Flash      → DeepSeek-V4-Flash
 *   XiaomiMiMo/MiMo-V2.5               → MiMo-V2.5
 *   google/gemma-4-31B-it              → gemma-4-31B-it
 *   models/gemini-2.0-flash            → gemini-2.0-flash
 */
export function normalizeModelId(modelId: string): string {
  const lastSlash = modelId.lastIndexOf("/");
  return lastSlash === -1 ? modelId : modelId.slice(lastSlash + 1);
}

// ─── Process-wide learned constraints (one learner shared by this adapter) ─

const learner = createCapabilityLearner();

/** Get the effective capabilities for a model: user-supplied OR learned at runtime. */
export function getEffectiveCapabilities(
  modelId: string,
  userSupplied: ModelCapabilities | undefined,
): ModelCapabilities {
  return learner.get(normalizeModelId(modelId), userSupplied);
}

/** Record a discovered constraint; used by the adapter after a fallback retry. */
export function rememberConstraint(modelId: string, constraint: Partial<ModelCapabilities>): void {
  learner.remember(normalizeModelId(modelId), constraint);
}

/** Test-only: clear learned state. */
export function _resetLearnedConstraints(): void {
  learner._reset();
}

// ─── Static catalog of known reasoning models ────────────────────────

/**
 * Models we already know exhibit reasoning behavior (hidden chain-of-thought
 * consuming output budget). Pre-seeds the learner so the first call against
 * these models skips the "starve, learn, retry with multiplier" round-trip.
 *
 * The runtime `learnFromResponse` path catches new reasoning models anyway
 * by inspecting `usage.completion_tokens_details.reasoning_tokens` and
 * `choices[0].message.reasoning`. This catalog only saves the first call.
 *
 * Patterns are case-insensitive and tolerate underscore-vs-hyphen +
 * dot-vs-underscore variation, since OpenAI-compat providers normalize
 * model IDs inconsistently (Clarifai uses `Qwen3_6`, others use `qwen-3.6`).
 *
 * Extend this list as new reasoning models ship behind OpenAI-compat
 * baseURLs (Clarifai, SambaNova, Groq, Together AI, Fireworks, Cerebras,
 * Perplexity, DeepInfra, LiteLLM proxy, etc.).
 */
export const KNOWN_REASONING_MODELS: readonly KnownModelConstraint[] = [
  // OpenAI o-series (already learned at runtime; pre-seed saves first call)
  { pattern: /^o1(-|$)/, constraints: { reasoningModel: true } },
  { pattern: /^o3(-|$)/, constraints: { reasoningModel: true } },
  { pattern: /^o4(-|$)/, constraints: { reasoningModel: true } },
  { pattern: /^gpt-5-nano/, constraints: { reasoningModel: true } },
  // Cerebras gpt-oss reasoning lineup (via baseURL=cerebras)
  { pattern: /^gpt-oss-/i, constraints: { reasoningModel: true } },
  // Qwen 3.6 reasoning (Clarifai: Qwen3_6-35B-A3B-FP8; other compats may
  // use qwen-3.6-* or qwen3.6-*).
  { pattern: /^qwen3[._-]?6/i, constraints: { reasoningModel: true } },
  // MiniMax M2.7 reasoning (SambaNova: MiniMax-M2.7).
  { pattern: /^minimax[-_]?m2[._]7/i, constraints: { reasoningModel: true } },
];

/** Seed the learner with this adapter's known-reasoning catalog for a model. */
export function seedKnownConstraints(modelId: string): void {
  learner.seedFromCatalog(normalizeModelId(modelId), KNOWN_REASONING_MODELS);
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
 * True if this error is OpenAI (or an OpenAI-compatible backend) rejecting our
 * `response_format` field. Covers two distinct cause classes that both want the
 * same rescue (downgrade: drop `response_format`, fall back to prompted JSON):
 *
 *  1. **Model doesn't support native JSON mode.** Some reasoning models reject
 *     `response_format: { type: "json_object" }` outright. Error shape:
 *       - structured: `code: "unsupported_value"`, `param: "response_format"`
 *       - message: contains "response_format" + one of "unsupported" / "not support" / "does not"
 *     This was the original alpha.14/.15-era trigger.
 *
 *  2. **Schema is strict-incompatible.** OpenAI native validates the supplied
 *     JSON Schema before generation. Schemas containing open-ended dictionaries
 *     (`z.record(...)`), regex constraints, or other features strict mode can't
 *     express get rejected with errors like:
 *       - `"Invalid schema for response_format... Extra required key 'X' supplied"`
 *       - `"Invalid schema for response_format... 'properties' must be specified"`
 *     The rescue is the same: drop strict mode, drop the schema field, fall back
 *     to prompted JSON. Added alpha.21 after 2026-06-17 probe showed the rescue
 *     was silently dead on OpenAI native's most common structured-output failure
 *     mode. See issue #46.
 */
export function isJsonModeRejection(err: unknown): boolean {
  const fields = getErrorFields(err);
  if (!fields) return false;
  if (
    (fields.code === "unsupported_value" || fields.code === "invalid_value") &&
    fields.param === "response_format"
  ) {
    return true;
  }
  if (
    typeof fields.message === "string" &&
    /response_format/i.test(fields.message) &&
    /(unsupported|not support|does not|invalid schema|extra required|missing required)/i.test(
      fields.message,
    )
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
