/**
 * @llm-ports/core alpha.29 — Shared instrumentation service.
 *
 * The load-bearing decision for alpha.29 (see plans/alpha.29-runtime-
 * instrumentation.md §2.1): every emission site — the Registry, the
 * five in-process adapters, the two subprocess adapters — routes
 * through ONE shared service instead of hand-writing `sink.emit(...)`
 * blocks. This module IS that service.
 *
 * The service owns three things nobody else should own:
 *
 * 1. Event construction. Constructing an `ObservabilityEvent<TType,
 *    TData>` from typed inputs by delegating to the contract package's
 *    `buildEvent`. Callers never touch envelopes.
 * 2. ID lifecycle. Generating `operation_id` at the outer boundary,
 *    threading it through every inner `attempt_id`. Reading a
 *    caller-provided `ObservabilityContext.operation_id` if one was
 *    plumbed through `withObservabilityContext(port, ctx)`, so a
 *    long-horizon agent run keeps the same `operation_id` across
 *    many retries and fallbacks.
 * 3. Timing + error handling. Recording `latency_ms` and
 *    `total_duration_ms` from wall-clock deltas. Wrapping every
 *    sink.emit in a `.catch` so a slow or throwing sink never breaks
 *    the primary LLM call.
 *
 * The primary API is a pair of higher-order wrappers, `withOperation`
 * and `withAttempt`, that own the try/finally lifecycle. Callers
 * can't forget the `.failed` emit path because the wrapper owns the
 * catch block:
 *
 *     const result = await withOperation(instrumentation, {
 *       taskType: "triage",
 *       method: "generateText",
 *       providerChain: ["openai", "anthropic"],
 *     }, async (opCtx) => {
 *       return withAttempt(opCtx, {
 *         providerAlias: "openai",
 *         modelId: "gpt-4o",
 *       }, async () => {
 *         const response = await openaiCall();
 *         return {
 *           value: response.text,
 *           usage: response.usage,
 *           cost: response.cost,
 *           modelId: response.model,
 *         };
 *       });
 *     });
 *
 * If instrumentation is undefined, the wrappers no-op cheaply and
 * just call the inner work. Consumers who never configure a sink pay
 * zero cost.
 *
 * Registry-exclusive events (`llm.attempt.retry_scheduled`,
 * `llm.fallback.selected`) fire via `emitRetryScheduled` and
 * `emitFallbackSelected` — thin helpers that also route through the
 * shared service so the emission shape stays consistent.
 */

import type {
  CapturePolicy,
  ComputeRequestFingerprintOptions,
  CorrelationContext,
  CostUsage,
  EmitterConfig,
  ErrorInfo,
  FallbackCause,
  FingerprintableRequest,
  HashAlgorithm,
  ObservabilityContext,
  ObservabilityEvent,
  RequestFingerprint,
  RetryReason,
  TokenUsage,
} from "@llm-ports/observability-contract";
import {
  buildEvent,
  computeRequestFingerprint,
  DEFAULT_CAPTURE_POLICY,
  errorTypeToCauseCategory,
  newAttemptId,
  newOperationId,
} from "@llm-ports/observability-contract";

// ─── Public types ──────────────────────────────────────────────────

/**
 * The full instrumentation handle. Consumers construct one at setup
 * time by combining an `EmitterConfig` (sink + source + optional
 * clock) with an optional caller-provided `ObservabilityContext`
 * (letting an outer scope pin the `operation_id`).
 *
 * Adapters typically accept this via their factory options:
 * `createOpenAIAdapter({ apiKey, observability: { sink, source } })`.
 * The Registry builds one from its own options and threads it down.
 */
export interface Instrumentation {
  /** Emitter configuration: sink, source attribution, optional clock. */
  config: EmitterConfig;

  /**
   * Optional caller-plumbed context. When `context.operation_id` is
   * present, `withOperation` reuses it instead of minting a fresh one,
   * so nested calls inside an outer operation stay correlated.
   */
  context?: ObservabilityContext;

