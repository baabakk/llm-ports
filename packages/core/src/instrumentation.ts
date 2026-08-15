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
  CacheStats,
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
  StreamChunkData,
  StreamStats,
  TokenUsage,
} from "@llm-ports/observability-contract";
import { getObservabilityContext } from "./observability-context.js";
import type { LLMPort } from "./ports/llm-port.js";
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

  /**
   * Alpha.30+: opaque handle the Registry stamps onto downstream
   * `ObservabilityContext.operation_handle` so adapters can retrieve
   * this OperationContext via `resurrectOperationContext(port)`.
   * Distinct from `operationId` — the handle is a registration key for
   * the in-process handle-registry Map; `operationId` is the event
   * envelope's correlation ID that lands on every emitted event.
   */
  readonly handle: string;

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

  /**
   * Alpha.30+: per-stream aggregate telemetry produced by the streaming
   * wrapper (see registry.ts `instrumentTextStream` /
   * `instrumentStructuredStream`). Attached on the natural-completion
   * path of a streamed attempt; non-streaming attempts leave this
   * undefined and the field is omitted from the emitted event.
   */
  streamStats?: StreamStats;

  /**
   * Alpha.30+: provider prompt-cache accounting derived from the
   * adapter's `TokenUsage.cacheReadTokens` / `.cacheWriteTokens`. When
   * omitted, the `cache_stats` field is not emitted on
   * `llm.attempt.completed`; when present it is passed through
   * verbatim so consumers see the canonical `CacheStats.provider_cache`
   * / `.semantic_cache` shape rather than the adapter's native fields.
   */
  cacheStats?: CacheStats;
}

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Alpha.30+: module-level registry of in-flight OperationContexts
 * keyed by their opaque handle. Populated by `withOperation` at the
 * start of an operation; deleted in the finally block when the
 * operation completes / fails / cancels.
 *
 * Adapters read from this registry via `resurrectOperationContext(port)`
 * which retrieves the handle from the port's ObservabilityContext.
 *
 * This is a `Map<string, OperationContext>` rather than a `WeakMap`
 * because handles are strings (not object references). The finally-
 * block cleanup keeps the map bounded to concurrently-live operations.
 * A pathological consumer that never `await`s a `withOperation` could
 * in principle leak entries, but that would also leak the caller's
 * own promise state, so it's the caller's bug, not ours.
 */
const handleRegistry = new Map<string, OperationContext>();

/**
 * Mint a new opaque operation handle. Uses the same nanoid generator
 * the contract package uses for other IDs — 16 chars, URL-safe. The
 * probability of collision within one process is negligible.
 */
function newOperationHandle(): string {
  return newOperationId();
}

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

// ─── Public API: manual operation escape hatch (streaming) ──────────

/**
 * Handle returned by `startOperation` for callers who cannot use the
 * wrap-around `withOperation` form. The streaming methods on the
 * Registry (`streamText` / `streamStructured`) use this because
 * completion happens after the async generator has already returned
 * its iterable to the consumer; the wrap-around form's promise chain
 * cannot span the consumer's iteration.
 *
 * Non-streaming callers should stick to `withOperation` (it composes
 * these hatches internally and owns the try/finally lifecycle).
 */
export interface ManualOperationHandle {
  readonly instrumentation: Instrumentation;
  readonly opCtx: OperationContext;
  readonly correlation: CorrelationContext;
}

/**
 * Manually start an operation without the wrap-around form. Emits
 * `llm.operation.started` and returns a handle the caller finishes
 * later with `completeOperation` / `failOperation` / `cancelOperation`.
 *
 * When `instrumentation` is undefined, returns undefined so callers
 * pay zero cost (matches `withOperation`'s no-op semantics).
 */
