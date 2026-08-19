# Observability

`llm-ports` exposes two coexisting observability surfaces. Both are opt-in; both fire from the same runtime paths. Pick whichever fits your consumer, or use them together.

- **The observability contract surface (alpha.28+, primary).** Structured, versioned event stream defined by [`@llm-ports/observability-contract`](../../packages/observability-contract/README.md). Events flow through an `ObservabilitySink { emit(event) }` interface. Every event carries a full envelope (`spec_version`, `event_id`, timestamps, `source`, `operation_id`, `attempt_id`, correlation, W3C Trace Context). Lifecycle events at operation and attempt granularity, plus `retry_scheduled` / `fallback.selected` / `evaluation.recorded`. Registry-driven emission lives at `RegistryOptions.instrumentation`.

- **The alpha.21 fire-and-forget hooks surface (still supported).** Five typed callbacks on `RegistryOptions.observability` — `onCost`, `onTokenUsage`, `onFallback`, `onValidationRetry`, `onCacheHit`. Simple, low-ceremony, aligned with OpenTelemetry `gen_ai.*` semconv naming where applicable. Suitable when you only need "did the call succeed and what did it cost."

If you're new, start with the contract surface — it's the direction the library is heading, and the contract package can also be used by non-port callers (e.g. your own retry loops, subprocess-driven agents). The alpha.21 hooks stay stable for existing consumers and receive no deprecation timeline in this alpha line.

---

## Contract surface (alpha.28 + alpha.29)

The contract ships as a standalone package with zero runtime dependency on `@llm-ports/core`. Any caller can construct conformant events using the package's `buildEvent` / `emitLifecycleEvent` helpers and forward them to any `ObservabilitySink`. The Registry uses this same shape when its `instrumentation` handle is configured.

### Wiring the Registry (alpha.29)

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createCollectingSink } from "@llm-ports/observability-contract";

const sink = createCollectingSink();

const registry = createRegistryFromEnv({
  env: process.env as Record<string, string>,
  adapters: { /* ... */ },
  instrumentation: {
    config: {
      sink,
      source: { library: "my-app", library_version: "1.0.0" },
    },
    // Optional: caller-plumbed correlation. When context.operation_id is set,
    // withOperation reuses it instead of minting a fresh one — useful when
    // an outer scope (e.g. a long-horizon agent run) wants to pin the
    // operation_id across many Registry calls.
    // context: { operation_id: "op-outer-123" },
    //
    // Optional: opt into prompt fingerprint compute at attempt.completed.
    // Off by default per the contract's CapturePolicy default.
    // fingerprint: { algorithm: "sha256", promptId: "triage-classifier" },
  },
});
```

With `instrumentation` supplied, every call on the Registry's `LLMPort` for `generateText`, `generateStructured`, and `runAgent` emits the full contract lifecycle:

- `llm.operation.started` — before any provider attempt fires. Carries `task_type`, `method`, `provider_chain` (the intended fallback chain).
- `llm.attempt.started` — before each provider attempt. Carries `provider_alias`, `model_id`, `attempt_number` (1-indexed), `is_retry`, `is_fallback`.
- `llm.attempt.completed` — on a successful attempt. Carries `usage`, `cost`, `latency_ms`, `final_model_id`, optional `cache_stats`, `provider_response_id`, `request_fingerprint`.
- `llm.attempt.failed` — on a failed attempt. Carries `error: ErrorInfo` (with `error_type`, `message`, `cause_category`, `retryable`, `fallback_worthy`) and `latency_ms`.
- `llm.attempt.retry_scheduled` — between a failed attempt and the next same-provider retry. Carries `retry_reason`, `backoff_ms`, `next_attempt_number`. Registry-only.
- `llm.fallback.selected` — between a failed attempt and the next chain-provider try. Carries `from_provider_alias`, `to_provider_alias`, `cause: FallbackCause`. Registry-only.
- `llm.operation.completed` — on success. Carries `aggregate_usage`, `aggregate_cost`, `attempts_made`, `final_provider_alias`, `total_duration_ms`, optional `result_summary`.
- `llm.operation.failed` — when the whole chain failed. Carries `error`, `attempts_made`, `providers_tried`, `total_duration_ms`.
- `llm.operation.cancelled` — when an `AbortError` propagated. Carries `cancelled_at_attempt`, `providers_tried_before_cancel`, `total_duration_ms`.

Every event across one operation shares a single `operation_id`. Every attempt within an operation gets its own `attempt_id`. Streams (`streamText`, `streamStructured`) are not instrumented yet; alpha.30 wires the streaming path.

### The shared instrumentation service

The Registry uses helpers from `@llm-ports/core`'s `instrumentation.ts` module. You can call the same helpers directly to instrument your own retry loops or subprocess-driven adapters:

```ts
import {
  withOperation,
  withAttempt,
  type Instrumentation,
} from "@llm-ports/core";

