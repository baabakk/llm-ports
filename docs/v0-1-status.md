# v0.1 status

A single canonical inventory of what's stable in `llm-ports` v0.1, what's still being hardened, and what's deferred to v0.2. Other docs pages link here when a caveat is in play; this page is the authoritative source.

This is the page to share when someone asks "what works in alpha?" or "what should I expect to break?"

---

## What's stable in v0.1

These are load-bearing today, with comprehensive test coverage. Not "experimental"; not "planned." If you build on these, the contract will not change without a deprecation cycle.

| Surface | Coverage |
|---|---|
| `LLMPort` interface (5 methods + optional `listModels`) | 537 offline tests across 7 packages + cross-adapter contract suite |
| `EmbeddingsPort` interface | covered by OpenAI + Ollama live tests; mocked-SDK regression tests |
| `Registry` with task-route walking + `selectModel` budget gating | offline registry tests in core, plus end-to-end via examples |
| Registry runtime fallback (`runtimeFallback: "default" \| "none" \| { shouldFallback }`) | alpha.7; offline + contract |
| `forceProviderAlias` per-call routing override | alpha.7; offline |
| `reasoningEffort` parameter (o-series / gpt-5-nano / Groq gpt-oss-120b) | alpha.12; 5 unit + 13 capability passthrough tests |
| Runtime model discovery (`LLMPort.listModels()` + `Registry.checkPricingFreshness()`) | alpha.9; 4 of 5 adapters + 4 registry tests |
| USD cost gating (per-hour / per-day / per-month) | offline + Phase 2 live verification; precision verified at 10 decimals |
| Session-scoped USD cost gating (`Registry.openCostSession`) | offline `cost-session.test.ts`; alpha.5 |
| Anthropic adapter (full feature set: prompt caching, vision, tool use, `dangerouslyAllowBrowser`) | full live + contract suites |
| OpenAI adapter (chat + embeddings + 12 compat providers via `baseURL`, `useStrictResponseFormat` auto-detects on OpenAI native + Cerebras + Groq, `dangerouslyAllowBrowser`, `reasoning_effort` passthrough) | full live + contract; runtime capability discovery; reasoning-model auto-handling; transient-401 burst-protection retry |
| Google Gemini adapter (chat + multimodal + streaming + multi-turn agent + native `responseSchema`) | alpha.9; offline content + contract + quirks |
| Ollama adapter (chat + embeddings + model management + `listModels`) | offline + Phase 2 live |
| Vercel AI SDK adapter (migration-friendly) | offline + contract; v0.1: single-turn agent + text-only multimodal |
| Capability factories (`createClassifier`, `createScorer`, `createDrafter`, `createSummarizer`, `createExtractor`, `createPlanner`, `createAnalyzer`) — carry full port surface (`reasoningEffort` + `signal` + `forceProviderAlias`) since alpha.13 | offline + 13 passthrough tests + Phase 3 live (via Cerebras/Anthropic) |
| Validation strategies (`throw`, `retry-with-feedback`, `fallback-to-next-provider`, `custom`) | offline tests + Phase 2 live exercise |
| Two-layer validation hardening (jsonrepair fallback in `extractJSON` + Zod-issue repair pass with 8 patterns including markdown decorator strip, stringified-JSON-as-object, single-element-array-unwrap) | alpha.5 base + alpha.13 extensions; 29 offline tests; each catch saves an LLM retry round-trip |
| `ContentBlock[]` discriminated union (text, image, audio, tool_use, tool_result) | offline tests across adapters |
| Image-block boundary validation (`ImageTooLargeError`, `InvalidImageUrlError`) | alpha.5; 17 offline tests; per-adapter limits |
| `AbortSignal` cancellation on all 5 `*Options` (in-flight HTTP cancel on 4 adapters, entry-only on Ollama) — propagated through capability factories | alpha.6 + alpha.13; 21 tests |
| Latency overhead | mean p50 0.04 ms, max p99 0.47 ms (10× under the 5 ms target) |

The Anthropic + OpenAI + Ollama adapters and the capability factories are the BEPA-extracted core, in production at BEPA for 6+ months across millions of LLM calls. The Google Gemini adapter (alpha.5 multimodal + chat, alpha.9 multi-turn + responseSchema) and the cross-cutting model-discovery API (alpha.9), `reasoningEffort` passthrough (alpha.12), and the capability-factory port-surface alignment (alpha.13) are newer; the contract suite covers them with the same shape as the older adapters.