  /**
   * Opt-in prompt-fingerprint compute per §4.6. When set, callers that
   * plumb a request through `maybeComputeFingerprint` (typically the
   * Registry inside each port method) attach a `RequestFingerprint` to
   * every `llm.attempt.completed` event in the operation.
   *
   * Off by default: leaving this undefined means no fingerprint is
   * computed and no fingerprint field is emitted, per the contract's
   * `CapturePolicy.fingerprint` default of "off in strict mode."
   */
  fingerprint?: FingerprintPolicy;

  /**
   * Alpha.30+: capture policy governing per-attempt diagnostic fields
   * (`response_char_count`, `response_preview`) and future
   * content-bearing emission. When omitted, `DEFAULT_CAPTURE_POLICY`
   * applies (`content: "none"`, `responsePreviewMaxChars: 0` — count
   * emits, preview does not).
   *
   * Consumers who want previews in dev set
   * `{ ...DEFAULT_CAPTURE_POLICY, content: "full", responsePreviewMaxChars: 200 }`
   * (or use `PERMISSIVE_CAPTURE_POLICY`). The response_char_count
   * field always emits regardless of policy — it's a count, not
   * content, and gating it would defeat the point.
   */
  capturePolicy?: CapturePolicy;
}

/**
 * Configuration for opt-in prompt fingerprinting. All fields optional
 * except that `algorithm: "hmac-sha256"` requires `hmacKey`.
 */
export interface FingerprintPolicy {
  /** Hash algorithm. Default `"sha256"`. */
  algorithm?: HashAlgorithm;

  /**
   * HMAC key. Required when `algorithm` is `"hmac-sha256"`; ignored
   * otherwise. Must be at least 16 UTF-8 bytes per the contract's hash
   * primitive.
   */
  hmacKey?: string;

  /**
   * Consumer-supplied prompt template identifier (e.g.
   * `"triage-classifier"`). Threaded verbatim into the resulting
   * fingerprint's `prompt_id`.
   */
  promptId?: string;

  /**
   * Consumer-supplied prompt template version qualifier (e.g. a semver,
   * git sha, or timestamp). Threaded verbatim into the resulting
   * fingerprint's `prompt_version`.
   */
  promptVersion?: string;
}

/**
 * Parameters for starting an operation. Everything on this shape maps
 * 1:1 to `OperationStartedData` from the contract.
 */
export interface OperationStartParams {
  /** Task type from the caller (e.g. "triage", "code-review"). */
  taskType: string;

  /**
   * Adapter method being invoked. Restricted to the five known LLMPort
   * methods.
   */
  method: "generateText" | "generateStructured" | "streamText" | "streamStructured" | "runAgent";

  /**
   * The chain of provider aliases the caller intends to attempt in
   * order. For a Registry call, the full fallback chain. For a direct
   * adapter call, `[providerAlias]`.
   */
  providerChain: string[];
}

/**
 * The context object passed to the inner work callback of
 * `withOperation`. Carries the operation-scoped state that
 * `withAttempt` mutates as attempts happen.
 *
 * Consumers do NOT construct this directly. `withOperation` produces
 * it and passes it in; consumers pass it through to `withAttempt`.
 */
export interface OperationContext {
  /** Back-reference to the instrumentation that owns this operation. */
  readonly instrumentation: Instrumentation;

  /** The `operation_id` in flight for this operation. */
  readonly operationId: string;

  /** Wall-clock start of the operation (Date.now()). */
  readonly startedAtMs: number;

  // ─── Mutable counters updated by withAttempt ─────────────────────

  /** How many attempts have been made so far in this operation. */
  attemptsMade: number;

  /** Providers attempted, in order. Repeats permitted for retries. */
  providersTried: string[];

  /**
   * Rolling sum of every attempt's token usage. Zero-initialized so
   * `OperationCompletedData.aggregate_usage` is always well-formed.
   */
  aggregateUsage: TokenUsage;

  /** Rolling sum of every attempt's cost. Zero-initialized. */
  aggregateCost: CostUsage;

  /**
   * Alias of the provider that produced the final successful attempt.
   * Set by `withAttempt` on its completion path.
   */
  finalProviderAlias?: string;

  /**
   * Content-free summary of the result (`finish_reason`, `steps_taken`,
   * `validation_attempts`, etc.). Callers set this via
   * `opCtx.resultSummary` before the outer work returns.
   */
  resultSummary?: Record<string, string | number>;

