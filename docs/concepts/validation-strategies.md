# Validation Strategies

When you call `generateStructured`, the model returns text that you'd like to parse into a Zod-validated typed object. Sometimes the model gets the JSON shape right on the first try. Sometimes it doesn't. What happens next is configurable.

## The four strategies

```ts
import type { ValidationStrategy } from "@llm-ports/core";

type ValidationStrategy =
  | { kind: "throw" }
  | {
      kind: "retry-with-feedback";
      maxAttempts: number;
      includeOriginalError: boolean;
    }
  | { kind: "fallback-to-next-provider" }
  | {
      kind: "custom";
      handler: <T>(ctx: ValidationFailureContext<T>) => Promise<T>;
    };
```

### `retry-with-feedback` (default)

When validation fails, the adapter re-prompts the model with the Zod errors injected back into the user message. The model sees:

```
Your previous response failed validation:
- priority: expected one of "P0"|"P1"|"P2"|"P3", got "urgent"
- needsReply: expected boolean, got "yes"

Reply with a single corrected JSON object only.
```

In BEPA's production data, this strategy achieves ~70% fix rate on the second attempt. Default config: `maxAttempts: 2, includeOriginalError: true`.

```ts
import { createRegistryFromEnv } from "@llm-ports/core";

const registry = createRegistryFromEnv({
  adapters: { anthropic: ... },
  // This is the default; setting it explicitly for documentation
  validationStrategy: {
    kind: "retry-with-feedback",
    maxAttempts: 2,
    includeOriginalError: true,
  },
});
```

The `validationAttempts` field on the result tells you how many tries it took:

```ts
const result = await llm.generateStructured({ ... });
console.log(result.validationAttempts); // 1 = first try; 2+ = retry succeeded
```

### `throw`

Fail immediately with `ValidationError` on the first parse failure. No retry. Useful when:

- You don't trust the model to self-correct
- Latency matters more than success rate
- You're treating validation failure as a real signal (not a robustness issue)

```ts
validationStrategy: { kind: "throw" }
```

### `fallback-to-next-provider`

Skip to the next provider in the task's fallback chain. Useful when:

- A specific model consistently fails to produce valid JSON for a particular schema, and a different model handles it correctly
- You'd rather pay more for a more reliable model than retry-loop the cheaper one

This strategy short-circuits retry-with-feedback. It treats validation failure the same as a network failure: skip and try the next provider.

```ts
validationStrategy: { kind: "fallback-to-next-provider" }
```

### `custom`

Total control. Your handler decides what happens.

```ts
validationStrategy: {
  kind: "custom",
  handler: async <T>(ctx) => {
    // ctx.attempt: which attempt this is (1, 2, ...)
    // ctx.schema: the Zod schema the user passed
    // ctx.rawOutput: what the model returned (unparsed)
    // ctx.issues: Zod validation issues
    // ctx.retry: function to re-invoke the model with an optional correction message

    // Example: log to telemetry and retry with a custom correction
    await myAnalytics.recordValidationFailure(ctx);
    return ctx.retry("Please use the exact field names from the schema.");
  },
}
```

The custom handler must eventually either return a valid `T` or throw.

## Where the retry actually happens

The retry loop lives **inside the adapter**, not the registry. Each adapter implements its own structured-output flow with the validation strategy. This means:

- Different adapters may use different mechanisms underneath (Anthropic uses prompted JSON; OpenAI uses native `response_format: json_object`; Ollama uses `format: "json"`)
- All adapters honor the same `ValidationStrategy` semantics

You can also override the strategy per-adapter at adapter-creation time (instead of at registry-creation time):

```ts
const adapter = createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  validationStrategy: { kind: "retry-with-feedback", maxAttempts: 3, includeOriginalError: true },
});
```

This sets the default for that adapter. The registry-level strategy passed to `createRegistryFromEnv` overrides per-adapter defaults if both are set.

## What "validation failure" means

The model's text response is run through `JSON.parse` to extract a JSON object (the adapter is tolerant of code fences and surrounding prose), then through `schema.safeParse(...)`. If `safeParse` fails, validation has failed.

Failure cases:

