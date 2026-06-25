# Observability hooks

`llm-ports` exposes five fire-and-forget observability hooks on `RegistryOptions.observability` (alpha.21+). Event shapes align with the [OpenTelemetry `gen_ai.*` semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) so downstream pipelines (Honeycomb, Datadog, OTel Collector, custom OTLP exporters) can map them onto spans and metrics without re-deriving fields.

The hooks complement the existing per-adapter `onRetry` hook (alpha.17+). `onRetry` covers "the adapter decided to retry an in-flight request"; the Registry-level hooks below cover "the Registry decided to move on" and "a successful call is interesting to observe."

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

## Coverage in alpha.21

| Hook | Emitted? | Where it fires |
|---|---|---|
| `onCost` | ✅ | Every successful `generateText` / `generateStructured` / `runAgent` |
| `onTokenUsage` | ✅ | Every successful `generateText` / `generateStructured` / `runAgent` |
| `onCacheHit` | ✅ | When the response reports `cacheReadTokens > 0` |
| `onFallback` | ✅ (cause: `provider-error`) | When the Registry's `walkChain` advances from one alias to the next |
| `onValidationRetry` | Type only | Use adapter `onRetry` + filter for now |

Stream methods (`streamText`, `streamStructured`) do not emit `onCost` / `onTokenUsage` yet because streamed cost surfaces piecemeal as the stream completes. Streamed-cost emission is the alpha.22 follow-up.

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
