# @llm-ports/capabilities

Reusable cognitive operation factories for [llm-ports](https://github.com/baabakk/llm-ports). Configure once at definition time, call many times — with hooks, dynamic prompt fragments, and full type safety.

## Why factories?

The factory pattern is the most important API choice in `llm-ports`. Three alternatives were considered and rejected (decision 19 in the implementation plan):

- **Plain helpers**: force re-passing config (rubric, schema, hooks) on every call. Boilerplate at the call site.
- **Decorators**: require `experimentalDecorators` config and pollute the type system.
- **Task descriptors**: separate definition from execution, which is the wrong cut for LLM work where prompt fragments ARE the definition.

Factories let you bind `rubric`, `schema`, `boundaryExamples`, `systemContext`, and hooks once at definition time and reuse the configured function across many call sites. Reading the call site shows what is bound and what is varying.

## Installation

```bash
pnpm add @llm-ports/core @llm-ports/capabilities zod
```

## The seven capabilities

These are the seven that BEPA extracts from production. v0.2 will add 10 more (tag, detect, expand, rewrite, redact, respond, decide, answer, rerank, agent ergonomics).

| Factory | Returns | Default temperature | Use for |
|---------|---------|---------------------|---------|
| `createClassifier` | typed object (Zod) | 0 | Pick one of N categories |
| `createScorer` | typed object (Zod) | 0.1 | Rate against rubric |
| `createExtractor` | typed object (Zod) | 0 | Pull structured fields |
| `createSummarizer` | text | 0.2 | Compress meaning-preserving |
| `createDrafter` | text | 0.4 | Generate text in a persona |
| `createPlanner` | typed object (Zod) | 0.2 | Decompose into steps |
| `createAnalyzer` | typed object (Zod) | 0.3 | Evaluate / critique / compare |

## Example: classify

```typescript
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createClassifier } from "@llm-ports/capabilities";
import { z } from "zod";

const llm = createRegistryFromEnv({
  adapters: { anthropic: createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }) },
}).getPort();

// Configure once
export const classifyEmail = createClassifier({
  port: llm,
  schema: z.object({
    priority: z.enum(["P0", "P1", "P2", "P3"]),
    needsReply: z.boolean(),
    reasoning: z.string(),
  }),
  schemaName: "email-triage",
  rubric: `
    P0: customer-blocking; reply within 1 hour
    P1: investor / board / key partner; reply same day
    P2: standard professional; reply within 2 days
    P3: newsletters / FYIs; no reply needed
  `,
  boundaryExamples: `
    "Hey, can we sync at 4pm?" -> P2, needsReply=true
    "RE: ProductHunt promo this week" -> P3, needsReply=false
  `,
  onResult: async (event) => {
    await myAnalytics.track(event);
  },
});

// Call many times
const result = await classifyEmail({ content: emailBody });
// { priority: "P1", needsReply: true, reasoning: "..." }
```

## Example: draft with persona

```typescript
import { createDrafter } from "@llm-ports/capabilities";

export const draftEmail = createDrafter({
  port: llm,
  persona: `
    Babak Abbaschian. Direct, warm, no filler. Short paragraphs.
    Lead with the answer; explain only if needed.
  `,
  channelConstraint: "Email. Target 150-250 words. Sign off: 'Babak'.",
  antiPatterns: `
    Never say: "I wanted to reach out", "I hope this finds you well",
    "Looking forward to hearing from you", "Just wanted to circle back".
  `,
  maxLength: 1500,
});

const draft = await draftEmail({
  instructions: "Reply to Alice's intro request; suggest a 30-min call next week.",
  recipientContext: "Alice from Sequoia. Met at All-In summit. Warm.",
});
```

## Hooks

Every capability supports three optional hooks. Hook errors are caught and logged but never re-thrown.

| Hook | Fires | Purpose |
|------|-------|---------|
| `onBeforeCall(input)` | Before sending to the model | Logging, request rate limiting, mutation tracking |
| `onResult(event)` | After successful validation | Quality tracking, cost analytics, OTel spans |
| `onError(error, input)` | When the call fails | Alerting, fallback handling |

The `event` passed to `onResult` includes capability name, model id, provider alias, token usage, USD cost, latency, validation attempts, and the typed output. Standard shape across all capabilities.

## Dynamic prompt fragments

Prompt fragments accept either a string or an async function. Functions can do DB lookups, feature flags, or context-derived content:

```typescript
const classifyEmail = createClassifier({
  port: llm,
  schema: TriageSchema,
  schemaName: "email-triage",
  rubric: async () => await loadRubricFromDB(),
  systemContext: async (input) => {
    const sender = await getSenderProfile(input.content);
    return `Sender: ${sender.name}, warmth: ${sender.warmth}`;
  },
});
```

## License

MIT
