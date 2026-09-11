**Status:** Planning discussion. Target ship window 2026-09-15 to 2026-09-29 (four to six weeks after alpha.30). Substantially larger release than alpha.28-30; own theme.

**Theme:** Local runtime + orchestration. Three items that together open up a new class of `@llm-ports` consumer: apps running local models (transformers.js, Tesseract) alongside cloud models, unified behind one Registry with one telemetry/session/retry pipeline.

**Prior release:** alpha.30 (planned 2026-09-02; persistent backends + caching; see planning discussion filed alongside).

---

## What ships in alpha.31

Three items forming a single coherent theme.

### Item 1 — `@llm-ports/adapter-transformers-node`

Consumer: Dramma (1a).

**Current gap.** `@xenova/transformers` is the JavaScript port of Hugging Face's transformers library. It runs a broad catalog of small-to-medium models (SmolVLM, SmolDocling, TrOCR, DistilBERT, T5, and many more) locally on Node without a Python subprocess. No `@llm-ports` adapter wraps it today. Consumers that want to run local models alongside cloud models build their own subprocess: HTTP server + response contract + transport plumbing (Dramma's `local-ocr-server` is 315 LoC of exactly this shape).

**Fix shape.** New package `@llm-ports/adapter-transformers-node`. Implements `LLMPort` (`generateText` + `generateStructured` + `streamText`). Wraps `@xenova/transformers`' `pipeline()` API. Handles:

- **Worker recycling** on decode errors (some models leak file handles across many recognize calls).
- **Lazy load progress** logging (large model downloads on first use; consumer wants visibility).
- **HF_HOME cache mount** honored via env var; consumer can pre-warm.
- **AbortSignal** threading into the pipeline call.
- **Deterministic model IDs**: `Xenova/smolvlm-256m`, `Xenova/smoldocling-256m`, etc.
- **Pricing sentinel**: `pricing: 'free'` (per alpha.28 Item 12).

**Task type routing.** Consumers wire the transformers adapter into `LLM_PROVIDER_*` env like any cloud adapter: `LLM_PROVIDER_LOCAL_VLM=transformers-node|Xenova/smolvlm-256m|req:1000/hour`. Task routes point at it: `LLM_TASK_ROUTE_OCR=cloud-vision,local-vlm` and the fallback chain works uniformly.

**Estimated:** ~1000 LoC (adapter + tests + docs + conformance suite compliance).

### Item 2 — `@llm-ports/adapter-tesseractjs`

Consumer: Dramma (1b).

**Current gap.** `tesseract.js` runs Tesseract OCR (open-source, mature, high accuracy on scanned text) in Node. No `@llm-ports` adapter wraps it. Dramma runs it inside the same subprocess as transformers-node.

**Fix shape.** New package `@llm-ports/adapter-tesseractjs`. Implements `LLMPort`: `generateText` returns the recognized text; `generateStructured` throws `UnsupportedOperationError` (Tesseract has no structured-output contract). Wraps `tesseract.js worker.recognize`. Handles:

- **Worker recycling** on decode errors.
- **`uncaughtException` handler pattern** (tesseract.js occasionally raises uncaught errors from its WASM boundary; consumers currently install their own handlers).
- **Tessdata cache mount** honored via env var.
- **Deterministic language routing**: `eng`, `fra`, `deu`, etc. via `LLM_TASK_ROUTE_TESSERACT_ENG=tesseract-eng`.
- **Pricing sentinel**: `pricing: 'free'`.

**Estimated:** ~600 LoC (smaller than transformers-node because OCR-only).

### Item 3 — Pipeline primitive: `port.pipeline([...])`

Consumers: Dramma (4). Also relevant for SalesCoach's coaching + summary chain patterns and BEPA's multi-step triage-then-draft flows.

**Current gap.** Multi-step call chains where each step depends on the previous one's output, and the consumer wants automatic aggregation of cost, usage, latencyMs, providerAlias, retry events across steps, are hand-rolled at every call site. Dramma's `runRefine` (`dramma-ocr.ts:659-694`) is called from three places (cloud, local, self-hosted) with identical aggregation code.

**Fix shape.** New port method `pipeline(steps: PipelineStep[], options?: PipelineOptions)` returns a rolled-up `PipelineResult`.

