# @llm-ports/capabilities

## 0.1.0-alpha.13

### Minor Changes

- 7c27b2d: Capability factories now thread `reasoningEffort` (per-factory) and `signal` / `forceProviderAlias` (per-call) through to the underlying `port.generateStructured` / `port.generateText` call. Closes a real gap discovered after alpha.12: `createScorer({ reasoningEffort: "high" })` silently dropped the option because the factory didn't pass it through.

  **Per-factory** (set once at `Create*Config`, applies to every call):

  ```ts
  const score = createScorer({
    port,
    schema: ScoreSchema,
    schemaName: "lead-score",
    rubric,
    reasoningEffort: "high", // ← new in alpha.13
  });
  ```

  **Per-call** (passed in the input arg, varies per invocation):

  ```ts
  const controller = new AbortController();
  const result = await score({
    content: "...",
    signal: controller.signal, // ← new in alpha.13
    forceProviderAlias: "expensive", // ← new in alpha.13
  });
  ```

  All 7 factories updated: `createClassifier`, `createScorer`, `createExtractor`, `createPlanner`, `createAnalyzer`, `createDrafter`, `createSummarizer`. 13 new tests in `capability-passthrough.test.ts`.

  ### `attemptValidationRepair` — two new patterns + expanded enum decorator handling

  Pattern 5 (enum case-mismatch) now strips a wider range of LLM-output decorators before normalizing:
  - Markdown bold/italic: `"**low**"`, `"__low__"`, `"*low*"`, `"_low_"` → `"low"`
  - Code fences: ``"`low`"`` → `"low"`
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

### Patch Changes

- Updated dependencies [7c27b2d]
  - @llm-ports/core@0.1.0-alpha.13

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies [1d78426]
  - @llm-ports/core@0.1.0-alpha.12

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies [286f132]
  - @llm-ports/core@0.1.0-alpha.9

## 0.1.0-alpha.7

### Patch Changes

- Updated dependencies [c805169]
  - @llm-ports/core@0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- Updated dependencies [34cd6cd]
  - @llm-ports/core@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies [b00ff65]
- Updated dependencies [b00ff65]
- Updated dependencies [b00ff65]
  - @llm-ports/core@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- Updated dependencies [f0885e6]
  - @llm-ports/core@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- Updated dependencies [fbbd507]
  - @llm-ports/core@0.1.0-alpha.3

## 0.1.0-alpha.1

### Patch Changes

- Docs: surface the implicit task types used by capability factories. Each factory (`createClassifier`, `createScorer`, `createDrafter`, `createSummarizer`, `createExtractor`, `createPlanner`, `createAnalyzer`) defaults to a specific `taskType` (`classify`, `score`, `draft`, ...). If your `.env` only declares a single `LLM_TASK_ROUTE_*` entry and you call a capability without overriding `taskType`, the registry throws `NoProvidersAvailableError`. The getting-started guide now shows the catch-all pattern (`LLM_TASK_ROUTE_GENERAL=fast,smart`), and the task-routing concept page documents per-capability defaults and how to override them. No API change — the `taskType?: string` config option already existed. Closes #6.
- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- Initial alpha release.

  `llm-ports` is a TypeScript library implementing hexagonal-style ports & adapters for LLMs in production: multi-provider routing, USD-denominated cost gating, fallback chains, validation-failure recovery, and 7 capability factories (classify, score, draft, summarize, extract, plan, analyze).

  This alpha ships:
  - `@llm-ports/core` — `LLMPort` + `EmbeddingsPort` interfaces, `Registry` with task routing and fallback chains, USD cost computation with cache-discount support, in-memory budget + cost backends, `ContentBlock` discriminated union (text, image, audio, tool_use, tool_result), pluggable validation strategies, error class hierarchy.
  - `@llm-ports/capabilities` — 7 cognitive operation factories (`createClassifier`, `createScorer`, `createDrafter`, `createSummarizer`, `createExtractor`, `createPlanner`, `createAnalyzer`) with `onResult` / `onError` / `onBeforeCall` hooks, async resolver support for rubrics and personas.
  - `@llm-ports/adapter-anthropic` — direct `@anthropic-ai/sdk` adapter, prompt caching, vision, tool use.
  - `@llm-ports/adapter-openai` — OpenAI SDK adapter; `baseURL` covers 10+ OpenAI-compat providers (Azure, Groq, Together, Fireworks, DeepInfra, Perplexity, Cerebras, LiteLLM proxy). Runtime capability discovery (temperature locked, JSON mode, system message). Reasoning-model auto-recovery (OpenAI o-series + Cerebras gpt-oss). Transient-401 burst-protection retry for `sk-proj-*` keys.
  - `@llm-ports/adapter-ollama` — native Ollama adapter, model management (list/pull/delete/health), local-LLM workflows.
  - `@llm-ports/adapter-vercel` — bring-your-own-Vercel-models migration adapter; lets users on `@ai-sdk/*` adopt `llm-ports` plumbing without rewriting their SDK setup.

  Peer dependency: `zod >=3.24.0 <5`. Bring your own SDKs (`@anthropic-ai/sdk`, `openai`, `ollama`, `ai`).

  Pre-launch test plan summary: 211 offline tests pass, 22 of 26 live API tests pass (with 4 documented model-flakiness items), latency p99 0.85ms vs 5ms target, 0 doc-rot signals across 111 doc snippets, fresh tarball install verified.

### Patch Changes

- Updated dependencies
  - @llm-ports/core@0.1.0-alpha.0