  /**
   * Prompt fingerprint per §4.6 of the observability contract. When set
   * by the outer caller (typically inside a `withOperation` work
   * callback, before any `withAttempt` call), `withAttempt` includes it
   * on every `llm.attempt.completed` event it emits. The fingerprint is
   * computed once per operation because the request is the same across
   * every retry and fallback within an operation.
   *
   * Consumers who do NOT want fingerprinting simply leave this
   * undefined — the contract's `CapturePolicy.fingerprint` default is
   * off, and omitting the field is compliant.
   */
  requestFingerprint?: RequestFingerprint;
}

/**
 * Parameters for starting an attempt within an operation.
 */
export interface AttemptStartParams {
  /** Registry alias of the provider being attempted. */
  providerAlias: string;

  /** Concrete model ID as configured for this alias. */
  modelId: string;

  /**
   * 1-indexed attempt number. Optional; if omitted, the service uses
   * `opCtx.attemptsMade + 1`. Callers running their own retry logic
   * (rare) pass it explicitly.
   */
  attemptNumber?: number;

  /** True when this attempt is a same-provider retry of an earlier one. */
  isRetry?: boolean;

  /** True when this attempt was reached via fallback from a prior provider. */
  isFallback?: boolean;
}

/**
 * The envelope callers return from the `withAttempt` work callback.
 * Wraps the raw provider result with the metrics needed to fill in
 * `AttemptCompletedData`. `withAttempt` unwraps `value` and returns
 * it to the outer caller unchanged.
 */
export interface AttemptWorkResult<T> {
  /** The value passed through to the outer caller (e.g. text, structured result). */
  value: T;

  /** Token usage the provider reported. Defaults to zeros if omitted. */
  usage?: TokenUsage;

  /** USD cost computed from usage. Defaults to zeros if omitted. */
  cost?: CostUsage;

  /**
   * Final model ID as reported by the provider. When omitted, falls
   * back to `AttemptStartParams.modelId`.
   */
  modelId?: string;

  /** Provider-issued response identifier (e.g. OpenAI `chatcmpl-...`). */
  providerResponseId?: string;

  /**
   * Alpha.30+: total character count of the natural-language response
   * for this attempt. Always emitted verbatim (never gated by
   * CapturePolicy — it's a count, not content). Set to the appropriate
   * per-method count (see the alpha.30 plan doc §2.3.1).
   *
   * When omitted, `response_char_count` is not emitted on
   * `llm.attempt.completed`.
   */
  responseCharCount?: number;

  /**
   * Alpha.30+: raw text to slice for the `response_preview` field on
   * `llm.attempt.completed`. Gated by `CapturePolicy.content` +
   * `CapturePolicy.responsePreviewMaxChars > 0` at emit time.
   *
   * Per-method source text (see plan doc §2.3.2):
   *   - generateText / generateStructured: the response text itself
   *   - runAgent: the FIRST assistant message's content (not the final)
   *   - streamText / streamStructured: buffered from stream start (§2.7)
   *
   * When omitted, `response_preview` is not emitted regardless of
   * capture policy.
   */
  responsePreviewSource?: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const ZERO_USAGE: TokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
}) as TokenUsage;

const ZERO_COST: CostUsage = Object.freeze({
  inputUSD: 0,
  outputUSD: 0,
  totalUSD: 0,
}) as CostUsage;

// ─── Public API: withOperation ──────────────────────────────────────

/**
 * Wrap a whole port-method call as an operation.
 *
 * Emits `llm.operation.started` before `work`, and one of
 * `llm.operation.completed` / `.failed` / `.cancelled` after work
 * returns or throws. The `OperationContext` passed to work carries
 * the counters that `withAttempt` updates as attempts happen; if
 * work never calls `withAttempt`, the counters stay at zero and the
 * aggregates are zero-initialized (still well-formed).
 *
 * When `instrumentation` is undefined, this is a no-op wrapper that
 * just returns `work(undefined)`. Callers pay zero cost when
 * observability is not configured.
 */