```ts
interface PipelineStep<TIn = unknown, TOut = unknown> {
  taskType: TaskType;
  input: LLMMessage[] | ((prev: TIn | null) => LLMMessage[]);
  schema?: z.ZodType<TOut>;  // if present, uses generateStructured; else generateText
  reduce?: (prev: TIn | null, curr: TOut) => TIn;  // pass-through by default
  // Optional per-step overrides
  reasoningEffort?: "low" | "medium" | "high";
  forceProviderAlias?: string;
  refs?: Record<string, ArtifactRef>;
}

interface PipelineOptions {
  aggregation?: "sum-cost-and-usage" | "last-only" | "custom";
  refs?: Record<string, ArtifactRef>;  // pipeline-level refs; per-step wins
  signal?: AbortSignal;
  budgetScope?: BudgetScopeRef;
}

interface PipelineResult<TFinal> {
  final: TFinal;
  steps: Array<{ stepIndex: number; taskType: string; result: unknown; usage: TokenUsage; cost: CostUsage; modelId: string; providerAlias: string; latencyMs: number }>;
  totalUsage: TokenUsage;
  totalCost: CostUsage;
  totalLatencyMs: number;
  aliasChain: string[];  // ordered list of provider aliases used across the pipeline
}
```

**Semantics.**

- Steps execute sequentially; each step's output feeds the next step's `input` builder.
- Any step failure aborts the pipeline; partial results returned in `PipelineResult.steps` up to the failure.
- `aggregation: "sum-cost-and-usage"` aggregates by summation; `"last-only"` returns the last step's usage + cost (rare); `"custom"` accepts a reducer function.
- Observability hooks fire per-step (not per-pipeline); consumers can filter by `refs.pipeline_id` if they set one on `PipelineOptions.refs`.
- `budgetScope` applies pipeline-total, not per-step (per Item 4 in alpha.28).

**Estimated:** ~400 LoC (design + implementation + tests + docs).

---

## Open design questions

Five questions consumers should signal on before implementation begins:

1. **`adapter-transformers-node` streaming.** Some transformers models support token-by-token streaming; others don't. Ship `streamText` as `false` for all transformers models (simpler; consistent) OR route on a per-model basis (correct; requires per-model wiring)? **Recommendation:** per-model wiring behind a `capabilities` field in the model registry within the adapter.
2. **`adapter-tesseractjs` languages.** Register one adapter per language (`tesseract-eng`, `tesseract-fra`) OR one adapter that takes the language on the call via `providerExtras.lang`? **Recommendation:** one adapter with per-call language; consistent with how vision-model adapters take image size / detail knobs.
3. **Pipeline signal composition.** How does `PipelineOptions.signal` compose with per-attempt timeouts on individual steps (alpha.28 Item 1) and per-call timeouts (alpha.28 Item 7)? **Recommendation:** step-level signals compose with pipeline signal (the shorter trigger wins); per-attempt timeout applies to individual step attempts within the pipeline.
4. **Pipeline reduce vs feed.** Should each step's output implicitly feed the next step's `input`, OR is that the consumer's responsibility via the `input: (prev) => LLMMessage[]` closure? **Recommendation:** explicit via closure; matches TypeScript ergonomics and avoids surprise coupling.
5. **Alpha.31 target ship date range.** 2026-09-15 (aggressive; two weeks after alpha.30) VERSUS 2026-09-29 (four weeks). **Recommendation:** 2026-09-29 realistically. Alpha.31 is substantially larger than alpha.28-30 (two new packages + a new port primitive); extra week buffer is prudent.

---

## Consumer credit

- **Dramma**: 1a, 1b, 4 (three asks; entire alpha.31 theme is Dramma-driven; Dramma-specific ROI is ~500 LoC + one Docker service + one TechDebt entry resolved).

Other consumers benefit indirectly: BEPA's future local-triage workflows, SalesCoach's coaching-cue latency work, and any ADW flow that would benefit from a small-fast-local first stage before falling to a large-remote model.

---

## Cross-references

- Alpha.28 planning: filed alongside.
- Alpha.29 planning: filed alongside.
- Alpha.30 planning: filed alongside.
- Consumer inputs synthesized in the alpha.27 release plan §A.11 (published post-alpha.27 ship).

Post design-question answers below by 2026-09-01 for baseline scope. This is a longer window than alpha.28-30's because the pipeline design surface benefits from consumer feedback.
