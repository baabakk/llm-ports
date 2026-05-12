/**
 * Error classes thrown by @llm-ports/core and re-exported for use by adapters
 * and capabilities. All errors extend the standard Error class so they integrate
 * cleanly with try/catch, logging, and observability tooling.
 */

import type { ZodIssue } from "zod";

/** Thrown when a provider's request budget (count or USD) is exhausted. */
export class BudgetExceededError extends Error {
  public override readonly name = "BudgetExceededError";
  constructor(
    public readonly alias: string,
    public readonly limit: number,
    public readonly current: number,
    public readonly gatingKind: "requests" | "cost",
  ) {
    super(
      `Budget exceeded for provider "${alias}" (${gatingKind}): ${current} > ${limit}`,
    );
  }
}

/** Thrown when a configured provider is unreachable, returns an error, or is misconfigured. */
export class ProviderUnavailableError extends Error {
  public override readonly name = "ProviderUnavailableError";
  constructor(
    public readonly alias: string,
    public override readonly cause: Error,
  ) {
    super(`Provider "${alias}" unavailable: ${cause.message}`);
  }
}

/**
 * Thrown when every provider in the task's fallback chain has been attempted
 * and none succeeded (each either errored, was budget-blocked, or was missing).
 */
export class NoProvidersAvailableError extends Error {
  public override readonly name = "NoProvidersAvailableError";
  constructor(
    public readonly taskType: string,
    public readonly attempted: string[],
    public readonly reasons: Record<string, string>,
  ) {
    super(
      `No providers available for task "${taskType}". Attempted: ${attempted.join(", ")}`,
    );
  }
}

/** Thrown by validation strategies when generated structured output fails schema. */
export class ValidationError extends Error {
  public override readonly name = "ValidationError";
  constructor(
    public readonly issues: ZodIssue[],
    public readonly attempts: number,
  ) {
    const summary = issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    super(`Validation failed after ${attempts} attempt(s): ${summary}`);
  }
}

/** Thrown when a content block kind is sent to an adapter that does not support it. */
export class ContentBlockUnsupportedError extends Error {
  public override readonly name = "ContentBlockUnsupportedError";
  constructor(
    public readonly adapter: string,
    public readonly blockType: string,
  ) {
    super(`Adapter "${adapter}" does not support content block type "${blockType}"`);
  }
}

/** Thrown by the registry when env config is malformed. */
export class ConfigError extends Error {
  public override readonly name = "ConfigError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown by adapters when a model returns an empty/whitespace-only response
 * where one is structurally required (e.g. generateStructured needs JSON to
 * parse). Carries the model id + provider alias so the registry can route
 * to a fallback. Common cause: reasoning models that spent the entire output
 * budget on hidden reasoning tokens and produced no visible text.
 */
export class EmptyResponseError extends Error {
  public override readonly name = "EmptyResponseError";
  constructor(
    public readonly alias: string,
    public readonly modelId: string,
    public readonly hint?: string,
  ) {
    super(
      hint
        ? `Provider "${alias}" returned an empty response for model "${modelId}". ${hint}`
        : `Provider "${alias}" returned an empty response for model "${modelId}".`,
    );
  }
}