const instrumentation: Instrumentation = {
  config: { sink, source: { library: "my-loop", library_version: "0.1.0" } },
};

const result = await withOperation(
  instrumentation,
  { taskType: "triage", method: "runAgent", providerChain: ["openai"] },
  async (opCtx) => {
    return withAttempt(
      opCtx,
      { providerAlias: "openai", modelId: "gpt-4o" },
      async () => {
        const response = await myProviderCall();
        return {
          value: response,
          usage: response.usage,
          cost: response.cost,
          modelId: response.model,
        };
      },
    );
  },
);
```

`withOperation` owns the `operation.started` / `.completed` / `.failed` / `.cancelled` lifecycle (detecting `AbortError` → cancelled). `withAttempt` owns `attempt.started` / `.completed` / `.failed` and updates the operation-level counters so `operation.completed` fills in `aggregate_usage`, `final_provider_alias`, and friends correctly. Sink failures never break the primary path (sync throws swallowed; async rejections caught). When `instrumentation` is undefined, both wrappers no-op and just call the inner work.

For streaming, use the manual escape hatch `startAttempt` / `completeAttempt` / `failAttempt`.

### Prompt fingerprint

Setting `Instrumentation.fingerprint` enables per-attempt request fingerprinting. The Registry computes a `RequestFingerprint` once per operation (before any attempt runs) and attaches it to every `attempt.completed` via the optional `AttemptCompletedData.request_fingerprint` field.

```ts
instrumentation: {
  config: { sink, source },
  fingerprint: {
    algorithm: "sha256",         // or "hmac-sha256" (requires hmacKey ≥16 UTF-8 bytes)
    promptId: "triage-classifier",
    promptVersion: "v3.2",
  },
}
```

Two calls with identical messages + sampling params produce identical `message_hash` and `request_hash`. Different content produces different hashes. Useful for drift detection, template-version tracking, or A/B analysis across attempts.

### Persistent evaluation storage (`@llm-ports/eval`)

Evaluations arrive late — LLM-judge scores after the fact, human annotations hours later, dataset replays days later. The [`@llm-ports/eval`](../../packages/eval/README.md) package provides durable storage keyed on the contract's `EvaluationRef` shape.

Bridge the store to the Registry's sink:

```ts
import { createSqliteEvaluationStore, toObservabilitySink } from "@llm-ports/eval";

const store = createSqliteEvaluationStore({ dbPath: "./evaluations.db" });
const sink = toObservabilitySink(store);