export async function withOperation<T>(
  instrumentation: Instrumentation | undefined,
  params: OperationStartParams,
  work: (opCtx: OperationContext | undefined) => Promise<T>,
): Promise<T> {
  if (!instrumentation) {
    return work(undefined);
  }

  const operationId = instrumentation.context?.operation_id ?? newOperationId();
  const opCtx: OperationContext = {
    instrumentation,
    operationId,
    startedAtMs: Date.now(),
    attemptsMade: 0,
    providersTried: [],
    aggregateUsage: { ...ZERO_USAGE },
    aggregateCost: { ...ZERO_COST },
  };

  const opCorrelation: CorrelationContext = { operation_id: operationId };

  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "llm.operation.started", opCorrelation, {
      task_type: params.taskType,
      method: params.method,
      provider_chain: [...params.providerChain],
    }),
  );

  try {
    const result = await work(opCtx);
    const totalDurationMs = Date.now() - opCtx.startedAtMs;

    safeEmit(
      instrumentation.config,
      buildEvent(instrumentation.config, "llm.operation.completed", opCorrelation, {
        aggregate_usage: opCtx.aggregateUsage,
        aggregate_cost: opCtx.aggregateCost,
        attempts_made: opCtx.attemptsMade,
        final_provider_alias: opCtx.finalProviderAlias ?? "(unknown)",
        total_duration_ms: totalDurationMs,
        ...(opCtx.resultSummary ? { result_summary: opCtx.resultSummary } : {}),
      }),
    );

    return result;
  } catch (err) {
    const totalDurationMs = Date.now() - opCtx.startedAtMs;

    if (isAbortError(err)) {
      safeEmit(
        instrumentation.config,
        buildEvent(instrumentation.config, "llm.operation.cancelled", opCorrelation, {
          cancelled_at_attempt: opCtx.attemptsMade,
          providers_tried_before_cancel: [...opCtx.providersTried],
          total_duration_ms: totalDurationMs,
        }),
      );
    } else {
      safeEmit(
        instrumentation.config,
        buildEvent(instrumentation.config, "llm.operation.failed", opCorrelation, {
          error: toErrorInfo(err),
          attempts_made: opCtx.attemptsMade,
          providers_tried: [...opCtx.providersTried],
          total_duration_ms: totalDurationMs,
        }),
      );
    }
    throw err;
  }
}

// ─── Public API: withAttempt ────────────────────────────────────────

/**
 * Wrap one provider attempt inside a running operation.
 *
 * Emits `llm.attempt.started` before `work`, and one of
 * `llm.attempt.completed` / `.failed` after work returns or throws.
 * Updates the operation-level counters (`attemptsMade`,
 * `providersTried`, aggregate usage/cost, `finalProviderAlias`) so
 * `withOperation` can produce a well-formed
 * `llm.operation.completed` event when the outer work returns.
 *
 * When `opCtx` is undefined (which happens when the outer
 * `withOperation` was called without instrumentation), this is a
 * no-op wrapper that just calls `work()` and returns `.value`
 * unchanged.
 */
