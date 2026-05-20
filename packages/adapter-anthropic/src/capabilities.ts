/**
 * Runtime capability discovery for Anthropic's Messages API.
 *
 * Anthropic deprecates parameters per-model (not per-API-version). Newer
 * reasoning-enabled Claude models reject `temperature` with a 400; older
 * models accept it. There's no programmatic way to query the per-model
 * acceptance up front, so the adapter learns at runtime.
 *
 * The Map + accumulation + static-catalog seeding machinery lives in
 * `@llm-ports/core` (`createCapabilityLearner`). This file contributes
 * the Anthropic-specific error classifiers and the known-rejector regex
 * catalog.
 */

import {
  createCapabilityLearner,
  emitFirstLearningWarning,
  type KnownModelConstraint,
  type ModelCapabilities,
} from "@llm-ports/core";

// ─── Process-wide learner shared by this adapter ─────────────────────

const learner = createCapabilityLearner();

/** Get the effective capabilities for a model: user-supplied OR learned at runtime. */
export function getEffectiveCapabilities(
  modelId: string,
  userSupplied: ModelCapabilities | undefined,
): ModelCapabilities {
  return learner.get(modelId, userSupplied);
}

/**
 * Record a discovered constraint. Fires the click-to-file URL warning
 * exactly once per (modelId, capability) pair per process so maintainers
 * see new model behaviors without any telemetry.
 */
export function rememberConstraint(
  modelId: string,
  constraint: Partial<ModelCapabilities>,
  context?: {
    providerErrorMessage?: string;
    adapterVersion?: string;
    sdkVersion?: string;
  },
): void {
  // Identify which capability is being learned for the warning. We only
  // emit a warning for capabilities that weren't already known for this
  // model; the learner's hasLearned check de-duplicates.
  const capabilityFlags = Object.keys(constraint) as (keyof ModelCapabilities)[];
  for (const flag of capabilityFlags) {
    if (!learner.hasLearned(modelId, flag) && context?.providerErrorMessage) {
      emitFirstLearningWarning({
        packageName: "@llm-ports/adapter-anthropic",
        modelId,
        capability: flag,
        providerErrorMessage: context.providerErrorMessage,
        adapterVersion: context.adapterVersion ?? "unknown",
        sdkVersion: context.sdkVersion ?? "unknown",
      });
    }
  }
  learner.remember(modelId, constraint);
}

/** Test-only: clear learned state. */
export function _resetLearnedConstraints(): void {
  learner._reset();
}

// ─── Static catalog of known-rejecting models ─────────────────────────

/**
 * Models we already know reject `temperature`. Pre-seeds the learner so
 * the first call against these models skips the discovery round-trip.
 *
 * Extend this list as Anthropic deprecates `temperature` on more models.
 * Runtime learning catches new rejectors anyway; this catalog only saves
 * the wasted first-call round-trip.
 */
export const KNOWN_TEMPERATURE_REJECTORS: readonly KnownModelConstraint[] = [
  { pattern: /^claude-opus-4-5/, constraints: { temperatureLocked: true } },
  { pattern: /^claude-sonnet-4-5/, constraints: { temperatureLocked: true } },
];

/** Seed the learner with this adapter's known-rejector catalog for a model. */
export function seedKnownConstraints(modelId: string): void {
  learner.seedFromCatalog(modelId, KNOWN_TEMPERATURE_REJECTORS);
}

// ─── Error classification (Anthropic-specific) ────────────────────────

interface AnthropicErrorShape {
  status?: number;
  error?: { type?: unknown; message?: unknown };
}

function getErrorFields(err: unknown): AnthropicErrorShape | null {
  if (!err || typeof err !== "object") return null;
  return err as AnthropicErrorShape;
}

/**
 * True if this is Anthropic rejecting a custom `temperature` value.
 *
 * Observed shape (Claude 4.5+ reasoning models):
 *   {
 *     status: 400,
 *     error: {
 *       type: "invalid_request_error",
 *       message: "`temperature` is deprecated for this model."
 *     }
 *   }
 *
 * The message-based regex also catches related phrasings ("not supported",
 * "unsupported") because Anthropic's exact phrasing evolves.
 */
export function isTemperatureRejection(err: unknown): boolean {
  const fields = getErrorFields(err);
  if (!fields) return false;
  if (fields.status !== 400) return false;
  const message = fields.error?.message;
  if (typeof message !== "string") return false;
  return (
    /temperature/i.test(message) &&
    /(deprecated|not supported|unsupported)/i.test(message)
  );
}

/**
 * Extract the message string from an Anthropic error response. Used to
 * pass the verbatim provider message into the click-to-file warning so
 * maintainers can confirm the exact phrasing.
 */
export function extractAnthropicErrorMessage(err: unknown): string {
  const fields = getErrorFields(err);
  const message = fields?.error?.message;
  return typeof message === "string" ? message : "(no message)";
}
