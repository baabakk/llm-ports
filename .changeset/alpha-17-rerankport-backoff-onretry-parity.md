---
"@llm-ports/core": minor
"@llm-ports/adapter-google": minor
"@llm-ports/adapter-ollama": minor
"@llm-ports/capabilities": patch
---

First alpha of the v0.1 line approved by Babak per the BEPA-internal `RELEASE-PLAN-0.1.0-roadmap-to-1.0.md`. This release ships 5 small additive items plus the `RerankPort` skeleton that adapter-cohere will implement against in beta.0.

### `RerankPort` skeleton in `@llm-ports/core`

New port interface in `packages/core/src/ports/rerank-port.ts`. Sibling of `LLMPort` and `EmbeddingsPort`. Reranking is a separate computational primitive from chat completion (Cohere Rerank-3, Voyage AI rerank-2, Jina Reranker, Mixedbread mxbai-rerank all ship dedicated rerank APIs that are not chat-shaped). Modeling it as its own port matches the field (LlamaIndex `BaseNodePostprocessor`, LangChain `DocumentCompressor`).

```ts
export interface RerankInput {
  query: string;
  documents: string[];
  topN?: number;
  signal?: AbortSignal;
  forceProviderAlias?: string;
  providerExtras?: Record<string, unknown>;
}

export interface RerankedDocument {
  index: number;
  relevanceScore: number;
  document: string;
}

export interface RerankResult {
  results: RerankedDocument[];
  usage: TokenUsage;
  cost: CostUsage;
  modelId: string;
  providerAlias: string;
}

export interface RerankPort {
  rerank(input: RerankInput): Promise<RerankResult>;
}
```

Six design decisions locked per the BEPA-internal release plan: single query per call (no batching), document text echoed in output, score normalized to `[0, 1]`, long-document handling via `providerExtras` (Cohere `max_chunks_per_doc`, Voyage `truncation`, etc.), multimodal docs out of scope for now, reranker model selection at adapter construction.

`TokenUsage` extended with `searchUnits?` (Cohere bills per search unit) and `rerankedDocuments?` (telemetry). Both optional; unused by `LLMPort` and `EmbeddingsPort` calls.

No adapter implementation yet — first ships in `@llm-ports/adapter-cohere` for beta.0.

### Jittered exponential backoff config

New `BackoffConfig` and `JitterStrategy` types in `@llm-ports/core` plus a pure-function `computeBackoffDelay(attempt, config, prevDelay, rng)` helper. Adapters consume this when computing sleep duration between retries.

```ts
type JitterStrategy = "none" | "full" | "equal" | "decorrelated";

interface BackoffConfig {
  initialDelayMs?: number;    // default 200
  maxDelayMs?: number;        // default 10000
  multiplier?: number;        // default 2
  jitter?: JitterStrategy;    // default "decorrelated"
}
```

Decorrelated jitter is the default per AWS Architecture Blog "Exponential Backoff And Jitter" (2015); it preserves average backoff while breaking up retry storms most aggressively. The shape matches Genkit's middleware retry config so users migrating from Genkit see a familiar API.

10 new unit tests in `packages/core/tests/backoff.test.ts`.

### `onRetry` parity: adapter-google + adapter-ollama

Wire `emitRetryEvent` at the validation-feedback retry sites in `adapter-google` and `adapter-ollama`, matching the existing wiring in `adapter-openai` and `adapter-anthropic`. Both adapters' options interfaces gain an optional `onRetry?: OnRetry` field. Consumers can now wire observability uniformly across all four adapters:

```ts
const adapter = createGoogleAdapter({
  apiKey: process.env.GOOGLE_API_KEY!,
  onRetry: (event) => {
    span.addEvent('llm.retry', {
      reason: event.reason,
      attempt: event.attempt,
      modelId: event.modelId,
    });
  },
});
```

Closes the parity gap named in the BEPA-internal A01 CLAUDE.md "onRetry plumbing" section.

### `validationAttempts` regression contract test strengthened

`packages/adapter-contract-tests/src/suite.ts` now asserts the exact value rather than a `>=` lower bound. First-try success must report `validationAttempts === 1`; one retry must report `=== 2`. This pins the fix for `TD-LLMPORTS-VALIDATION-ATTEMPTS` (resolved alpha.11) so a regression can never re-introduce the "overwrites instead of accumulates" bug.

### Boundary-examples documentation pass

`@llm-ports/capabilities` README gains a "Lifting hand-rolled VOCABULARY blocks into `boundaryExamples`" section showing the before/after migration pattern and the `Resolvable<TInput, string>` shape for per-input vocabularies.

### `forceProviderAlias` budget-bypass property

Already correct in code since alpha.7 (`Registry.selectByAlias` runs budget + cost checks before resolving) and already covered by `packages/core/tests/force-provider.test.ts` lines 163 and 192. No code change needed; the master plan item is closed by verifying the existing tests pin the property explicitly with the comment "caller can't use forceProviderAlias to bypass a hard cap."

### Workspace test summary

577 tests passing (up from 567 in alpha.16). 10 new backoff tests + the strengthened `validationAttempts` assertions. No regressions.
