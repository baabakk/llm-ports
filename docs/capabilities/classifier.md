# `createClassifier`

Pick exactly one category from N options. Returns a typed Zod-validated object (typically including the chosen category plus a reasoning field). Default temperature 0 (deterministic).

## Signature

```ts
function createClassifier<TSchema extends z.ZodTypeAny>(config: {
  port: LLMPort;
  schema: TSchema;
  schemaName: string;
  rubric?: Resolvable<ClassifyInput, string>;
  boundaryExamples?: Resolvable<ClassifyInput, string>;
  systemContext?: Resolvable<ClassifyInput, string>;
  taskType?: string;          // default "classify"
  priority?: LLMPriority;
  temperature?: number;       // default 0
  maxOutputTokens?: number;
  onBeforeCall?: (input: ClassifyInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<z.infer<TSchema>>) => void | Promise<void>;
  onError?: (error: Error, input: ClassifyInput) => void | Promise<void>;
}): (input: ClassifyInput) => Promise<z.infer<TSchema>>;

interface ClassifyInput {
  content: MessageContent;          // text or multimodal blocks
  contextOverride?: string;          // per-call extra context
}
```

## Minimal example

```ts
import { createClassifier } from "@llm-ports/capabilities";
import { z } from "zod";

const IntentSchema = z.object({
  intent: z.enum(["question", "request", "complaint", "feedback"]),
  reasoning: z.string(),
});

export const classifyIntent = createClassifier({
  port: llm,
  schema: IntentSchema,
  schemaName: "user-intent",
  rubric: `
    question: asking for information
    request: wants something done
    complaint: reports a problem
    feedback: opinion, no action requested
  `,
});

const result = await classifyIntent({ content: "Can I get a refund?" });
// { intent: "request", reasoning: "..." }
```

## With boundary examples (recommended)

Boundary examples disambiguate edge cases the rubric alone leaves ambiguous:

```ts
export const classifyIntent = createClassifier({
  port: llm,
  schema: IntentSchema,
  schemaName: "user-intent",
  rubric: `
    question: asking for information
    request: wants something done
  `,
  boundaryExamples: `
    "Can I get a refund?" -> request, not question (implies action)
    "What's your return policy?" -> question, not request
    "Do you ship to Canada?" -> question (informational)
    "Please ship this to Canada" -> request (action)
  `,
});
```

## Dynamic per-call context

```ts
export const classifyEmail = createClassifier({
  port: llm,
  schema: TriageSchema,
  schemaName: "email-triage",
  rubric: TRIAGE_RUBRIC,
  systemContext: async (input) => {
    // Look up sender data per-call
    const sender = await getSenderProfile(input.content);
    return `Sender: ${sender.name} (warmth: ${sender.warmth}, last seen: ${sender.lastSeen})`;
  },
});
```

The `systemContext` function runs per call. Combine with per-call `contextOverride`:

```ts
const result = await classifyEmail({
  content: emailBody,
  contextOverride: "User flagged: high-priority sender",
});
```

## Hooks for observability

```ts
export const classifyIntent = createClassifier({
  port: llm,
  schema: IntentSchema,
  schemaName: "user-intent",
  rubric: "...",
  onResult: async (event) => {
    await analytics.track("intent_classified", {
      intent: event.output.intent,
      cost: event.cost.totalUSD,
      latencyMs: event.latencyMs,
      modelId: event.modelId,
    });
  },
  onError: async (err, input) => {
    await alerting.notify("classify-error", { error: err.message });
  },
});
```

Hook errors in `onResult` are caught and logged via `console.warn`; the classifier still returns the result. Hook errors in `onError` propagate (re-throw to surface).

## Validation behavior

If the model's first output fails Zod validation, the [retry-with-feedback strategy](/concepts/validation-strategies) re-prompts with the validation errors injected. Default: max 2 attempts. The `validationAttempts` field on the result tells you how many tries it took:

```ts
const intent = await classifyIntent({ content });
console.log(result.validationAttempts);  // 1 = first try; 2 = retry succeeded
```

## Reading next

- [`createScorer`](/capabilities/scorer) — when you want a number, not a category
- [`createExtractor`](/capabilities/extractor) — when you want multiple fields at once
- [Validation strategies](/concepts/validation-strategies)
