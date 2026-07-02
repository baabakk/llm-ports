# Migrating from alpha.24 to alpha.25

> **Zero breaking changes — runtime AND type-level.** alpha.25 is fully additive. Existing code compiles and runs without modification.
>
> **Heads-up for alpha.26 planning.** The next release (**alpha.26**) will be a **BREAKING API unification**: the four generation methods (`generateText` / `generateStructured` / `streamText` / `streamStructured`) will move from `{ instructions, prompt }` to a canonical `messages: LLMMessage[]` input. A one-cycle deprecation window is planned. See the [alpha.26 planning discussion](https://github.com/baabakk/llm-ports/discussions) for the full plan.

## Install

```bash
pnpm add @llm-ports/core@alpha @llm-ports/adapter-openai@alpha
```

All 7 publishable packages bumped to `0.1.0-alpha.25`.

## The headline

Three additive features under an "Observability surface + reliability hardening" theme:

1. **`refs?: Record<string, ArtifactRef>`** — domain-agnostic trace-metadata field on every call, threaded verbatim to every observability event. Perfect for prompt versioning, cost attribution by tenant / project / experiment, session correlation, or any versioned-artifact identity you want stamped onto trace ([issue #53](https://github.com/baabakk/llm-ports/issues/53)).
2. **`runtimeFallback: "aggressive"`** — the opinionated classifier three consumers rebuilt by hand (BEPA Plan 29, HomeSignal, SalesCoach Plan 30). Walks the chain on rate limits, empty responses, context-window exhaustion, credit-exhaustion 400s, and raw 5xx status codes — not just `ProviderUnavailableError` ([issue #54](https://github.com/baabakk/llm-ports/issues/54)).
3. **Streamed cost surfacing** — `onCost` + `onTokenUsage` observability hooks now fire at natural stream completion for `streamText` and `streamStructured` (adapter-openai in this release; other adapters follow in patch releases) ([issue #55](https://github.com/baabakk/llm-ports/issues/55)).

Zero code changes required for existing consumers. All three features are opt-in.

## What was added

### 1. `refs` field for trace-metadata on every call

Add consumer-owned artifact identifiers to any call; they flow through to every observability event (`onCost`, `onTokenUsage`, `onFallback`, `onCacheHit`, `onValidationRetry`) verbatim. Never sent to the model. Never persisted by the library.

```ts
import type { ArtifactRef } from "@llm-ports/core";

const result = await port.generateStructured({
  taskType: "extract-team-dev",
  prompt: userRequest,
  schema: TeamDevSchema,
  refs: {
    prompt:   { key: "team-dev.materialize", version: 7, hash: "abc123..." },
    scaffold: { key: "puzzle-service", version: 3 },
    tenant:   { key: "acme-corp" },
    experiment: { key: "tone-experiment", version: "variant-b", meta: { cohort: "control" } },
  },
});
```

The observability side reads them back cleanly:

```ts
const registry = createRegistryFromEnv({
  observability: {
    onCost: (event) => {
      audit.recordCost({
        totalUsd: event.totalUsd,
        modelId: event.modelId,
        promptVersion:   event.refs?.prompt?.version,
        scaffoldVersion: event.refs?.scaffold?.version,
        tenant:          event.refs?.tenant?.key,
      });
    },
  },
});
```

**Non-goals (guard against scope creep):**

- Not validated. Empty object is legal; unknown keys are legal.
- Not sent to the model. Trace metadata, not prompt content.
- Not read by adapters. Pass-through only.
- No vocabulary standardization. Consumer picks the keys.
- No merging / inheritance across nested `runAgent` calls.

### 2. `runtimeFallback: "aggressive"` preset

Three consumers rediscovered the same lesson: the default classifier walks only on `ProviderUnavailableError`, which lets credit-exhaustion 400s and empty-response 200s abort the chain in production. The `"aggressive"` preset bundles the classifier:

```ts
import { createRegistryFromEnv } from "@llm-ports/core";

const registry = createRegistryFromEnv({
  adapters: { openai: openaiAdapter, cerebras: cerebrasAdapter, groq: groqAdapter },
  runtimeFallback: "aggressive", // NEW in alpha.25
});
```

Walks on:

| Signal                                | Rationale                                          |
| ------------------------------------- | -------------------------------------------------- |
| `ProviderUnavailableError`            | Existing default                                   |
| `RateLimitError`                      | Try next provider rather than wait out backoff     |
| `EmptyResponseError`                  | Adapter's own retries gave up; try elsewhere       |
| `ContextWindowExceededError`          | Try a larger-window provider                       |
| `BadRequestError` w/ credit patterns  | Account can't serve any call right now             |
| Raw error with `status >= 500`        | Defensive check for adapters that don't wrap 5xx   |

Does NOT walk on:

- `AuthenticationError` (401/403 — credential needs fixing, not routing).
- Generic `BadRequestError` (malformed request — would fail everywhere).
- `ContentPolicyViolationError` (policy filter — separate concern).
- `BudgetExceededError` / `SessionBudgetExceededError` (port-internal gating).

For fine-grained control, the object form still wins:

```ts
runtimeFallback: {
  shouldFallback: (e) =>
    aggressiveShouldFallback(e) || (e instanceof MyCustomError),
},
```

The classifier and the credit-exhaustion pattern list are exported for reuse:

```ts
import {
  aggressiveShouldFallback,
  AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS,
} from "@llm-ports/core";
```

### 3. Streamed cost surfacing

`onCost` and `onTokenUsage` fire once at natural stream completion for `streamText` and `streamStructured` — matching the non-streaming contract. Enabled automatically for `adapter-openai` via `stream_options: { include_usage: true }`.

```ts
const registry = createRegistryFromEnv({
  adapters: { openai: openaiAdapter },
  observability: {
    onCost: (e) => {
      if (e.operation === "streamText" || e.operation === "streamStructured") {
        stats.streamed.add(e.totalUsd);
      }
    },
  },
});

for await (const chunk of registry.getPort().streamText({
  taskType: "chat",
  prompt: "hello",
  refs: { session: { key: "sess-abc123" } },
})) {
  ui.append(chunk);
}
// onCost + onTokenUsage fired once at completion with refs.session.key preserved.
```

**Semantics enforced:**

- Emit ONCE per stream, at natural completion.
- Mid-stream errors do NOT emit (no completion → no billable success).
- Consumer-cancelled streams (via `AbortSignal`) do NOT emit — provider billing for partial completions is the provider's contract.
- Adapters that don't yet implement the stream-completion path just skip the emission (no error, matches alpha.24 behavior).

**Opt-out at the adapter for compat providers that reject `stream_options`:**

```ts
const adapter = createOpenAIAdapter({
  apiKey: process.env.WEIRD_COMPAT_KEY!,
  baseURL: "https://api.weird-compat.example/v1",
  streamUsage: false, // alpha.25+; defaults to true
});
```

## Interaction between the three features

`refs` composes cleanly with the other two. A streamed call with refs still fires `onCost` at completion with `refs` on the event; a streamed call under `"aggressive"` fallback still preserves `refs` across chain advancement:

```ts
for await (const chunk of registry.getPort().streamText({
  taskType: "chat",
  prompt: "hello",
  refs: { prompt: { key: "greeting-v3" } },
})) {
  ui.append(chunk);
}
// If primary rate-limits → aggressive walks → backup succeeds:
//   onFallback fires with refs.prompt.key = "greeting-v3"
//   onCost + onTokenUsage fire at stream completion with refs.prompt.key = "greeting-v3"
```

## Package versions

All 7 publishable packages bumped in lockstep:

- `@llm-ports/core@0.1.0-alpha.25`
- `@llm-ports/adapter-openai@0.1.0-alpha.25`
- `@llm-ports/adapter-anthropic@0.1.0-alpha.25`
- `@llm-ports/adapter-google@0.1.0-alpha.25`
- `@llm-ports/adapter-ollama@0.1.0-alpha.25`
- `@llm-ports/adapter-vercel@0.1.0-alpha.25`
- `@llm-ports/capabilities@0.1.0-alpha.25`

## What's next: alpha.26 is BREAKING

The alpha.26 release will unify the input shape across all five port methods around a canonical `messages: LLMMessage[]` field. The current `{ instructions, prompt }` compression on `generateText` / `generateStructured` / `streamText` / `streamStructured` will move to `@deprecated` in alpha.26 and be removed in alpha.27.

A one-line migration shim ships in alpha.26:

```ts
import { toMessages } from "@llm-ports/core";

port.generateText({
  taskType: "triage",
  messages: toMessages(SYSTEM_PROMPT, userInput), // shim
});
```

Full details in the alpha.26 planning discussion. The alpha.25 → alpha.26 upgrade path will be mechanical for existing consumers via `toMessages()`; the removal window from alpha.26 → alpha.27 is planned at ~2 weeks.

## Full test coverage

- 8 refs tests (7 canonical cases from the proposal + one for empty-refs semantics)
- 23 aggressive-fallback tests (positive + negative per error class, body-pattern matrix, Registry integration)
- 5 streamed-cost tests (callback firing, no-op path, mid-stream error path, refs preservation, streamStructured parity)
- All existing alpha.24 tests continue to pass unchanged

864 total tests pass across the workspace (was 828; +36; zero regressions).
