# v0.1 status

A single canonical inventory of what's stable in `llm-ports` v0.1, what's still being hardened, and what's deferred to v0.2. Other docs pages link here when a caveat is in play; this page is the authoritative source.

This is the page to share when someone asks "what works in alpha?" or "what should I expect to break?"

---

## What's stable in v0.1

These are load-bearing today, with comprehensive test coverage. Not "experimental"; not "planned." If you build on these, the contract will not change without a deprecation cycle.

| Surface | Coverage |
|---|---|
| `LLMPort` interface (5 methods) | 211 offline tests + cross-adapter contract suite |
| `EmbeddingsPort` interface | covered by OpenAI + Ollama live tests; mocked-SDK regression tests |
| `Registry` with task-route walking + `selectModel` budget gating | offline registry tests in core, plus end-to-end via examples |
| USD cost gating (per-hour / per-day / per-month) | offline + Phase 2 live verification; precision verified at 10 decimals |
| Anthropic adapter (full feature set: prompt caching, vision, tool use) | full live + contract suites |
| OpenAI adapter (chat + embeddings + 10 compat providers via `baseURL`) | full live + contract; runtime capability discovery; reasoning-model auto-handling; transient-401 burst-protection retry |
| Ollama adapter (chat + embeddings + model management) | offline + Phase 2 live |
| Capability factories (`createClassifier`, `createScorer`, `createDrafter`, `createSummarizer`, `createExtractor`, `createPlanner`, `createAnalyzer`) | offline + Phase 3 live (via Cerebras/Anthropic) |
| Validation strategies (`throw`, `retry-with-feedback`, `fallback-to-next-provider`, `custom`) | offline tests + Phase 2 live exercise |
| `ContentBlock[]` discriminated union (text, image, audio, tool_use, tool_result) | offline tests across adapters |
| Latency overhead | mean p50 0.04 ms, max p99 0.47 ms (10× under the 5 ms target) |

The Anthropic + OpenAI + Ollama adapters and the capability factories are the BEPA-extracted core, in production at BEPA for 5+ months across millions of LLM calls.

---

## Known limitations in v0.1

