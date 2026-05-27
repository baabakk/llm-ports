---
"@llm-ports/core": minor
"@llm-ports/capabilities": minor
---

Capability factories now thread `reasoningEffort` (per-factory) and `signal` / `forceProviderAlias` (per-call) through to the underlying `port.generateStructured` / `port.generateText` call. Closes a real gap discovered after alpha.12: `createScorer({ reasoningEffort: "high" })` silently dropped the option because the factory didn't pass it through.

**Per-factory** (set once at `Create*Config`, applies to every call):

```ts
const score = createScorer({
  port,
  schema: ScoreSchema,
  schemaName: "lead-score",
  rubric,
  reasoningEffort: "high",  // ← new in alpha.13
});
```

**Per-call** (passed in the input arg, varies per invocation):

```ts
const controller = new AbortController();
const result = await score({
  content: "...",
  signal: controller.signal,             // ← new in alpha.13
  forceProviderAlias: "expensive",       // ← new in alpha.13
});
```

All 7 factories updated: `createClassifier`, `createScorer`, `createExtractor`, `createPlanner`, `createAnalyzer`, `createDrafter`, `createSummarizer`. 13 new tests in `capability-passthrough.test.ts`.

### `attemptValidationRepair` — two new patterns + expanded enum decorator handling

Pattern 5 (enum case-mismatch) now strips a wider range of LLM-output decorators before normalizing:

- Markdown bold/italic: `"**low**"`, `"__low__"`, `"*low*"`, `"_low_"` → `"low"`
- Code fences: `` "`low`" `` → `"low"`
- Wrapping quotes: `'"low"'`, `"'low'"` → `"low"`
- Trailing punctuation: `"Low."`, `"HIGH!"`, `"medium,"` → `"low"` / `"high"` / `"medium"`
- Compound: `"**LOW**."` → `"low"` (strip-loop iterates until stable)

Pattern 7 (NEW): stringified JSON where object/array expected. When the model double-encodes a nested field (`reasoning: "{\"experience\": ...}"` for an `object`-typed slot), the repair pass now `JSON.parse`s it once — but only if the string both starts/ends with `{}` (or `[]`) AND parses cleanly into the expected shape. No risk of garbage substitution on plain prose.

Pattern 8 (NEW): array-with-single-object where object expected. `person: [{ name: "X" }]` for an `object`-typed `person` slot → unwrap to `{ name: "X" }`. Skipped for multi-element arrays (ambiguous).

11 new repair-validation tests; total repair test count 29.

### Test totals

537 tests passing across the workspace (was 508).

### Closes

- BEPA-internal `TD-LLMPORTS-CAPABILITIES-REASONING-EFFORT`