const registry = createRegistryFromEnv({
  env: process.env as Record<string, string>,
  adapters: { /* ... */ },
  instrumentation: {
    config: { sink, source: { library: "my-app", library_version: "1.0.0" } },
  },
});
```

Only `evaluation.recorded` events land in the store; lifecycle events are silently ignored. For BOTH lifecycle capture AND evaluation storage, compose a fan-out sink yourself.

See [`docs/concepts/evaluations.md`](./evaluations.md) for the full write / query surface.

### Shipped in alpha.30

Every alpha.29 carve-out landed:

- **Streaming instrumentation.** `streamText` / `streamStructured` now emit the full operation + attempt lifecycle plus `AttemptCompletedData.stream_stats` (`ttft_ms`, `chunk_count`, inter-chunk `p50`/`p99`, `termination`). Per-chunk `llm.stream.chunk` events are opt-in via `CapturePolicy.stream_chunk_capture === "full"`. See the [Streaming Observability guide](./streaming.md).
- **Provider cache normalization.** OpenAI (`cached_tokens`), Anthropic (`cache_read/create_input_tokens`), and Google (`cachedContentTokenCount`) fold into `AttemptCompletedData.cache_stats.provider_cache` with a canonical status enum (`hit` / `partial` / `miss` / omitted). See the [Cache Control guide's alpha.30 section](./cache.md#cache-accounting-on-observability-events-alpha30).
- **Agent step + tool events** (`agent.step.*`, `agent.tool.*`) — see the "Agent-loop events" section below.
- **Adapter-side emission** — codex + aider adapters route through the shared `withOperation` + `withAttempt` service instead of hand-rolling `sink.emit`. Direct-adapter callers see the same lifecycle events the Registry produces.
- **OpenTelemetry semconv bridge** — new companion package [`@llm-ports/telemetry-otel`](../adapters/telemetry-otel.md). `createOtelSink({ tracer, meter? })` maps every contract event to OTel gen_ai spans + metrics.

`TD-ALPHA29-ADAPTER-EMIT-DEFERRED` and `TD-ALPHA29-AGENT-STEP-EVENTS-DEFERRED` both close on alpha.30.

### Agent-loop events (alpha.30+)

The three in-process adapters that own their runAgent tool-use loop (openai, anthropic, google) emit correlated per-step + per-tool events for every `runAgent` call, threaded through `resurrectOperationContext(this)` inside the adapter method.

Per LLM turn:
- `agent.step.started` — `step_index` (1-based), `step_type: "llm"` (or `"tool"` / `"validation"` on adapters that later add those step kinds).
- `agent.step.completed` — `duration_ms`, `usage`, `cost`.

Per tool call:
- `agent.tool.called` — `tool_name`, `tool_call_id`, `arguments_digest: sha256Hex(rawArgs)`. Content-free by default.
- `agent.tool.returned` — `result_digest`, `duration_ms`, optional `error: ErrorInfo` when the tool threw. Content-free by default.

All events share the outer `operation_id`, so an aggregating sink sees the full step + tool tree stitched under one span (or one OTel span, when wired through the telemetry-otel bridge).

**Direct-adapter callers.** The same events fire on direct-adapter calls (bypassing the Registry) when the caller has wrapped the port with `withObservabilityContext(port, ctx)` and set `ObservabilityContext.operation_handle` to a running operation. When no outer scope has opened one, `resurrectOperationContext(this)` returns undefined and the four emit helpers no-op — safe by default.

### `withObservabilityContext` binding change (alpha.30)

`withObservabilityContext` now binds methods to the wrapped proxy (receiver) instead of the underlying target. This is what enables `resurrectOperationContext(this)` inside adapter runAgent methods — `this` resolves to the proxy, which is the instance the context is registered against.

Non-breaking: destructured calls (`const { generateText } = wrappedPort; generateText(...)`) still work because the receiver at bind time is the proxy. Every existing test continues to pass. The change only opens the door for adapters to resurrect the outer op context via `this`.

### Capture policy — `responsePreviewMaxChars` + `stream_chunk_capture`

Two `CapturePolicy` fields exercised by alpha.30 additions:

- **`responsePreviewMaxChars: number`** (default `0` in strict, `200` in permissive). Gates the `response_preview` field on `llm.attempt.completed`. Preview lands only when `content === "full" | "redacted"` AND `responsePreviewMaxChars > 0`. `response_char_count` (the count, not the content) always emits regardless.
- **`stream_chunk_capture: "off" | "sampled" | "full"`** (default `"off"`). Gates per-chunk `llm.stream.chunk` events on streamed methods. `"full"` fires one event per chunk (with `chunk_content` further gated by the content policy); `"sampled"` is reserved for future rate-limited emission; `"off"` yields aggregate `stream_stats` only.

Both defaults keep the strict-by-default posture. Opt in via `Instrumentation.capturePolicy` at Registry setup.

---

## Alpha.21 fire-and-forget hooks

`llm-ports` exposes five fire-and-forget observability hooks on `RegistryOptions.observability` (alpha.21+). Event shapes align with the [OpenTelemetry `gen_ai.*` semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) so downstream pipelines (Honeycomb, Datadog, OTel Collector, custom OTLP exporters) can map them onto spans and metrics without re-deriving fields.

The hooks complement the existing per-adapter `onRetry` hook (alpha.17+). `onRetry` covers "the adapter decided to retry an in-flight request"; the Registry-level hooks below cover "the Registry decided to move on" and "a successful call is interesting to observe."

Both the alpha.21 hooks and the alpha.28/.29 contract surface can coexist on the same Registry — they observe overlapping runtime paths and are independent choices about how to receive the data.

## Quick start

```ts
import { createRegistryFromEnv } from "@llm-ports/core";

