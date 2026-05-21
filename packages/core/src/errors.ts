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

/**
 * Thrown when an active CostSession exceeds its USD budget. Distinct from
 * `BudgetExceededError` (which gates per-provider hour/day/month) so call
 * sites can recover differently — typically by closing the session and
 * informing the user, not by routing to a fallback provider.
 *
 * Use case: continuous screen-capture loops where one stuck-open window
 * could otherwise burn arbitrary dollars overnight. The session-scoped
 * cap is a hard backstop independent of the per-provider gates.
 */
export class SessionBudgetExceededError extends Error {
  public override readonly name = "SessionBudgetExceededError";
  constructor(
    public readonly sessionId: string,
    public readonly budgetUSD: number,
    public readonly spentUSD: number,
  ) {
    super(
      `Cost session "${sessionId}" exceeded its budget: $${spentUSD.toFixed(6)} > $${budgetUSD.toFixed(6)}`,
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
 * Thrown by adapters when an image content block exceeds the provider's
 * per-image byte limit. Caught at the adapter boundary BEFORE the SDK call,
 * so the caller sees a typed error instead of an opaque 413/400 wrapped as
 * ProviderUnavailableError.
 *
 * Each adapter knows its own default limit (Anthropic 5MB, OpenAI 20MB,
 * Ollama model-dependent), and the limit can be overridden per-adapter at
 * port creation via `imageSizeLimitBytes`.
 *
 * `imageIndex` is the 0-indexed position of the offending image in the
 * caller's `prompt` ContentBlock[] array.
 */
export class ImageTooLargeError extends Error {
  public override readonly name = "ImageTooLargeError";
  constructor(
    public readonly alias: string,
    public readonly imageIndex: number,
    public readonly byteSize: number,
    public readonly limitBytes: number,
  ) {
    super(
      `Image at index ${imageIndex} is ${byteSize} bytes; exceeds the ${limitBytes}-byte limit for provider "${alias}".`,
    );
  }
}

/**
 * Thrown by adapters when an image content block's URL form is malformed —
 * `file://` scheme, `data:` URI passed as `kind: "url"` instead of base64,
 * or a URL with no scheme. Caught at the adapter boundary BEFORE the SDK call.
 */
export class InvalidImageUrlError extends Error {
  public override readonly name = "InvalidImageUrlError";
  constructor(
    public readonly alias: string,
    public readonly url: string,
    public readonly reason: string,
  ) {
    super(`Invalid image URL for provider "${alias}": ${reason}. URL: ${url.slice(0, 100)}`);
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