These are tracked publicly. Each row links to the GitHub issue with the full reproduction, workaround, and resolution path. Filter on the [`known-limitation` label](https://github.com/baabakk/llm-ports/issues?q=is%3Aissue+is%3Aopen+label%3Aknown-limitation) for the live list.

### Medium-impact (you'll hit them in normal use)

| Limitation | Surface | Workaround | Tracked at |
|---|---|---|---|
| `runAgent` tool input schemas pass as `{}` to the model — Zod field types are dropped during conversion | OpenAI + Anthropic adapters | Name parameters explicitly in the tool's `description` string. The Zod schema still validates `execute`'s input at runtime. | [#1](https://github.com/baabakk/llm-ports/issues/1) |
| No `onRetry` observability hook — capability rejections, transient 401s, and reasoning-starved retries are silent | OpenAI adapter primarily | Use capability `onResult` to detect retries indirectly via latency / `validationAttempts`. | [#3](https://github.com/baabakk/llm-ports/issues/3) |
| Vercel adapter does not apply the reasoning-model headroom multiplier the OpenAI adapter does | Vercel adapter, with `gpt-5-nano` / o-series / Cerebras `gpt-oss-120b` | Set `maxOutputTokens` 5-10× higher than your visible-output budget, or use `@llm-ports/adapter-openai` directly for reasoning models. | [#4](https://github.com/baabakk/llm-ports/issues/4) |
| Vercel adapter `generateStructured` throws `SyntaxError: Unexpected end of JSON input` on empty model responses (root cause: same as previous row) | Vercel adapter | Same as previous row. v0.2 ships an `EmptyResponseError` class for this case. | [#5](https://github.com/baabakk/llm-ports/issues/5) |

### Lower-impact (real but rarely surfaced)

| Limitation | Surface | Notes |
|---|---|---|
| Registry walks the chain on **budget gating** but does not retry the next provider on **runtime errors** (network 5xx, 429, etc.) | Registry behavior | The `LLM_TASK_ROUTE_X=fast,backup` chain switches when `fast` is over its USD/request budget. If `fast` returns a 5xx mid-call, the call fails — it doesn't auto-retry on `backup`. Catch `ProviderUnavailableError` in your call site for the v0.1 path. |
| First call to an unknown reasoning model in a fresh process pays one wasted round-trip | OpenAI adapter | The adapter's per-process cache learns the constraint after the first starved attempt. To skip the discovery round-trip, set `pricingOverrides[modelId].capabilities.reasoningModel = true` for known reasoning models. |
| Compat-provider live coverage is one-test-deep (basic `generateText` only) | OpenAI adapter via `baseURL` (Cerebras, Groq, Together AI, Fireworks, etc.) | Structured-output / streaming / agent / embeddings are not regression-tested for compat providers in v0.1. A compat-provider regression in `message.reasoning` parsing wouldn't be caught by the current live suite. |
| Vercel adapter's `runAgent` is single-turn only | Vercel adapter | Multi-step tool use through Vercel's own agent loop ships in v0.2. For multi-turn agents today, prefer the direct OpenAI / Anthropic / Ollama adapters. |
| Vercel adapter multimodal inputs pass as `[image content]` placeholder strings | Vercel adapter | Image and audio content blocks downgrade to text. Direct adapters support full multimodal. |
| Vercel adapter has no bundled pricing table | Vercel adapter | Bring your own `pricing` map at `createVercelAdapter({ pricing: { ... } })`. The OpenAI / Anthropic / Ollama adapters ship pricing tables. |
| Some compat-provider models require a `pricingOverrides` entry | Registry pricing-validation | Cerebras `gpt-oss-120b`, Groq's Llama variants, etc. need an explicit pricing override before the registry will admit them. |

---

## What v0.2 adds

Roadmap target — not promises, but the work queue. Order is approximate; what ships first is whatever has clearest user need.

| Surface | What ships |
|---|---|
| `runAgent` tool schemas | Full Zod-to-JSON-Schema conversion via `zod-to-json-schema` for OpenAI + Anthropic adapters. Closes #1. |
| Adapter observability | `onRetry` hook on adapter options. Closes #3. |
| Vercel adapter feature parity | Reasoning-model handling (closes #4) + `EmptyResponseError` class (closes #5) + multi-turn `runAgent`. |
| Registry runtime fallback | Retry-on-`ProviderUnavailableError` with chain walk. Catch-class configurable. |
| Compat-provider test depth | Structured / streaming / agent / embeddings live tests across Cerebras, Groq, Together, Fireworks. |
| `createAgent` capability factory | Higher-level ergonomics matching `createClassifier` / `createDrafter`. Bundles `wrapWithApprovalGate` + tool/message plumbing into one configure-once factory. The v0.1 path (`runAgent` directly) keeps working. |
| `@llm-ports/observability` | Quality tracking hooks, sinks, deterministic edit-diff helpers. The pieces of BEPA that learn from production traffic, extracted into a separate package so users opt in. |
| Expanded capabilities | Targeted: `redact`, `route`, `decide`, `answer`, `rerank`. Prioritized by user requests in the [capability-request issues](https://github.com/baabakk/llm-ports/issues?q=is%3Aissue+is%3Aopen+label%3Acapability). |

---

## What v0.3+ adds

Further out. Subject to change based on v0.1 + v0.2 user signal.

- `@llm-ports/adapter-google` for Gemini (different API shape than OpenAI/Anthropic; handled separately)
- `@llm-ports/adapter-mistral` if the Mistral API stops fitting under the OpenAI compat shape
- A portable skill / capability format (Markdown-with-YAML-frontmatter) — being evaluated; not a commitment
- Native streaming for `runAgent` (currently you can stream tool-use steps via the lower-level adapter, but not from the agent loop)

---

## How to track new limitations

If you hit something not on this page, please [open a bug report](https://github.com/baabakk/llm-ports/issues/new?template=bug_report.yml). The template captures the version + repro shape needed to triage. New known-limitation items get the `known-limitation` label and land on this page within a few days.

For open-ended discussion (design feedback, "is this how I should do X?", show-and-tell), [GitHub Discussions](https://github.com/baabakk/llm-ports/discussions) is the better surface than an issue.