export function startOperation(
  instrumentation: Instrumentation | undefined,
  params: OperationStartParams,
): ManualOperationHandle | undefined {
  if (!instrumentation) return undefined;

  const operationId = instrumentation.context?.operation_id ?? newOperationId();
  const handle = newOperationHandle();
  const opCtx: OperationContext = {
    instrumentation,
    operationId,
    handle,
    startedAtMs: Date.now(),
    attemptsMade: 0,
    providersTried: [],
    aggregateUsage: { ...ZERO_USAGE },
    aggregateCost: { ...ZERO_COST },
  };
  handleRegistry.set(handle, opCtx);

  const correlation: CorrelationContext = { operation_id: operationId };
  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "llm.operation.started", correlation, {
      task_type: params.taskType,
      method: params.method,
      provider_chain: [...params.providerChain],
    }),
  );

  return { instrumentation, opCtx, correlation };
}

/**
 * Manually complete an operation started via `startOperation`. Emits
 * `llm.operation.completed` and cleans up the handle registry entry.
 * Safe to call with undefined (no-op).
 */
export function completeOperation(handle: ManualOperationHandle | undefined): void {
  if (!handle) return;
  const { instrumentation, opCtx, correlation } = handle;
  const totalDurationMs = Date.now() - opCtx.startedAtMs;
  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "llm.operation.completed", correlation, {
      aggregate_usage: opCtx.aggregateUsage,
      aggregate_cost: opCtx.aggregateCost,
      attempts_made: opCtx.attemptsMade,
      final_provider_alias: opCtx.finalProviderAlias ?? "(unknown)",
      total_duration_ms: totalDurationMs,
      ...(opCtx.resultSummary ? { result_summary: opCtx.resultSummary } : {}),
    }),
  );
  handleRegistry.delete(opCtx.handle);
}

/**
 * Manually fail an operation started via `startOperation`. Emits
 * `llm.operation.failed` and cleans up the handle registry entry.
 * Safe to call with undefined.
 */
export function failOperation(handle: ManualOperationHandle | undefined, err: unknown): void {
  if (!handle) return;
  const { instrumentation, opCtx, correlation } = handle;
  const totalDurationMs = Date.now() - opCtx.startedAtMs;
  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "llm.operation.failed", correlation, {
      error: toErrorInfo(err),
      attempts_made: opCtx.attemptsMade,
      providers_tried: [...opCtx.providersTried],
      total_duration_ms: totalDurationMs,
    }),
  );
  handleRegistry.delete(opCtx.handle);
}

/**
 * Manually cancel an operation started via `startOperation`. Emits
 * `llm.operation.cancelled` and cleans up the handle registry entry.
 * Safe to call with undefined.
 */
export function cancelOperation(handle: ManualOperationHandle | undefined): void {
  if (!handle) return;
  const { instrumentation, opCtx, correlation } = handle;
  const totalDurationMs = Date.now() - opCtx.startedAtMs;
  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "llm.operation.cancelled", correlation, {
      cancelled_at_attempt: opCtx.attemptsMade,
      providers_tried_before_cancel: [...opCtx.providersTried],
      total_duration_ms: totalDurationMs,
    }),
  );
  handleRegistry.delete(opCtx.handle);
}

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
 *
 * Implementation composes the manual hatches (`startOperation` +
 * `completeOperation` / `failOperation` / `cancelOperation`) so both
 * wrap-around callers and streaming callers share one emission path.
 */
export async function withOperation<T>(
  instrumentation: Instrumentation | undefined,
  params: OperationStartParams,
  work: (opCtx: OperationContext | undefined) => Promise<T>,
): Promise<T> {
  const handle = startOperation(instrumentation, params);
  if (!handle) {
    return work(undefined);
  }

  try {
    const result = await work(handle.opCtx);
    completeOperation(handle);
    return result;
  } catch (err) {
    if (isAbortError(err)) {
      cancelOperation(handle);
    } else {
      failOperation(handle, err);
    }
    throw err;
  }
}

// ─── Public API: adapter-side operation resurrection (alpha.30+) ────

