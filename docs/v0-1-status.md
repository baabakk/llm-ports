# v0.1 status

A single canonical inventory of what's stable in `llm-ports` v0.1, what's still being hardened, and what's deferred to v0.2. Other docs pages link here when a caveat is in play; this page is the authoritative source.

This is the page to share when someone asks "what works in alpha?" or "what should I expect to break?"

---

## What's stable in v0.1

These are load-bearing today, with comprehensive test coverage. Not "experimental"; not "planned." If you build on these, the contract will not change without a deprecation cycle.

| Surface | Coverage |
|---|---|
| `LLMPort` interface (5 methods) | 446 offline tests across 7 packages + cross-adapter contract suite |
| `EmbeddingsPort` interface | covered by OpenAI + Ollama live tests; mocked-SDK regression tests |
| `Registry` with task-route walking + `selectModel` budget gating | offline registry tests in core, plus end-to-end via examples |
| USD cost gating (per-hour / per-day / per-month) | offline + Phase 2 live verification; precision verified at 10 decimals |
| Session-scoped USD cost gating (`Registry.openCostSession`) | offline `cost-session.test.ts`; alpha.5 |
| Anthropic adapter (full feature set: prompt caching, vision, tool use) | full live + contract suites |
| OpenAI adapter (chat + embeddings + 12 compat providers via `baseURL`) | full live + contract; runtime capability discovery; reasoning-model auto-handling; transient-401 burst-protection retry |
| Google Gemini adapter (chat + multimodal + streaming + single-turn agent) | offline content + contract; v0.1 alpha bake in progress |
| Ollama adapter (chat + embeddings + model management) | offline + Phase 2 live |
| Vercel AI SDK adapter (migration-friendly) | offline + contract; v0.1: single-turn agent + text-only multimodal |
| Capability factories (`createClassifier`, `createScorer`, `createDrafter`, `createSummarizer`, `createExtractor`, `createPlanner`, `createAnalyzer`) | offline + Phase 3 live (via Cerebras/Anthropic) |
| Validation strategies (`throw`, `retry-with-feedback`, `fallback-to-next-provider`, `custom`) | offline tests + Phase 2 live exercise |
| Two-layer validation hardening (jsonrepair fallback in `extractJSON` + Zod-issue repair pass) | alpha.5; 20 offline tests; each catch saves an LLM retry round-trip |
| `ContentBlock[]` discriminated union (text, image, audio, tool_use, tool_result) | offline tests across adapters |
| Image-block boundary validation (`ImageTooLargeError`, `InvalidImageUrlError`) | alpha.5; 17 offline tests; per-adapter limits |
| `AbortSignal` cancellation on all 5 `*Options` (in-flight HTTP cancel on 4 adapters, entry-only on Ollama) | alpha.6; 21 tests |
| Latency overhead | mean p50 0.04 ms, max p99 0.47 ms (10× under the 5 ms target) |

The Anthropic + OpenAI + Ollama adapters and the capability factories are the BEPA-extracted core, in production at BEPA for 5+ months across millions of LLM calls. The Google Gemini adapter (alpha.5) and the alpha.6 cancellation work are newer; the contract suite covers them with the same shape as the older adapters.

---

## Known limitations in v0.1