const registry = createRegistryFromEnv({
  env: process.env,
  adapters: { /* ... */ },
  observability: {
    onCost:        (e) => myMetrics.cost.observe(e.totalUsd, { model: e.modelId }),
    onTokenUsage:  (e) => myMetrics.tokens.observe(e.totalTokens, { model: e.modelId }),
    onFallback:    (e) => myLogger.warn(`fallback ${e.fromAlias} -> ${e.toAlias} (${e.cause})`),
    onCacheHit:    (e) => myMetrics.cacheHitRatio.observe(e.hitRatio),
    onValidationRetry: (e) => myLogger.warn(`validation retry ${e.attempt}/${e.maxAttempts}`),
  },
});
```

All five fields are independently optional. Pass only the hooks the downstream pipeline needs.

## Hook reference

### `onCost`

Fires after every billable call against `generateText`, `generateStructured`, or `runAgent`. Cost is in USD, broken down by prompt/completion/cache.

```ts
interface CostEvent {
  promptUsd: number;
  completionUsd: number;
  totalUsd: number;
  cacheReadUsd?: number;       // when the provider has a discounted cache-read tier
  cacheWriteUsd?: number;      // Anthropic-style explicit-cache providers
  reasoningUsd?: number;       // hidden chain-of-thought billed separately
  modelId: string;
  providerAlias: string;
  operation: "generateText" | "generateStructured" | "streamText" | "streamStructured" | "runAgent" | "embed" | "rerank";
  taskType?: string;
  budgetScope?: { scope: string; scopeId: string };
}
```

### `onTokenUsage`

Fires alongside `onCost` with raw token counts (before USD monetization). Useful when downstream metrics care about token volume independent of pricing changes.

```ts
interface TokenUsageEvent {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  modelId: string;
  providerAlias: string;
  operation: CostEvent["operation"];
  taskType?: string;
  budgetScope?: { scope: string; scopeId: string };
}
```

### `onFallback`

Fires when the Registry's provider chain advances. Per-call only; not emitted for the initial selection or for `forceProviderAlias` calls (which by contract don't fall back).

```ts
type FallbackCause =
  | "provider-error"        // the primary raised an error (budget, 401, 5xx, transient)
  | "budget-exhausted"      // gate denied the call on the primary
  | "validation-exhausted"  // structured retries gave up; chain advances
  | "empty-response"        // primary returned empty after starvation retries
  | "circuit-open";