/**
 * Retrieve the running `OperationContext` from a wrapped port when the
 * Registry (or another outer scope) plumbed one down via
 * `withObservabilityContext(port, { operation_handle })`. Returns
 * undefined when the port has no handle attached — the common case
 * when a consumer imports an adapter directly, bypassing the Registry.
 *
 * Adapters use this to emit correlated sub-events (agent step events,
 * stream chunk events, richer diagnostic data) that thread into the
 * outer operation without having to open a new one:
 *
 * ```typescript
 * // Inside an adapter's runAgent implementation:
 * const opCtx = resurrectOperationContext(this);
 * if (opCtx) {
 *   // Emit agent.step.* events correlated with the outer operation.
 *   // The Registry's withOperation + withAttempt already handle the
 *   // outer lifecycle; this adds richer step-level detail.
 * } else {
 *   // Called directly — the adapter opens its own withOperation to
 *   // emit the full lifecycle.
 * }
 * ```
 *
 * Read semantics only: this does NOT create an OperationContext when
 * none exists. Adapters that want to instrument in the direct-call
 * case wrap their own `withOperation`. This helper's contract is
 * "resurrect what an outer scope already opened."
 *
 * Sourced from `TD-ALPHA29-ADAPTER-EMIT-DEFERRED` — the plumbing that
 * unlocks §2.4/§2.5/§2.7 without a breaking change to `LLMPort`
 * method signatures.
 */
export function resurrectOperationContext(port: LLMPort): OperationContext | undefined {
  const ctx = getObservabilityContext(port);
  if (!ctx?.operation_handle) return undefined;
  return handleRegistry.get(ctx.operation_handle);
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
        ...(result.streamStats ? { stream_stats: result.streamStats } : {}),
        ...(result.cacheStats ? { cache_stats: result.cacheStats } : {}),
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

// ─── Public API: agent-loop sub-events (alpha.30+) ──────────────────
//
// Adapters call these from inside their runAgent tool-use loop after
// resurrecting the outer operation context via
// `resurrectOperationContext(port)`. The events emit correlated with
// the outer operation_id — sinks aggregating by operation see the
// full step + tool-call tree stitched under the same operation.
//
// All four helpers no-op when `opCtx` is undefined, so an adapter
// that unconditionally calls them stays safe in the direct-call
// case where no outer operation exists. When the adapter opens its
// own withOperation for the direct-call case, the returned opCtx
// works with these helpers identically.

/**
 * Emit `agent.step.started`. Adapters fire this at the top of each
 * loop iteration — one per LLM turn, one per tool invocation, one
 * per validation retry.
 *
 * @param opCtx — the resurrected OperationContext (from
 *   `resurrectOperationContext(port)`) or the adapter's own
 *   OperationContext (from a direct-call `withOperation`).
 * @param params — `stepIndex` (1-indexed), `stepType`, optional
 *   `toolName` for tool-kind steps.
 */
export function emitAgentStepStarted(
  opCtx: OperationContext | undefined,
  params: {
    stepIndex: number;
    stepType: "llm" | "tool" | "validation";
    toolName?: string;
  },
): void {
  if (!opCtx) return;
  const { instrumentation } = opCtx;
  const correlation: CorrelationContext = { operation_id: opCtx.operationId };
  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "agent.step.started", correlation, {
      step_index: params.stepIndex,
      step_type: params.stepType,
      ...(params.toolName !== undefined ? { tool_name: params.toolName } : {}),
    }),
  );
}

/**
 * Emit `agent.step.completed`. Fired when the step ends (successfully
 * or with an error already captured on `llm.attempt.failed`).
 * Optional `usage` + `cost` when the step consumed provider tokens
 * (LLM-kind steps typically; tool + validation steps typically don't).
 */
export function emitAgentStepCompleted(
  opCtx: OperationContext | undefined,
  params: {
    stepIndex: number;
    durationMs: number;
    usage?: TokenUsage;
    cost?: CostUsage;
  },
): void {
  if (!opCtx) return;
  const { instrumentation } = opCtx;
  const correlation: CorrelationContext = { operation_id: opCtx.operationId };
  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "agent.step.completed", correlation, {
      step_index: params.stepIndex,
      duration_ms: params.durationMs,
      ...(params.usage ? { usage: params.usage } : {}),
      ...(params.cost ? { cost: params.cost } : {}),
    }),
  );
}