---

## Known limitations in v0.1

These are tracked publicly. Each row links to the GitHub issue with the full reproduction, workaround, and resolution path. Filter on the [`known-limitation` label](https://github.com/baabakk/llm-ports/issues?q=is%3Aissue+is%3Aopen+label%3Aknown-limitation) for the live list.

### Recently closed (alpha.1 → alpha.13)

Fourteen medium-impact issues filed between alpha.0 and alpha.9 have been resolved, plus four follow-up BEPA-internal TD entries closed by alpha.10 → alpha.13 (Claude 4.5+ `temperature` catalog expansion, `generateStructured` usage accumulation, `reasoning_effort` passthrough, capability-factory port-surface alignment). Listed here for context — they no longer apply on `@llm-ports/*@alpha`.

| Was | Closed by | Shipped |
|---|---|---|
| `runAgent` tool input schemas passed as `{}` | [#1](https://github.com/baabakk/llm-ports/issues/1) | alpha.1 |
| No `onRetry` observability hook | [#3](https://github.com/baabakk/llm-ports/issues/3) | alpha.1 |
| Vercel adapter starved reasoning models | [#4](https://github.com/baabakk/llm-ports/issues/4) | alpha.1 |
| Vercel `generateStructured` `SyntaxError` on empty responses | [#5](https://github.com/baabakk/llm-ports/issues/5) | alpha.1 |
| Capability factory `taskType` defaults undocumented | [#6](https://github.com/baabakk/llm-ports/issues/6) | alpha.1 |
| No live model-discovery API; bundled pricing tables drift silently | [#9](https://github.com/baabakk/llm-ports/issues/9) | alpha.7 (runtime fallback) + alpha.9 (`listModels` + `Registry.checkPricingFreshness`) |
| `adapter-anthropic` forwarded `temperature` to Claude 4.5+ reasoning | [#12](https://github.com/baabakk/llm-ports/issues/12) | alpha.3 |
| No native Gemini adapter | [#14](https://github.com/baabakk/llm-ports/issues/14) | alpha.5 (`@llm-ports/adapter-google`) |
| No session-scoped cost gate | [#16](https://github.com/baabakk/llm-ports/issues/16) | alpha.5 (`Registry.openCostSession`) |
| Image payload size validation missing at adapter boundary | [#19](https://github.com/baabakk/llm-ports/issues/19) | alpha.5 (`ImageTooLargeError`) |
| Assistant-response `image_url` parts silently dropped | [#20](https://github.com/baabakk/llm-ports/issues/20) | alpha.5 |
| URL-form image scheme not validated (`file://`, `data:`, missing) | [#21](https://github.com/baabakk/llm-ports/issues/21) | alpha.5 (`InvalidImageUrlError`) |
| `signal?: AbortSignal` missing on `*Options`; no mid-flight cancel | [#24](https://github.com/baabakk/llm-ports/issues/24) | alpha.6 |
| Adapters don't expose `dangerouslyAllowBrowser` — blocks browser usage | [#32](https://github.com/baabakk/llm-ports/issues/32) | alpha.9 (openai + anthropic) |
| Gemini `generateStructured` uses prompted JSON, not native `responseSchema`; `runAgent` is single-turn | (rolled-up from alpha.5 release notes) | alpha.9 |
| `claude-opus-4-7` rejects `temperature` in streaming methods (catalog only covered 4-5) | BEPA TD-LLMPORTS-OPUS-4-7 | alpha.10 (`/^claude-(opus\|sonnet)-4-\d/`) |
| `generateStructured` overwrites `usage` across retry-with-feedback attempts instead of accumulating | BEPA TD-LLMPORTS-VALIDATION-ATTEMPTS | alpha.11 (mergeTokenUsage across all 5 adapters) |
| `reasoning_effort` parameter not exposed; Groq `gpt-oss-120b` can't reach `"high"` effort | BEPA TD-LLMPORTS-REASONING-EFFORT | alpha.12 (per-call option on all 5 `*Options`) |
| Capability factories drop `reasoningEffort` (and `signal` / `forceProviderAlias`) — never propagated to underlying port call | BEPA TD-LLMPORTS-CAPABILITIES-REASONING-EFFORT | alpha.13 (all 7 factories) |
| `useStrictResponseFormat` only auto-detected for Cerebras — OpenAI native + Groq users silently paid the un-strict tax (broken-by-default for nested schemas) | BEPA TD-APPLICATIONS-SCORING-SCHEMA-STRICT-MULTIPROVIDER | alpha.14 (auto-detect expanded to OpenAI native + `api.openai.com` + `api.groq.com`) |
| SambaNova MiniMax-M2.7 fails 0/10 on nested schemas with default settings; strict-mode behavior was undocumented | BEPA TD-APPLICATIONS-SCORING-SCHEMA-STRICT-MULTIPROVIDER sub-task 3 | alpha.15 (empirical probe confirmed strict mode works → `api.sambanova.ai` added to auto-detect) |
| Provider-specific request knobs (vLLM `chat_template_kwargs` for Qwen3 `enable_thinking` and DeepSeek `thinking`, SGLang `regex` / `ebnf`, vLLM `guided_json` / `guided_grammar`, Together `repetition_penalty`, etc.) had no typed escape hatch on the port; users dropped to direct port calls with `as unknown as` casts | (alpha.16 design ticket; addresses frontier-OSS-via-vLLM gap) | alpha.16 (`providerExtras?: Record<string, unknown>` on every `*Options` interface, shallow-merged AFTER typed fields; threaded through all 7 capability factories; vLLM + SGLang worked examples in adapter docs) |

### Medium-impact (still open in v0.1)

No medium-impact items are currently open. New ones will land here as users report them.

### Lower-impact (real but rarely surfaced)

| Limitation | Surface | Notes |
|---|---|---|
| First call to an unknown reasoning model pays one wasted round-trip | OpenAI adapter | The adapter's per-process cache learns the constraint after the first starved attempt. alpha.5 added a static `KNOWN_REASONING_MODELS` catalog covering o-series / gpt-5-nano / Cerebras gpt-oss / Clarifai Qwen3.6 / SambaNova MiniMax-M2.7, so the wasted round-trip is skipped for those. For other reasoning models, supply `pricingOverrides[modelId].capabilities.reasoningModel = true`. |
| Compat-provider live coverage is one-test-deep (basic `generateText` only) | OpenAI adapter via `baseURL` (Cerebras, Groq, Together AI, Fireworks, Clarifai, SambaNova, etc.) | Structured / streaming / agent / embeddings are not regression-tested for compat providers in v0.1. alpha.9 added `useStrictResponseFormat` to fix the Cerebras silent-ignore-`json_object` case. Broader test coverage targeted for v0.2. |
| `adapter-ollama` honors `AbortSignal` at entry but cannot cancel an in-flight request | Ollama adapter | `ollama-js` v0.5 doesn't expose a per-call signal. Coarse `client.abort()` cancels all in-flight, too blunt. Lands when ollama-js v0.7+ exposes per-call signal. |
| `adapter-vercel`'s `runAgent` is single-turn only | Vercel adapter | Multi-step tool use through Vercel's own agent loop ships in v0.2. For multi-turn agents today, prefer the direct adapters. |
| `adapter-vercel` multimodal inputs pass as `[image content]` placeholder strings | Vercel adapter | Image and audio content blocks downgrade to text. Direct adapters support full multimodal. |
| `adapter-vercel` has no `listModels()` implementation | Vercel adapter | Underlying `LanguageModel` is opaque per-provider; no uniform discovery surface. `Registry.checkPricingFreshness` reports it as skipped. |
| Gemini embeddings, explicit context caching, code execution tool | Google Gemini adapter | All v0.2 scope. |
| Some compat-provider models require a `pricingOverrides` entry | Registry pricing-validation | Cerebras `gpt-oss-120b`, Clarifai Qwen3.6, SambaNova MiniMax-M2.7, Groq Llama variants, etc. need an explicit pricing override before the registry will admit them. |
| Provider-side pricing isn't exposed via `listModels()` | All adapters | OpenAI / Anthropic / Google `/models` endpoints return IDs + metadata but not USD rates, so `Registry.checkPricingFreshness()` can detect added/removed models but not rate-only drift. Use the [bundled-pricing source URLs](https://github.com/baabakk/llm-ports/blob/main/packages/adapter-openai/src/pricing.ts) to reconcile manually. |

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