interface FallbackEvent {
  fromAlias: string;
  toAlias: string;
  cause: FallbackCause;
  operation: CostEvent["operation"];
  taskType?: string;
  reason?: unknown;  // the error or signal that triggered the advancement
}
```

In alpha.21, only `cause: "provider-error"` is emitted. Future releases will surface the other causes as the Registry learns to advance on more signals.

### `onCacheHit`

Fires when the response reports `cacheReadTokens > 0`. Useful for tracking whether prompt-engineering caching is actually firing.

```ts
interface CacheHitEvent {
  cachedTokens: number;
  inputTokensTotal: number;
  hitRatio: number;          // cachedTokens / inputTokensTotal
  savingsUsd?: number;       // populated when the provider has a discounted cache-read tier
  modelId: string;
  providerAlias: string;
  operation: CostEvent["operation"];
  taskType?: string;
}
```

### `onValidationRetry`

Type-only in alpha.21. Registry-level emission is the alpha.22 follow-up. Consumers wanting validation-retry observability today should use the adapter's existing [`onRetry` hook](/concepts/validation-strategies#onretry-observability) and filter on `reason === "validation-feedback"`:

```ts
const adapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  onRetry: (e) => {
    if (e.reason === "validation-feedback") {
      myMetrics.validationRetries.inc({ model: e.modelId });
    }
  },
});
```

When emission lands, the event shape will be:

```ts
type ValidationRetryCause =
  | "schema-mismatch"   // valid JSON that failed Zod validation
  | "parse-error";      // non-JSON text response

interface ValidationRetryEvent {
  attempt: number;
  maxAttempts: number;
  modelId: string;
  providerAlias: string;
  cause: ValidationRetryCause;
  issues?: unknown;
  operation: "generateStructured" | "streamStructured";
}
```

## Coverage (as of alpha.25)

| Hook | Emitted? | Where it fires |
|---|---|---|
| `onCost` | ✅ | Every successful `generateText` / `generateStructured` / `runAgent` and at natural stream completion for `streamText` / `streamStructured` (alpha.25+) |
| `onTokenUsage` | ✅ | Same as `onCost` |
| `onCacheHit` | ✅ | When the response reports `cacheReadTokens > 0` |
| `onFallback` | ✅ (cause: `provider-error`) | When the Registry's `walkChain` advances from one alias to the next |
| `onValidationRetry` | ✅ (alpha.24+) | Registry-level emission via `deriveValidationRetryFromAdapterRetry` bridging the adapter's `onRetry` |

Streamed cost surfacing (alpha.25) emits `onCost` + `onTokenUsage` **once per stream** at natural completion; mid-stream errors and consumer-cancelled streams do NOT emit (matches the non-streaming "cost recorded only on success" contract). Enabled by default in `adapter-openai` via `stream_options: { include_usage: true }`; opt out per adapter with `streamUsage: false` if a compat provider rejects the field.

## `refs` field on events (alpha.25+)

Every observability event carries an optional `refs?: Record<string, ArtifactRef>` field, threaded verbatim from the call options. Use this to attribute events to versioned artifacts (prompts, scaffolds, policies, experiment variants) or attribution tags (tenant, project, session):

```ts
const result = await port.generateStructured({
  taskType: "extract",
  prompt: userInput,
  schema: MySchema,
  refs: {
    prompt:  { key: "extractor-v3", version: 3, hash: "sha256:..." },
    tenant:  { key: "acme-corp" },
    session: { key: "sess-abc123" },
  },
});

// ...on the observability side:
const registry = createRegistryFromEnv({
  observability: {
    onCost: (e) => {
      metrics.costByPrompt.record(e.totalUsd, {
        promptKey:     e.refs?.prompt?.key,
        promptVersion: e.refs?.prompt?.version,
        tenant:        e.refs?.tenant?.key,
      });
    },
  },
});
```

**Non-goals:** refs are not validated, not sent to the model, not persisted, not read by adapters. Pure consumer-owned trace metadata. See the [alpha.24-to-alpha.25 migration guide](/migration/alpha-24-to-alpha-25) for the full contract.

## Aggressive fallback preset (alpha.25+)

`RegistryOptions.runtimeFallback: "aggressive"` bundles the opinionated classifier three consumers rebuilt by hand (BEPA Plan 29, HomeSignal, SalesCoach Plan 30). Walks the chain on `RateLimitError`, `EmptyResponseError`, `ContextWindowExceededError`, `BadRequestError` matching credit-exhaustion body patterns, and raw 5xx status codes — in addition to the default `ProviderUnavailableError`. Does NOT walk on `AuthenticationError`, generic malformed `BadRequestError`, or budget-exhaustion.

```ts
import { createRegistryFromEnv } from "@llm-ports/core";