export async function withAttempt<T>(
  opCtx: OperationContext | undefined,
  params: AttemptStartParams,
  work: () => Promise<AttemptWorkResult<T>>,
): Promise<T> {
  if (!opCtx) {
    const result = await work();
    return result.value;
  }

  const { instrumentation } = opCtx;
  const attemptId = newAttemptId();
  const attemptNumber = params.attemptNumber ?? opCtx.attemptsMade + 1;
  const correlation: CorrelationContext = {
    operation_id: opCtx.operationId,
    attempt_id: attemptId,
  };
  const attemptStartedAtMs = Date.now();

  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "llm.attempt.started", correlation, {
      provider_alias: params.providerAlias,
      model_id: params.modelId,
      attempt_number: attemptNumber,
      is_retry: params.isRetry ?? false,
      is_fallback: params.isFallback ?? false,
    }),
  );

  try {
    const result = await work();
    const latencyMs = Date.now() - attemptStartedAtMs;
    const usage = result.usage ?? ZERO_USAGE;
    const cost = result.cost ?? ZERO_COST;
    const finalModelId = result.modelId ?? params.modelId;

    opCtx.attemptsMade = attemptNumber;
    opCtx.providersTried.push(params.providerAlias);
    opCtx.finalProviderAlias = params.providerAlias;
    opCtx.aggregateUsage = mergeUsage(opCtx.aggregateUsage, usage);
    opCtx.aggregateCost = mergeCost(opCtx.aggregateCost, cost);

    const diagnosticFields = computeDiagnosticFields(
      result.responseCharCount,
      result.responsePreviewSource,
      effectiveCapturePolicy(instrumentation),
    );

    safeEmit(
      instrumentation.config,
      buildEvent(instrumentation.config, "llm.attempt.completed", correlation, {
        usage,
        cost,
        latency_ms: latencyMs,
        final_model_id: finalModelId,
        ...(result.providerResponseId ? { provider_response_id: result.providerResponseId } : {}),
        ...(opCtx.requestFingerprint ? { request_fingerprint: opCtx.requestFingerprint } : {}),
        ...diagnosticFields,
      }),
    );

    return result.value;
  } catch (err) {
    const latencyMs = Date.now() - attemptStartedAtMs;
    opCtx.attemptsMade = attemptNumber;
    if (!opCtx.providersTried.includes(params.providerAlias)) {
      opCtx.providersTried.push(params.providerAlias);
    }

    safeEmit(
      instrumentation.config,
      buildEvent(instrumentation.config, "llm.attempt.failed", correlation, {
        error: toErrorInfo(err),
        latency_ms: latencyMs,
      }),
    );

    throw err;
  }
}

// ─── Public API: Registry-exclusive events ──────────────────────────

/**
 * Emit `llm.attempt.retry_scheduled`. Fires between `llm.attempt.failed`
 * (of the just-failed attempt) and the next `llm.attempt.started`
 * (which will be a same-provider retry). Registry-only.
 */
export function emitRetryScheduled(
  opCtx: OperationContext | undefined,
  params: {
    retryReason: RetryReason;
    backoffMs: number;
    nextAttemptNumber: number;
  },
): void {
  if (!opCtx) return;
  const { instrumentation } = opCtx;
  const correlation: CorrelationContext = { operation_id: opCtx.operationId };
  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "llm.attempt.retry_scheduled", correlation, {
      retry_reason: params.retryReason,
      backoff_ms: params.backoffMs,
      next_attempt_number: params.nextAttemptNumber,
    }),
  );
}

/**
 * Emit `llm.fallback.selected`. Fires between `llm.attempt.failed` (of
 * the from-provider) and the next `llm.attempt.started` (on the
 * to-provider). Registry-only.
 */
export function emitFallbackSelected(
  opCtx: OperationContext | undefined,
  params: {
    fromProviderAlias: string;
    toProviderAlias: string;
    cause: FallbackCause;
  },
): void {
  if (!opCtx) return;
  const { instrumentation } = opCtx;
  const correlation: CorrelationContext = { operation_id: opCtx.operationId };
  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "llm.fallback.selected", correlation, {
      from_provider_alias: params.fromProviderAlias,
      to_provider_alias: params.toProviderAlias,
      cause: params.cause,
    }),
  );
}

// ─── Public API: manual escape hatch (streaming) ────────────────────

/**
 * Handle returned by `startAttempt` for callers who cannot use the
 * `withAttempt` wrap-around form (streaming, where completion happens
 * over time). Callers finish the attempt by calling `completeAttempt`
 * or `failAttempt` with this handle.
 */
export interface ManualAttemptHandle {
  readonly opCtx: OperationContext;
  readonly correlation: CorrelationContext;
  readonly attemptNumber: number;
  readonly providerAlias: string;
  readonly startedAtMs: number;
}

/**
 * Manually start an attempt without the wrap-around form. Emits
 * `llm.attempt.started` and returns a handle the caller uses later.
 *
 * The wrap-around `withAttempt` is preferred; use this only when
 * completion cannot be nested in a try/finally (streaming, split
 * request/response paths).
 */