/**
 * Emit `agent.tool.called`. Adapters fire this once per tool call the
 * model produces on an LLM step, BEFORE the tool actually runs.
 *
 * `argumentsDigest` is a SHA-256 hex digest of the arguments (typically
 * `sha256Hex(JSON.stringify(args))` from `@llm-ports/observability-contract`).
 * The digest is content-free: emit it always regardless of
 * `CapturePolicy.content`; the raw arguments themselves are the
 * content that a permissive policy would additionally allow, but this
 * helper does not surface them.
 */
export function emitAgentToolCalled(
  opCtx: OperationContext | undefined,
  params: {
    toolName: string;
    toolCallId: string;
    argumentsDigest: string;
  },
): void {
  if (!opCtx) return;
  const { instrumentation } = opCtx;
  const correlation: CorrelationContext = { operation_id: opCtx.operationId };
  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "agent.tool.called", correlation, {
      tool_name: params.toolName,
      tool_call_id: params.toolCallId,
      arguments_digest: params.argumentsDigest,
    }),
  );
}

/**
 * Emit `agent.tool.returned`. Fired once per matching
 * `agent.tool.called`. `resultDigest` is a SHA-256 hex digest of the
 * result payload; emit `error: ErrorInfo` when the tool threw or
 * returned a structured error.
 */
export function emitAgentToolReturned(
  opCtx: OperationContext | undefined,
  params: {
    toolName: string;
    toolCallId: string;
    resultDigest: string;
    durationMs: number;
    error?: ErrorInfo;
  },
): void {
  if (!opCtx) return;
  const { instrumentation } = opCtx;
  const correlation: CorrelationContext = { operation_id: opCtx.operationId };
  safeEmit(
    instrumentation.config,
    buildEvent(instrumentation.config, "agent.tool.returned", correlation, {
      tool_name: params.toolName,
      tool_call_id: params.toolCallId,
      result_digest: params.resultDigest,
      duration_ms: params.durationMs,
      ...(params.error ? { error: params.error } : {}),
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
      ...(result.streamStats ? { stream_stats: result.streamStats } : {}),
      ...(result.cacheStats ? { cache_stats: result.cacheStats } : {}),
      ...diagnosticFields,
    }),
  );
}

/**
 * Alpha.30+: emit `llm.stream.chunk` correlated to a running attempt.
 * Called per chunk by the streaming instrumentation wrapper when the
 * effective `CapturePolicy.stream_chunk_capture` is `"full"`; the
 * wrapper is also responsible for gating `chunk_content` behind the
 * content policy (this helper emits whatever the caller supplies).
 *
 * Safe to call with undefined handle (no-op) so instrumented and
 * un-instrumented streams share the same call site.
 */
export function emitStreamChunk(
  handle: ManualAttemptHandle | undefined,
  data: StreamChunkData,
): void {
  if (!handle) return;
  const { opCtx, correlation } = handle;
  safeEmit(
    opCtx.instrumentation.config,
    buildEvent(opCtx.instrumentation.config, "llm.stream.chunk", correlation, data),
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
 *
 * Exported so the streaming instrumentation in registry.ts can gate
 * per-chunk emission (`stream_chunk_capture`) and content inclusion
 * (`content`) against the same policy that governs `response_preview`.
 */
export function effectiveCapturePolicy(instrumentation: Instrumentation | undefined): CapturePolicy {
  if (!instrumentation) return DEFAULT_CAPTURE_POLICY;
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
 *
 * Exported so the streaming instrumentation in registry.ts can classify
 * an in-stream abort as `termination: "aborted"` (vs `"error"`) without
 * duplicating the check.
 */
export function isAbortError(err: unknown): boolean {
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