const registry = createRegistryFromEnv({
  adapters: { /* ... */ },
  runtimeFallback: "aggressive",  // alpha.25+, LP-REQ-01
  observability: {
    onFallback: (e) => {
      // Fires when a rate-limit / credit-exhaustion / empty-response / 5xx
      // caused the chain to walk. cause: "provider-error"; reason: the error.
      metrics.chainWalks.inc({ cause: e.cause, from: e.fromAlias, to: e.toAlias });
    },
  },
});
```

For finer control the object form still wins; the classifier is exported so consumers can compose:

```ts
import { aggressiveShouldFallback } from "@llm-ports/core";

runtimeFallback: {
  shouldFallback: (e) => aggressiveShouldFallback(e) || myCustomCondition(e),
},
```

## Per-attempt timeout (alpha.23+)

Independent of the hooks above but related — `RegistryOptions.perAttemptTimeoutMs` wraps every provider attempt inside `walkChain` with an `AbortController` + timer:

```ts
const registry = createRegistryFromEnv({
  // ...existing options...
  perAttemptTimeoutMs: 30000,  // 30s cap per provider attempt
});
```

On timeout, the abort propagates to the adapter's HTTP client; the adapter throws `ProviderUnavailableError`; the Registry's `shouldFallback` catches it and walks to the next provider with a fresh timer. **Per-attempt, not chain-wide** — each provider gets its own budget.

When the chain advances due to a timeout, `onFallback` fires with `cause: "provider-error"` (the timeout-induced `ProviderUnavailableError` is the trigger). Caller-supplied `signal` composes with the timeout — both fire the same wrapped controller; the shorter trigger wins.

This is the ergonomic wrapper for the AbortSignal infrastructure that already existed on the port surface (alpha.6+). Particularly useful for routing around reasoning models that grind on hidden chain-of-thought without erroring.

## Error swallowing

Every hook is fire-and-forget. Sync hooks that throw, async hooks that reject — the Registry swallows the failure and continues the inference call. Observability instrumentation can never break inference.

```ts
const registry = createRegistryFromEnv({
  /* ... */
  observability: {
    onCost: () => { throw new Error("oops"); },  // swallowed; call proceeds
  },
});

const result = await registry.getPort().generateText(/* ... */);
// result is returned normally even though the hook threw
```

This matches the contract on the existing `onRetry` hook ([emitRetryEvent](https://github.com/baabakk/llm-ports/blob/main/packages/core/src/retry-emit.ts) for the implementation).

## Mapping to OpenTelemetry

Each event field maps to a `gen_ai.*` semantic convention or a vendor-neutral extension. For an OTel Collector pipeline:

| llm-ports field | OTel convention |
|---|---|
| `modelId` | `gen_ai.response.model` |
| `providerAlias` | `gen_ai.system` (or vendor extension) |
| `operation` | `gen_ai.operation.name` |
| `taskType` | `gen_ai.request.task_type` (vendor extension) |
| `inputTokens` | `gen_ai.usage.input_tokens` |
| `outputTokens` | `gen_ai.usage.output_tokens` |
| `cachedInputTokens` | `gen_ai.usage.cached_input_tokens` (vendor extension) |
| `totalUsd` | `gen_ai.usage.cost.total_usd` (vendor extension) |
| `fromAlias` / `toAlias` (`onFallback`) | span attributes on the fallback event span |

The hooks deliberately stay vendor-neutral on the field names. Map to the conventions your tracing layer expects at the hook callback boundary.

## See also

- [Retry observability (`onRetry`)](/concepts/validation-strategies#onretry-observability) — for per-adapter retry signals
- [Cost vs Request Gating](/concepts/cost-vs-request-gating) — for the gating mechanics that drive `onFallback` cause discrimination
- [Cache Control](/concepts/cache) — for the `cacheControl` shape that feeds `onCacheHit`
- [Validation Strategies](/concepts/validation-strategies) — for the `retry-with-feedback` mechanism behind `onValidationRetry`