export function startAttempt(
  opCtx: OperationContext,
  params: AttemptStartParams,
): ManualAttemptHandle {
  const attemptId = newAttemptId();
  const attemptNumber = params.attemptNumber ?? opCtx.attemptsMade + 1;
  const correlation: CorrelationContext = {
    operation_id: opCtx.operationId,
    attempt_id: attemptId,
  };
  const startedAtMs = Date.now();

  safeEmit(
    opCtx.instrumentation.config,
    buildEvent(opCtx.instrumentation.config, "llm.attempt.started", correlation, {
      provider_alias: params.providerAlias,
      model_id: params.modelId,
      attempt_number: attemptNumber,
      is_retry: params.isRetry ?? false,
      is_fallback: params.isFallback ?? false,
    }),
  );

  return {
    opCtx,
    correlation,
    attemptNumber,
    providerAlias: params.providerAlias,
    startedAtMs,
  };
}

/**
 * Manually complete an attempt started via `startAttempt`. Emits
 * `llm.attempt.completed` and updates operation-level counters.
 */
export function completeAttempt<T>(
  handle: ManualAttemptHandle,
  result: AttemptWorkResult<T>,
): void {
  const { opCtx, correlation, attemptNumber, providerAlias, startedAtMs } = handle;
  const latencyMs = Date.now() - startedAtMs;
  const usage = result.usage ?? ZERO_USAGE;
  const cost = result.cost ?? ZERO_COST;

  opCtx.attemptsMade = attemptNumber;
  opCtx.providersTried.push(providerAlias);
  opCtx.finalProviderAlias = providerAlias;
  opCtx.aggregateUsage = mergeUsage(opCtx.aggregateUsage, usage);
  opCtx.aggregateCost = mergeCost(opCtx.aggregateCost, cost);

  const diagnosticFields = computeDiagnosticFields(
    result.responseCharCount,
    result.responsePreviewSource,
    effectiveCapturePolicy(opCtx.instrumentation),
  );

  safeEmit(
    opCtx.instrumentation.config,
    buildEvent(opCtx.instrumentation.config, "llm.attempt.completed", correlation, {
      usage,
      cost,
      latency_ms: latencyMs,
      final_model_id: result.modelId ?? "(unknown)",
      ...(result.providerResponseId ? { provider_response_id: result.providerResponseId } : {}),
      ...(opCtx.requestFingerprint ? { request_fingerprint: opCtx.requestFingerprint } : {}),
      ...diagnosticFields,
    }),
  );
}

/**
 * Manually fail an attempt started via `startAttempt`. Emits
 * `llm.attempt.failed` and updates operation-level counters.
 */
export function failAttempt(handle: ManualAttemptHandle, err: unknown): void {
  const { opCtx, correlation, attemptNumber, providerAlias, startedAtMs } = handle;
  const latencyMs = Date.now() - startedAtMs;
  opCtx.attemptsMade = attemptNumber;
  if (!opCtx.providersTried.includes(providerAlias)) {
    opCtx.providersTried.push(providerAlias);
  }
  safeEmit(
    opCtx.instrumentation.config,
    buildEvent(opCtx.instrumentation.config, "llm.attempt.failed", correlation, {
      error: toErrorInfo(err),
      latency_ms: latencyMs,
    }),
  );
}

// ─── Public API: fingerprint compute ────────────────────────────────

/**
 * Compute a `RequestFingerprint` from a request and attach it to the
 * running operation's context. Called once per operation, before any
 * `withAttempt` runs — the request is the same across every retry and
 * fallback, so a single compute suffices.
 *
 * No-ops when `opCtx` is undefined (observability not configured for
 * this call) or when `opCtx.instrumentation.fingerprint` is undefined
 * (fingerprinting not opted into). Consumers who leave fingerprinting
 * off pay a single undefined-check per call.
 */
export function maybeComputeFingerprint(
  opCtx: OperationContext | undefined,
  request: FingerprintableRequest,
): void {
  if (!opCtx) return;
  const policy = opCtx.instrumentation.fingerprint;
  if (!policy) return;
  const options: ComputeRequestFingerprintOptions = {};
  if (policy.algorithm) options.algorithm = policy.algorithm;
  if (policy.hmacKey) options.hmacKey = policy.hmacKey;
  if (policy.promptId) options.promptId = policy.promptId;
  if (policy.promptVersion) options.promptVersion = policy.promptVersion;
  opCtx.requestFingerprint = computeRequestFingerprint(request, options);
}

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Alpha.30+: resolve the effective CapturePolicy for an
 * Instrumentation. Falls back to `DEFAULT_CAPTURE_POLICY` when
 * `instrumentation.capturePolicy` is undefined, so callers who
 * never opted into a policy get the strict-by-default posture
 * automatically.
 */
