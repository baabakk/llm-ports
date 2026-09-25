# v0.1 status

A single canonical inventory of what is stable in `llm-ports` today, what is still being hardened, and what comes next. Other pages link here when a caveat is in play, and this page is the authoritative source for all three.

This is the page to share when someone asks "what works in alpha?" or "what should I expect to break?"

**Where this is heading, since it changes how to read the rest of the page.** The alpha line was to end at `0.1.0-alpha.35`, published 2026-09-25. **One more alpha follows it**, a `0.1.0-alpha.35.1` dot-release repaying two defects a consumer reported against `alpha.35`, the sharper of which is that `onComplete` covers two of the nine operations its type names. After that, the next release is a candidate for `1.0.0` carrying every remaining breaking change at once. Everything below described as deferred to "v0.2" belongs to the additive line after that, which is `1.1.0`. The [sequence is set out further down](#what-ships-next).

---

## How to install during the alpha line

> **Recommended: exact-version pin** during alphas, not the `@alpha` dist-tag. The `@alpha` tag tracks the latest published prerelease, so a routine `pnpm install` can carry you across a breaking change. Pin the exact version and bump deliberately, reading [MIGRATION.md](https://github.com/baabakk/llm-ports/blob/main/MIGRATION.md) at each step.
>
> ```jsonc
> // package.json, recommended while the version is a prerelease
> { "dependencies": { "@llm-ports/core": "0.1.0-alpha.35" } }
> ```
>
> **Once `1.0.0` ships this advice reverses.** A caret range is then the right thing, because a breaking change has to announce itself as a new major version and the range refuses it for you. That is the protection an exact pin is standing in for today.
>
> For mechanical migrations across releases:
>
> ```bash
> npx @llm-ports/migrate@alpha alpha-19-to-alpha-20 --write
> ```

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
| Vercel AI SDK adapter (migration-friendly, multi-turn agent + multimodal + bundled pricing) | offline + contract |
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
| Gemini `generateStructured` uses prompted JSON, not native `responseSchema`; `runAgent` is single-turn | (rolled-up from alpha.5 release notes) | alpha.9 (both; the adapter's own file header went on claiming otherwise until alpha.35) |
| `claude-opus-4-7` rejects `temperature` in streaming methods (catalog only covered 4-5) | BEPA TD-LLMPORTS-OPUS-4-7 | alpha.10 (`/^claude-(opus\|sonnet)-4-\d/`) |
| `generateStructured` overwrites `usage` across retry-with-feedback attempts instead of accumulating | BEPA TD-LLMPORTS-VALIDATION-ATTEMPTS | alpha.11 (mergeTokenUsage across all 5 adapters) |
| `reasoning_effort` parameter not exposed; Groq `gpt-oss-120b` can't reach `"high"` effort | BEPA TD-LLMPORTS-REASONING-EFFORT | alpha.12 (per-call option on all 5 `*Options`) |
| Capability factories drop `reasoningEffort` (and `signal` / `forceProviderAlias`) — never propagated to underlying port call | BEPA TD-LLMPORTS-CAPABILITIES-REASONING-EFFORT | alpha.13 (all 7 factories) |
| `useStrictResponseFormat` only auto-detected for Cerebras — OpenAI native + Groq users silently paid the un-strict tax (broken-by-default for nested schemas) | BEPA TD-APPLICATIONS-SCORING-SCHEMA-STRICT-MULTIPROVIDER | alpha.14 (auto-detect expanded to OpenAI native + `api.openai.com` + `api.groq.com`) |
| SambaNova MiniMax-M2.7 fails 0/10 on nested schemas with default settings; strict-mode behavior was undocumented | BEPA TD-APPLICATIONS-SCORING-SCHEMA-STRICT-MULTIPROVIDER sub-task 3 | alpha.15 (empirical probe confirmed strict mode works → `api.sambanova.ai` added to auto-detect) |
| Provider-specific request knobs (vLLM `chat_template_kwargs` for Qwen3 `enable_thinking` and DeepSeek `thinking`, SGLang `regex` / `ebnf`, vLLM `guided_json` / `guided_grammar`, Together `repetition_penalty`, etc.) had no typed escape hatch on the port; users dropped to direct port calls with `as unknown as` casts | (alpha.16 design ticket; addresses frontier-OSS-via-vLLM gap) | alpha.16 (`providerExtras?: Record<string, unknown>` on every `*Options` interface, shallow-merged AFTER typed fields; threaded through all 7 capability factories; vLLM + SGLang worked examples in adapter docs) |
| Rerank is a distinct computational primitive from chat completion (Cohere Rerank-3, Voyage AI rerank-2, Jina, Mixedbread all ship dedicated rerank APIs not chat-shaped); had no port; consumers either rolled their own or used LLM-as-reranker at ~100× the cost of dedicated rerank models | (alpha.17 design ticket; closes BEPA-ecosystem retrieval gap across Graphiti, RLM, Dramma, real_estate_planner) | alpha.17 (`RerankPort` skeleton in `@llm-ports/core/src/ports/rerank-port.ts` with locked signature: `query`, `documents`, `topN`, `signal`, `providerExtras`; `TokenUsage` extended with `searchUnits` + `rerankedDocuments`; first adapter implementation lands in beta.0 with `@llm-ports/adapter-cohere`) |
| Retry-loop backoff config was inconsistent across adapters; no shared `BackoffConfig` type or canonical `computeBackoffDelay` helper; consumers had to consume adapter-specific options for jitter strategy and delay shape | (alpha.17 design ticket; matches Genkit's middleware retry config) | alpha.17 (`BackoffConfig` + `JitterStrategy` types + pure-function `computeBackoffDelay(attempt, config, prevDelay, rng)` in `@llm-ports/core`; four strategies: `none` / `full` / `equal` / `decorrelated`; default `decorrelated` per AWS Architecture Blog 2015) |
| `onRetry` observability hook was wired in `adapter-openai` and `adapter-vercel` but missing in `adapter-google` and `adapter-ollama`; consumers couldn't pipe validation-feedback retries from those adapters into Langfuse/Phoenix/OpenLLMetry uniformly | (alpha.17 parity item; closes A01 CLAUDE.md "onRetry plumbing currently inconsistent") | alpha.17 (`onRetry?: OnRetry` option added to `GoogleAdapterOptions` and `OllamaAdapterOptions`; `emitRetryEvent` fired at the validation-feedback retry site in both adapters with `reason: "validation-feedback"`) |
| Typed-error taxonomy was incomplete: 400-class errors (context-window overflow, content-policy violation) were wrapped as `ProviderUnavailableError`, causing fallback-to-next-provider on errors that would fail the same way; 401/403 and 429 errors lost their distinct semantics; `Retry-After` header data was discarded; no common base class for blanket `instanceof` checks | (alpha.18 design ticket; LiteLLM's 11-class taxonomy is the field consensus) | alpha.18 (new `LLMPortError` base class; `BadRequestError` root with `ContextWindowExceededError` + `ContentPolicyViolationError` subclasses; `AuthenticationError` for 401/403; `RateLimitError` with parsed `retryAfterMs`; `ServiceUnavailableError` root with `ProviderUnavailableError` + `EmptyResponseError` reparented under it; `wrapProviderError` classifies SDK errors by HTTP status; `errorMatchers` helper exposes `.rateLimit` / `.transient` / `.default` / `.all` predicates). **BREAKING**: `ContextWindowExceededError` no longer matches `instanceof ProviderUnavailableError`; 5xx errors map to `ServiceUnavailableError` (the typed base), not `ProviderUnavailableError`. |
| Prompt-cache control had no provider-neutral surface: Anthropic users dropped to `providerExtras` to set `cache_control` markers; OpenAI users had no way to influence the implicit cache namespace; Gemini users had no port-side path to use a `createCachedContent` handle. The result field `cost.cacheDiscountUSD` implied a vendor-applied discount when the value is actually the caller-visible reduction in their bill. | (alpha.19 design ticket; closes 3-way provider divergence so beta.0 ships the right shape over Anthropic explicit, OpenAI implicit, Gemini handle) | alpha.19 (new `CacheControl` type in `@llm-ports/core` with 4 modes: `auto` / `manual` / `preCreated` / `off`, plus `ttlSeconds` / `breakpoints` / `cachedContentHandle` / `namespace`; threaded through all 5 request option types). **BREAKING**: `cost.cacheDiscountUSD` renamed to `cost.cacheSavingsUSD` (aligns with OpenInference `llm.cost.cache_savings` and Helicone dashboard vocabulary). See `docs/migration/alpha-18-to-alpha-19.md`. |
| CacheControl shape was committed in alpha.19 but adapters did NOT act on the field at runtime — the type was plumbed, the docs claimed per-mode behavior, the implementation was a no-op. Anthropic users still needed `providerExtras`; Gemini's `cachedContentHandle` flow did not reach the SDK; capability factories silently dropped the field. | (alpha.19.1 close-out; surfaced same-day by Babak: "have you made cache enabled on all the capabilities and providers by default?") | alpha.19.1 (adapter-anthropic translates the typed `CacheControl` into `cache_control: { type: "ephemeral", ttl? }` markers across all 5 SDK call sites for `mode: "auto"` / `"manual"`; `mode: "off"` and `"preCreated"` are explicit no-ops; `ttlSeconds: 3600` emits `ttl: "1h"`. adapter-google wires `mode: "preCreated"` with `cachedContentHandle` to `config.cachedContent`. adapter-openai / -ollama / -vercel are deliberate no-ops on every mode (documented in `docs/concepts/cache.md`). All 7 capability factories thread `cacheControl?` to the underlying port call; `CapabilityEvent.cost.cacheSavingsUSD` propagates on `onResult`. 654 tests passing across 7 packages, +28 new). |

### Medium-impact (still open in v0.1)

No medium-impact items are currently open. New ones will land here as users report them.

### Lower-impact (real but rarely surfaced)

| Limitation | Surface | Notes |
|---|---|---|
| First call to an unknown reasoning model pays one wasted round-trip | OpenAI adapter | The adapter's per-process cache learns the constraint after the first starved attempt. alpha.5 added a static `KNOWN_REASONING_MODELS` catalog covering o-series / gpt-5-nano / Cerebras gpt-oss / Clarifai Qwen3.6 / SambaNova MiniMax-M2.7, so the wasted round-trip is skipped for those. For other reasoning models, supply `pricingOverrides[modelId].capabilities.reasoningModel = true`. |
| Compat-provider live coverage is one-test-deep (basic `generateText` only) | OpenAI adapter via `baseURL` (Cerebras, Groq, Together AI, Fireworks, Clarifai, SambaNova, etc.) | Structured / streaming / agent / embeddings are not regression-tested for compat providers in v0.1. alpha.9 added `useStrictResponseFormat` to fix the Cerebras silent-ignore-`json_object` case. Broader test coverage targeted for v0.2. |
| `adapter-ollama` honors `AbortSignal` at entry but cannot cancel an in-flight request | Ollama adapter | `ollama-js` v0.5 doesn't expose a per-call signal. Coarse `client.abort()` cancels all in-flight, too blunt. Lands when ollama-js v0.7+ exposes per-call signal. |
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

## Reconciliation: what was announced against what shipped

Four themed releases were announced in `docs/migration/alpha-26-to-alpha-27.md` on 2026-07-17, each with a planning discussion enumerating its items. Scored against source on 2026-08-21:

| Release | Theme | Items announced | Shipped |
|---|---|---|---|
| alpha.28 | Reliability + observability polish | 16 | 4, plus 2 partial |
| alpha.29 | Capability factory ergonomics | 11 | **0** |
| alpha.30 | Persistent backends + caching | 2 (+1 bonus) | **0** |
| alpha.31 | Local runtime + orchestration | 3 | **0** |

**32 items announced. 4 shipped, 2 partial, 26 not shipped.** Per-item scoring for alpha.28 is in `plans/alpha.28-reliability-observability-polish.md`; the other three slates live in planning discussions #65, #66, and #67 and are summarized in the sequence below.

## What ships next

The plan below is the public form of the maintainers' sequence. It replaces a longer forward-looking section that had drifted: it still described a two-release path to beta that has since been merged into one, and named an `alpha.35` and `alpha.36` whose contents have changed.

**The destination is `1.0.0`, and it is close.** Not because every idea is built, but because the shapes a consumer builds against are ready to stop moving. Below version 1 there is no way to say "this release breaks you" that a dependency range can act on; above it, a breaking change announces itself as a major version and a consumer's range refuses it automatically. That protection is the whole reason for the number.

### `0.1.0-alpha.35`, in flight

Contract corrections, a missing method, and the close-out of the observability work. The largest release in the sequence, and the last one numbered `0.1.0-alpha`.

The corrections are the load-bearing part: streamed calls through OpenAI-compatible providers were losing their token usage, so cost totals under-counted for those providers; a conversation whose system messages are not adjacent threw on two adapters instead of collapsing them; and every adapter now surfaces a validation failure the same way, pinned by a contract test rather than by convention.

New in the same release: `generateChat`, which returns the assistant's turn with any tool calls surfaced and not executed, for callers who want the loop themselves; structured output from a JSON Schema rather than only a Zod schema; dollar cost on OpenTelemetry spans; a once-per-call completion hook; a bounded record of recent retries; and an unexplained provider 400 learned once rather than rediscovered on every call.

### `1.0.0-rc.36`: one release candidate, carrying every remaining break

Everything that changes an existing shape travels together, so it can be baked once rather than trickled out:

- A total spend ceiling per budget scope, with shared storage behind it, designed so that replacing a registry's configuration no longer resets spend counters.
- Login state that works across processes, which turns the current synchronous interface asynchronous.
- Removal of a setting that exists only to serve our own tests.
- **One model record carrying both what a model can do and what it costs**, supplied as data. Including the context window, which this library models nowhere today: a prompt being too long is currently discovered only when a provider rejects it.
- The Vercel adapter verified, hardened and settled rather than held back.
- A Cohere adapter, the rerank port documented as consumer-implementable, and a reranker capability.
- Tool schemas converted per attempt, never hoisted above failover.

Also carried: the migration pages owed for `alpha.31` and `alpha.32`, test depth against compatible providers beyond the single call currently covered, and the withdrawals below stated where they were announced.

**What gates the candidate:** a migration page covering every break it carries, a live sweep across the adapters against real APIs, and sign-off from an adopter running it against production.

### `1.0.0`: settled

All twelve published packages settle at `1.0.0` together, and the shared version number retires there. From that point each package moves on its own, which is what lets a fix to one adapter stop being a version bump for eleven packages that did not change.

An earlier plan tiered the packages, calling seven settled and five still moving. That is not expressible at version 1: below it, "still moving" means "we may break you without warning", and that is not a promise worth keeping for anything published. The five thinner packages get the same protection as the rest.

### `1.1.0` and beyond

Additive work, highest signal first, in a line where adding is safe and breaking announces itself. The `1.2.0` and later material is listed under the roadmap sections below.

### Withdrawn, and why

Stated rather than quietly dropped, since each was announced publicly.

- **The three local-runtime items**: a Transformers.js adapter, a Tesseract.js adapter, and the step-chaining primitive. Withdrawn **with an open mind kept deliberately**: if a later design can serve them without dragging non-model engines into a port built for language models, they return. The reason is worth publishing either way, because the only consumer who asked shipped its own answer and recorded that an OCR engine cannot produce the structured output this port's contract assumes.
- **`@llm-ports/express`**: a whole package for one convenience helper.
- **Named sessions as specified**, because they collide with the standing position that conversation state belongs to the application.

**And that standing position is deliberately reopened.** The question asked is whether conversation history could be offered as an **optional** feature rather than excluded: today every consumer holds the transcript and passes it on each call, and the alternative is that the library can hold it for those who want that while holding nothing by default. Design questions for the `1.1.0` window, recorded rather than answered.

The `pricing: "free"` sentinel was on this withdrawal list in error and has been taken off it. **It shipped in `alpha.34`** and is documented in the cost-gating and custom-adapter guides. It was listed because the withdrawal was proposed before the release that delivered it, and nothing reconciled the two.

## The additive roadmap, after `1.0.0`

A work queue rather than a set of promises, and the order is approximate: what ships first is whatever has the clearest need. **This was written as "what v0.2 adds" and the version names no longer apply**, since the line after `1.0.0` is `1.1.0`. Three rows have been removed because they shipped: multi-turn agent support in the Vercel adapter (`alpha.8`), registry runtime fallback with a chain walk (`alpha.34`), and typed empty-response handling.

| Surface | What ships |
|---|---|
| Test depth against compatible providers | Structured output, streaming, agent and embedding tests against Cerebras, Groq, Together and Fireworks, rather than the single call covered today. Moved forward into the release candidate. |
| `createAgent` capability factory | The same configure-once ergonomics the seven existing factories have, bundling the approval-gate wrapper and the tool plumbing. Calling `runAgent` directly keeps working. |
| `@llm-ports/observability` | Quality-tracking hooks, sinks and deterministic edit-diff helpers: the parts of a consumer that learn from production traffic, extracted so they are opt-in. |
| More capabilities | `redact`, `route`, `decide`, `answer` and `rerank`, prioritized by the [capability-request issues](https://github.com/baabakk/llm-ports/issues?q=is%3Aissue+is%3Aopen+label%3Acapability). The reranker arrives earlier, alongside the Cohere adapter in the release candidate. |
| Conversation history, if it is offered | Optional, holding nothing by default. See the reopened question above. |

---

## Further out

Subject to change based on what adopters actually ask for.

- `@llm-ports/adapter-transformers-web` or `@llm-ports/adapter-onnxruntime-web` for browser-native local-model inference (transformers.js, onnxruntime-web). Tracked as [#13](https://github.com/baabakk/llm-ports/issues/13). Use cases: SmolDocling, PaddleOCR-VL, SmolVLM running entirely in the browser. Note that this is a different item from the withdrawn Node-side local-runtime adapters above, and the two were previously conflated in a withdrawal proposal: this one is browser-native and still on the roadmap.
- `@llm-ports/adapter-mistral` if the Mistral API stops fitting under the OpenAI compat shape.
- A portable skill / capability format (Markdown-with-YAML-frontmatter) — being evaluated; not a commitment.
- Native streaming for `runAgent` (currently you can stream tool-use steps via the lower-level adapter, but not from the agent loop).

---

## How to track new limitations

If you hit something not on this page, please [open a bug report](https://github.com/baabakk/llm-ports/issues/new?template=bug_report.yml). The template captures the version + repro shape needed to triage. New known-limitation items get the `known-limitation` label and land on this page within a few days.

For open-ended discussion (design feedback, "is this how I should do X?", show-and-tell), [GitHub Discussions](https://github.com/baabakk/llm-ports/discussions) is the better surface than an issue.
