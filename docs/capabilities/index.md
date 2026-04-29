# Capabilities

`@llm-ports/capabilities` ships seven cognitive operation factories. Each factory takes config (port, schema, prompt fragments, hooks) at definition time and returns a typed function you call per-input.

The seven (extracted from BEPA's production stack):

| Factory | Returns | Default temperature | Use for |
|---------|---------|---------------------|---------|
| [`createClassifier`](/capabilities/classifier) | typed object (Zod) | 0 | Pick one of N categories |
| [`createScorer`](/capabilities/scorer) | typed object (Zod) | 0.1 | Rate against a rubric |
| [`createExtractor`](/capabilities/extractor) | typed object (Zod) | 0 | Pull structured fields |
| [`createSummarizer`](/capabilities/summarizer) | text | 0.2 | Compress meaning-preserving |
| [`createDrafter`](/capabilities/drafter) | text | 0.4 | Generate text in a persona |
| [`createPlanner`](/capabilities/planner) | typed object (Zod) | 0.2 | Decompose into steps |
| [`createAnalyzer`](/capabilities/analyzer) | typed object (Zod) | 0.3 | Evaluate / critique / compare |

10 more capabilities ship in v0.2: tag, detect, expand, rewrite, redact, respond, decide, answer, rerank, agent.

## Why factories?

The factory pattern is the most important API choice in `llm-ports`. Three alternatives were considered and rejected:

- **Plain helpers**: force re-passing config (rubric, schema, hooks) on every call. Boilerplate at the call site.
- **Decorators**: require `experimentalDecorators` config and pollute the type system.
- **Task descriptors**: separate definition from execution, which is the wrong cut for LLM work where prompt fragments ARE the definition.

Factories let you bind `rubric`, `schema`, `boundaryExamples`, `systemContext`, and hooks once at definition time. Reading the call site shows what is bound and what is varying.

## Common shape

Every factory follows the same template:

```ts
const fn = createX({
  // Required
  port: llm,
  schema: z.object({...}),       // for structured-output capabilities
  schemaName: "operation-name",  // appears in observability events

  // Prompt fragments (string OR async function)
  rubric: "...",                  // per-capability variant of the framework
  examples: "...",
  systemContext: async (input) => `dynamic ${await lookup()}`,

  // Routing
  taskType: "triage",             // matches LLM_TASK_ROUTE_TRIAGE in env
  priority: 2,
  temperature: 0.2,
  maxOutputTokens: 1024,

  // Hooks (errors caught and logged but never re-thrown)
  onBeforeCall: async (input) => { /* ... */ },
  onResult: async (event) => { /* ... */ },
  onError: async (err, input) => { /* ... */ },
});
```

Then call with input:

```ts
const result = await fn({ content: "...", contextOverride: "per-call extra context" });
```

## Hooks and the CapabilityEvent

Every successful call invokes `onResult` with a standardized `CapabilityEvent`:

```ts
interface CapabilityEvent<TOutput> {
  capability: string;             // "classify" | "score" | ... — the factory's identity
  schemaName: string;             // the user-supplied operation name
  modelId: string;                // which model actually ran
  providerAlias: string;          // which provider alias was selected
  usage: { inputTokens, outputTokens, totalTokens };
  cost:  { inputUSD, outputUSD, totalUSD };
  latencyMs: number;
  output: TOutput;                // the validated typed result
  validationAttempts?: number;    // present for structured-output capabilities
}
```

Wire this to your analytics pipeline directly:

```ts
const classify = createClassifier({
  port: llm,
  schema: TriageSchema,
  schemaName: "email-triage",
  onResult: async (event) => {
    await myDB.insert("llm_events", {
      capability: event.capability,
      schemaName: event.schemaName,
      modelId: event.modelId,
      cost: event.cost.totalUSD,
      latencyMs: event.latencyMs,
      timestamp: new Date(),
    });
  },
});
```

The standard event shape across all capabilities means you can write one analytics handler and reuse it.

## Dynamic prompt fragments

Prompt fragments accept either a string or a function returning a string. Functions can be sync or async, enabling DB lookups, feature flags, or context-derived content:

```ts
const classifyEmail = createClassifier({
  port: llm,
  schema: TriageSchema,
  schemaName: "email-triage",
  rubric: async () => await loadRubricFromConfigService(),
  systemContext: async (input) => {
    const sender = await getSenderProfile(input.content);
    return `Sender warmth: ${sender.warmth}, last interaction: ${sender.lastSeen}`;
  },
});
```

Resolution happens lazily, per-input. No pre-compilation, no caching unless you add it yourself.

## Hook safety

Hooks should not break the call. If your `onResult` handler throws, the capability:

1. Catches the error
2. Logs it via `console.warn`
3. Returns the model's output to the caller anyway

This is intentional. Observability hooks are nice-to-have; production calls must succeed even when telemetry is broken.

If you want hard-failure on hook errors, throw in `onError` instead — that one re-throws.

## Reading next

- [`createClassifier` →](/capabilities/classifier) — most-used capability
- [`createDrafter` →](/capabilities/drafter) — text generation in a persona
- Source code: [`packages/capabilities/src/`](https://github.com/baabakk/llm-ports/tree/main/packages/capabilities/src)