function effectiveCapturePolicy(instrumentation: Instrumentation): CapturePolicy {
  return instrumentation.capturePolicy ?? DEFAULT_CAPTURE_POLICY;
}

/**
 * Alpha.30+: compute the diagnostic fields for
 * `llm.attempt.completed` given the raw source values and the
 * effective capture policy. Two rules:
 *
 *   - `response_char_count` always emits when provided (never gated —
 *     it's a count, not content).
 *   - `response_preview` emits only when the policy's `content` is
 *     "full" or "redacted" (matches the `contentEverExposed` check)
 *     AND `responsePreviewMaxChars > 0`.
 *
 * Returns an object suitable for spread into the event data. When
 * neither field applies, returns `{}`.
 */
function computeDiagnosticFields(
  responseCharCount: number | undefined,
  responsePreviewSource: string | undefined,
  policy: CapturePolicy,
): { response_char_count?: number; response_preview?: string } {
  const out: { response_char_count?: number; response_preview?: string } = {};
  if (typeof responseCharCount === "number") {
    out.response_char_count = responseCharCount;
  }
  const contentAllowed = policy.content === "full" || policy.content === "redacted";
  const maxChars = policy.responsePreviewMaxChars ?? 0;
  if (contentAllowed && maxChars > 0 && typeof responsePreviewSource === "string") {
    out.response_preview = responsePreviewSource.slice(0, maxChars);
  }
  return out;
}

/**
 * Emit an event to a sink without letting the sink's failure break
 * the primary path. The sink can return `void` or `Promise<void>`;
 * async rejections are caught silently.
 */
function safeEmit(config: EmitterConfig, event: ObservabilityEvent<string, unknown>): void {
  try {
    const maybePromise = config.sink.emit(event);
    if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
      (maybePromise as Promise<void>).catch(() => {
        // Sink emission is fire-and-forget; a slow or throwing sink
        // must never break the primary LLM call. Deliberately swallow.
      });
    }
  } catch {
    // Same as above: a sync throw from a broken sink is swallowed.
  }
}

/**
 * Classify a thrown value into an `ErrorInfo`. Uses the contract's
 * static `ERROR_TYPE_TO_CATEGORY` map when the error's `name` matches
 * a known typed error class from `@llm-ports/core`; otherwise reports
 * `"port_internal"`.
 */
function toErrorInfo(err: unknown): ErrorInfo {
  const errorType = err instanceof Error ? err.name : "UnknownError";
  const message = err instanceof Error ? err.message : String(err);
  const cause = errorTypeToCauseCategory(errorType);

  return {
    error_type: errorType,
    message,
    cause_category: cause,
    retryable: cause === "provider_capacity" || cause === "provider_unavailable" || cause === "network",
    fallback_worthy:
      cause === "provider_capacity" ||
      cause === "provider_unavailable" ||
      cause === "provider_capability" ||
      cause === "network",
  };
}

/**
 * `AbortSignal` cancellation. Node's fetch and the AI SDKs use
 * `DOMException` with name `"AbortError"`, but user-thrown Error
 * subclasses named "AbortError" should also be honored.
 */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Add two `TokenUsage` values. Preserves optional fields (cache
 * tokens, reasoning tokens) additively.
 */
function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const merged: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
  const cachedRead = (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0);
  if (cachedRead > 0) merged.cachedInputTokens = cachedRead;
  const reasoning = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  if (reasoning > 0) merged.reasoningTokens = reasoning;
  return merged;
}

/**
 * Add two `CostUsage` values. Preserves cache-savings additively.
 */
function mergeCost(a: CostUsage, b: CostUsage): CostUsage {
  const merged: CostUsage = {
    inputUSD: a.inputUSD + b.inputUSD,
    outputUSD: a.outputUSD + b.outputUSD,
    totalUSD: a.totalUSD + b.totalUSD,
  };
  const savings = (a.savingsUSD ?? 0) + (b.savingsUSD ?? 0);
  if (savings > 0) merged.savingsUSD = savings;
  return merged;
}
