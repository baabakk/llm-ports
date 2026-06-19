---
"@llm-ports/capabilities": minor
---

The five structured-output capability factories (`createClassifier`, `createScorer`, `createExtractor`, `createAnalyzer`, `createPlanner`) now accept and forward an optional per-call `strict?: boolean` to the underlying `LLMPort.generateStructured` call.

```ts
const classify = createClassifier({ port, schema: ClosedShape, schemaName: "intent" });

// Force strict mode for this call (e.g. because the operator knows the
// schema is closed and the adapter's default is json_object).
const result = await classify({ content: "...", strict: true });
```

`createSummarizer` and `createDrafter` are NOT updated because they call `generateText`, not `generateStructured` — strict mode is a structured-output concept and would be a no-op there.

Same precedence as the core port surface: per-call > adapter-level > auto-detect. Adapters that don't implement strict mode silently ignore the hint.

See llm-ports#46 and the alpha.21 `@llm-ports/core` changelog entry.