These are tracked publicly. Each row links to the GitHub issue with the full reproduction, workaround, and resolution path. Filter on the [`known-limitation` label](https://github.com/baabakk/llm-ports/issues?q=is%3Aissue+is%3Aopen+label%3Aknown-limitation) for the live list.

### Recently closed (alpha.1 → alpha.6)

Twelve medium-impact issues filed between alpha.0 and alpha.5 have been resolved. Listed here for context — they no longer apply on `@llm-ports/*@alpha`.

| Was | Closed by | Shipped |
|---|---|---|
| `runAgent` tool input schemas passed as `{}` | [#1](https://github.com/baabakk/llm-ports/issues/1) | alpha.1 |
| No `onRetry` observability hook | [#3](https://github.com/baabakk/llm-ports/issues/3) | alpha.1 |
| Vercel adapter starved reasoning models | [#4](https://github.com/baabakk/llm-ports/issues/4) | alpha.1 |
| Vercel `generateStructured` `SyntaxError` on empty responses | [#5](https://github.com/baabakk/llm-ports/issues/5) | alpha.1 |
| Capability factory `taskType` defaults undocumented | [#6](https://github.com/baabakk/llm-ports/issues/6) | alpha.1 |
| `adapter-anthropic` forwarded `temperature` to Claude 4.5+ reasoning | [#12](https://github.com/baabakk/llm-ports/issues/12) | alpha.3 |
| No native Gemini adapter | [#14](https://github.com/baabakk/llm-ports/issues/14) | alpha.5 (`@llm-ports/adapter-google`) |
| No session-scoped cost gate | [#16](https://github.com/baabakk/llm-ports/issues/16) | alpha.5 (`Registry.openCostSession`) |
| Image payload size validation missing at adapter boundary | [#19](https://github.com/baabakk/llm-ports/issues/19) | alpha.5 (`ImageTooLargeError`) |
| Assistant-response `image_url` parts silently dropped | [#20](https://github.com/baabakk/llm-ports/issues/20) | alpha.5 |
| URL-form image scheme not validated (`file://`, `data:`, missing) | [#21](https://github.com/baabakk/llm-ports/issues/21) | alpha.5 (`InvalidImageUrlError`) |
| `signal?: AbortSignal` missing on `*Options`; no mid-flight cancel | [#24](https://github.com/baabakk/llm-ports/issues/24) | alpha.6 |

### Medium-impact (still open in v0.1)

No medium-impact items are currently open. New ones will land here as users report them.

### Lower-impact (real but rarely surfaced)

| Limitation | Surface | Notes |
|---|---|---|
| Registry walks the chain on **budget gating** but does not retry the next provider on **runtime errors** (network 5xx, 429, etc.) | Registry behavior | The `LLM_TASK_ROUTE_X=fast,backup` chain switches when `fast` is over its USD/request budget. If `fast` returns a 5xx mid-call, the call fails — it doesn't auto-retry on `backup`. Catch `ProviderUnavailableError` in your call site for the v0.1 path. Targeted for v0.2. |
| First call to an unknown reasoning model pays one wasted round-trip | OpenAI adapter | The adapter's per-process cache learns the constraint after the first starved attempt. alpha.5 added a static `KNOWN_REASONING_MODELS` catalog covering o-series / gpt-5-nano / Cerebras gpt-oss / Clarifai Qwen3.6 / SambaNova MiniMax-M2.7, so the wasted round-trip is skipped for those. For other reasoning models, supply `pricingOverrides[modelId].capabilities.reasoningModel = true`. |
| Compat-provider live coverage is one-test-deep (basic `generateText` only) | OpenAI adapter via `baseURL` (Cerebras, Groq, Together AI, Fireworks, Clarifai, SambaNova, etc.) | Structured / streaming / agent / embeddings are not regression-tested for compat providers in v0.1. Targeted for v0.2. |
| `adapter-ollama` honors `AbortSignal` at entry but cannot cancel an in-flight request | Ollama adapter | `ollama-js` v0.5 doesn't expose a per-call signal. Coarse `client.abort()` cancels all in-flight, too blunt. Lands when ollama-js v0.7+ exposes per-call signal. |
| `adapter-vercel`'s `runAgent` is single-turn only | Vercel adapter | Multi-step tool use through Vercel's own agent loop ships in v0.2. For multi-turn agents today, prefer the direct adapters. |
| `adapter-vercel` multimodal inputs pass as `[image content]` placeholder strings | Vercel adapter | Image and audio content blocks downgrade to text. Direct adapters support full multimodal. |
| `adapter-vercel` has no bundled pricing table | Vercel adapter | Bring your own `pricing` map. The OpenAI / Anthropic / Google / Ollama adapters ship pricing tables. |
| Native Gemini `responseSchema` constrained-decoding not used | Google Gemini adapter | `adapter-google`'s `generateStructured` uses prompted JSON + Zod + alpha.5 repair pass. Native `responseSchema` ships in v0.2. |
| Gemini embeddings, explicit context caching, code execution tool | Google Gemini adapter | All v0.2 scope. |
| Some compat-provider models require a `pricingOverrides` entry | Registry pricing-validation | Cerebras `gpt-oss-120b`, Clarifai Qwen3.6, SambaNova MiniMax-M2.7, Groq Llama variants, etc. need an explicit pricing override before the registry will admit them. |

### Adapter-specific model quirks (observed 2026-05-12 in live alpha bake)

These aren't adapter bugs — they're model-behavior quirks worth knowing if you target one model in particular. The typed error surface catches them; the call site decides whether to retry, route to a fallback, or surface to the user.

| Model | Quirk | Where it surfaces | Workaround |
|---|---|---|---|
| `claude-haiku-4-5` | Occasionally omits a `z.string().min(N)`-constrained field entirely on first attempt. The model produces JSON missing the field rather than producing a too-short string. Retry-with-feedback sometimes recovers but not always when the prompt is generic. | `generateStructured` with constrained string fields | (a) Add explicit "ALWAYS include the `<field>` field" instruction in the prompt; (b) loosen the `.min(N)` constraint if the validator was being pedantic anyway; (c) catch `ValidationError` and route to a fallback model with `LLM_TASK_ROUTE_X=claude-haiku,gpt-4o-mini`. The typed-error surface works as designed — this is information, not failure. |
| `gpt-4o-mini` | Occasionally returns extra fields not in the Zod schema. Zod ignores them by default. | `generateStructured` against a Zod object without `.strict()` | Add `.strict()` to the Zod object if you care about exact-shape, OR ignore (default Zod behavior is permissive). |

These are observations, not regressions. The plumbing handles both cases predictably; only the user-facing prompt strategy needs awareness.

---

## What v0.2 adds

Roadmap target — not promises, but the work queue. Order is approximate; what ships first is whatever has clearest user need.

| Surface | What ships |
|---|---|
| Vercel adapter feature parity | Multi-turn `runAgent` through Vercel's own agent loop. (Reasoning-model handling and `EmptyResponseError` already landed in `0.1.0-alpha.1` — #4, #5.) |
| Registry runtime fallback | Retry-on-`ProviderUnavailableError` with chain walk. Catch-class configurable. |
| Compat-provider test depth | Structured / streaming / agent / embeddings live tests across Cerebras, Groq, Together, Fireworks. |
| `createAgent` capability factory | Higher-level ergonomics matching `createClassifier` / `createDrafter`. Bundles `wrapWithApprovalGate` + tool/message plumbing into one configure-once factory. The v0.1 path (`runAgent` directly) keeps working. |
| `@llm-ports/observability` | Quality tracking hooks, sinks, deterministic edit-diff helpers. The pieces of BEPA that learn from production traffic, extracted into a separate package so users opt in. |
| Expanded capabilities | Targeted: `redact`, `route`, `decide`, `answer`, `rerank`. Prioritized by user requests in the [capability-request issues](https://github.com/baabakk/llm-ports/issues?q=is%3Aissue+is%3Aopen+label%3Acapability). |

---

## What v0.3+ adds

Further out. Subject to change based on v0.1 + v0.2 user signal.

- `@llm-ports/adapter-transformers-web` or `@llm-ports/adapter-onnxruntime-web` for browser-native local-model inference (transformers.js / onnxruntime-web). Tracked as [#13](https://github.com/baabakk/llm-ports/issues/13). Use cases: SmolDocling, PaddleOCR-VL, SmolVLM running entirely in the browser. Highest-impact single addition still on the roadmap.
- `@llm-ports/adapter-mistral` if the Mistral API stops fitting under the OpenAI compat shape.
- A portable skill / capability format (Markdown-with-YAML-frontmatter) — being evaluated; not a commitment.
- Native streaming for `runAgent` (currently you can stream tool-use steps via the lower-level adapter, but not from the agent loop).

---

## How to track new limitations

If you hit something not on this page, please [open a bug report](https://github.com/baabakk/llm-ports/issues/new?template=bug_report.yml). The template captures the version + repro shape needed to triage. New known-limitation items get the `known-limitation` label and land on this page within a few days.

For open-ended discussion (design feedback, "is this how I should do X?", show-and-tell), [GitHub Discussions](https://github.com/baabakk/llm-ports/discussions) is the better surface than an issue.