- Output isn't valid JSON at all (model wrote prose, code fences, etc.)
- Output is valid JSON but doesn't match the schema (wrong field names, types, enum values)
- Output is partial (model truncated due to `max_tokens`)
- Output is empty (provider returned no completion). Common with reasoning models when `maxOutputTokens` is set too low — the model spends the whole budget on internal chain-of-thought and produces zero visible tokens. The OpenAI adapter detects this and auto-retries with a 10× headroom multiplier (see the [OpenAI adapter docs](/adapters/openai)). The Vercel adapter currently surfaces this as a `SyntaxError: Unexpected end of JSON input` (tracked at [#5](https://github.com/baabakk/llm-ports/issues/5)).

The retry-with-feedback prompt names the specific issues so the model can target the fix.

## Per-call strict-mode override (alpha.21+)

The OpenAI adapter has two structured-output modes: classic `response_format: json_object` (valid JSON, no schema enforcement; recovered via `retry-with-feedback` if a field is missing) and strict `response_format: json_schema` (provider-enforced schema; missing fields impossible). Auto-detection at the adapter level decides per `baseURL` ([OpenAI native / Cerebras / Groq / SambaNova / DeepInfra / Parasail default to strict](/adapters/openai#auto-detection-alpha-14)).

`GenerateStructuredOptions.strict?: boolean` (and the same field on `StreamStructuredOptions`) overrides the adapter-level decision for a single call. Precedence:

1. `options.strict` (per-call; highest)
2. adapter-level `useStrictResponseFormat` (set at adapter construction)
3. `autoDetectStrictResponseFormat(baseURL)` default (applied to step 2 if step 2 was unset)

Adapters that don't implement strict mode silently ignore the field (no exception).

**Use case.** A registry with one adapter alias per provider needs to flip strict on/off per call based on the schema shape:

- **Closed-shape schemas** (every field required or `.optional()`, no `z.record(...)`) can use strict mode. They benefit from zero retry-with-feedback rounds on schema drift.
- **Open-shape schemas** (`z.record(...)` for dynamic-key dictionaries) are incompatible with strict mode's `additionalProperties: false` requirement. They must fall back to `json_object` + `retry-with-feedback`.

```ts
// Closed-shape: ask for strict regardless of adapter default.
await port.generateStructured({
  taskType: "triage",
  prompt: "Categorize this message",
  schema: ClosedShape,
  strict: true,
});

// z.record-bearing schema: drop to json_object even on a strict-default adapter.
await port.generateStructured({
  taskType: "tpm-intake",
  prompt: "Intake the TPM contract",
  schema: SchemaWithZRecord,
  strict: false,
});
```

The 5 structured-output capability factories (`createClassifier`, `createScorer`, `createExtractor`, `createAnalyzer`, `createPlanner`) forward `strict?` from their per-call input shapes.

## `onRetry` observability

Adapters expose an `onRetry` hook (alpha.17+) that fires whenever they decide to retry mid-call. The hook is observability-only; throwing from it doesn't cancel the retry.

```ts
const adapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  onRetry: (e) => {
    // e.reason ∈ "transient-auth" | "capability-fallback" | "reasoning-starvation" | "validation-feedback"
    myLogger.warn(`adapter retry: ${e.reason}`, e);
  },
});
```

For validation-feedback retries specifically:

```ts
if (e.reason === "validation-feedback") {
  myMetrics.validationRetries.inc({ model: e.modelId, provider: e.providerAlias });
}
```

For Registry-level observability hooks (`onCost`, `onTokenUsage`, `onFallback`, `onCacheHit`), see the [Observability hooks](/concepts/observability) concept page.

## Caveats

- **Validation retries cost money.** Each retry is a full API call. Track `validationAttempts` in production to detect schema-model mismatches that consistently retry.
- **Validation retries cost latency.** Each retry adds the full provider round-trip latency.
- **Some schemas are hard for some models.** If a model consistently fails a particular schema even after retries, change the schema (simpler, fewer enum values) or change the model (more capable).
- **Don't use deeply-nested or recursive schemas with weak models.** Even the largest models struggle with deeply-nested structured output. Flat schemas perform best.

## Reading next

- [`createClassifier` capability →](/capabilities/classifier) — uses validation strategies internally
- [`createExtractor` capability →](/capabilities/extractor) — same
- [Observability hooks →](/concepts/observability) — Registry-level OTel-aligned hooks for cost, tokens, fallback, cache hits
