# Reasoning-model survey — June 2026

This is a research artifact documenting the empirical state of reasoning models across the five OpenAI-compatible providers @llm-ports actively supports. It informs the alpha.24 catalog architectural redesign and the behavioral fingerprinting feature.

Generated 2026-06-24. Each claim cites a source URL; uncertain claims are flagged explicitly rather than guessed.

## Headline finding

**Three distinct CoT field conventions exist across the providers surveyed.** A static catalog approach that tries to map (model × provider) → response shape via regex is unsustainable maintenance. The behavioral fingerprinting approach shipped in alpha.24 catches all three at adapter construction time with a single probe per model.

| Convention | Providers | Field path |
|---|---|---|
| Cerebras-style | Cerebras, Groq, SambaNova | `choices[0].message.reasoning` (string) |
| vLLM-style | DeepInfra, Parasail | `choices[0].message.reasoning_content` (string) |
| Inline-tag | Some R1 distills | `<think>...</think>` embedded in `content` |

A fourth pattern — `usage.completion_tokens_details.reasoning_tokens` — is documented by OpenAI native but **not consistently populated by OpenAI-compat providers.** Most fold reasoning into `completion_tokens` without a breakdown.

## Critical adapter-side gotcha: round-trip incompatibility

**Cerebras and Groq emit `reasoning` outbound but REJECT it inbound on follow-up turns.** Sending an assistant message back with `reasoning` populated returns HTTP 400: `property 'messages.N.assistant.reasoning' is unsupported`. Clients must strip the field before replaying the conversation.

- [Cerebras docs](https://inference-docs.cerebras.ai/capabilities/reasoning) — outbound contract
- [vercel/ai issue #15042](https://github.com/vercel/ai/issues/15042) — Vercel AI SDK serializes as `reasoning_content` and gets rejected by Cerebras
- [gptel issue #774](https://github.com/karthink/gptel/issues/774) — same failure mode on Groq

**Implication for @llm-ports:** the adapter's `toOpenAIMessage` conversion (the inverse of `fromOpenAIAssistantMessage`) must strip both `reasoning` and `reasoning_content` from assistant messages before sending. Worth a defensive guard in alpha.24's adapter pass.

## Per-provider catalog

### DeepInfra

**Response shape:**
- Tool calls: standard OpenAI `tool_calls[]` array. Source: [docs.deepinfra.com/chat/tool-calling](https://docs.deepinfra.com/chat/tool-calling).
- CoT field: `message.reasoning_content` (vLLM convention; not authoritatively documented by DeepInfra but consistent with their vLLM substrate). Empirical evidence: the 2026-06-19 ADW probe showed `reasoning_content: '{"path":"","depth":3}\n'` on openai/gpt-oss-120b.
- `usage.completion_tokens_details.reasoning_tokens`: **not documented**; reasoning is folded into `completion_tokens` per [docs.deepinfra.com/chat/reasoning](https://docs.deepinfra.com/chat/reasoning).
- `finish_reason`: only `"stop"` documented in examples; `"tool_calls"` behavior not authoritative.

**Reasoning models (8 confirmed):**

| Model ID | Input $/1M | Output $/1M | Cached $/1M | Notes |
|---|---|---|---|---|
| `deepseek-ai/DeepSeek-R1-0528` | $0.50 | $2.15 | $0.35 | Only model explicitly named in DeepInfra reasoning docs |
| `openai/gpt-oss-120b` | $0.039 | $0.19 | — | `reasoning_effort` low/medium/high |
| `openai/gpt-oss-20b` | $0.03 | $0.14 | — | Same surface as 120b |
| `Qwen/Qwen3-Max-Thinking` | $1.20 | $6.00 | $0.24 | Explicit "Thinking" variant |
| `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning` | $0.20 | $0.80 | — | Slug literally `-Reasoning` |
| `deepseek-ai/DeepSeek-V4-Pro` | $1.30 | $2.60 | $0.10 | Hybrid: Non-think / Think High / Think Max via inline `<think>` tags |
| `deepseek-ai/DeepSeek-V4-Flash` | $0.10 | $0.20 | $0.02 | Same three-mode design |
| `microsoft/phi-4-reasoning-plus` | not verified | not verified | — | Pricing 404 at fetch time |

### Parasail

**Response shape:**
- Tool calls: standard OpenAI `tool_calls[]` array. Source: [docs.parasail.io/.../tool-function-calling](https://docs.parasail.io/parasail-docs/cookbooks/tool-function-calling).
- CoT field: `message.reasoning_content` (vLLM substrate). Confirmed via cross-provider convention; Parasail's own docs sparse but their substrate is [parasail-ai/vllm-public](https://github.com/parasail-ai/vllm-public).
- DeepSeek-style models use `<think>...</think>` inline as a fallback per [Parasail Model-Specific Parameters](https://docs.parasail.io/parasail-docs/serverless-and-models/model-specific-parameters).
- `usage.completion_tokens_details.reasoning_tokens`: not present (vLLM-flat usage shape).
- `finish_reason`: undocumented; expected OpenAI-standard values.

**Reasoning models (16-18 confirmed):**

| Model | Price (in/out per 1M) | Notes |
|---|---|---|
| `openai/gpt-oss-120b` | $0.10 / $0.75 | Also Fast variant: $0.15 / $0.60 |
| `openai/gpt-oss-20b` | $0.04 / $0.20 | |
| `XiaomiMiMo/MiMo-V2.5` | $0.14 / $0.28 | Already in alpha.21 catalog |
| `deepseek/deepseek-v4-pro` | $1.74 / $3.48 | |
| `deepseek/deepseek-v4-flash` | $0.14 / $0.28 | |
| `z-ai/glm-5.2` | $1.40 / $4.40 | |
| `z-ai/glm-5.1` | $1.40 / $4.40 | |
| `z-ai/glm-5` | $1.00 / $3.20 | |
| `moonshotai/kimi-k2.7-code` | $0.75 / $3.50 | "Always operates in thinking mode" |
| `moonshotai/kimi-k2.6` | $0.75 / $3.50 | |
| `minimax/minimax-m3` | $0.30 / $1.20 | |
| `minimax/minimax-m2.5` | $0.30 / $1.20 | |
| `qwen/qwen3.5-397b-a17b` | $0.50 / $3.60 | |
| `qwen/qwen3.6-35b-a3b` | $0.15 / $1.00 | |
| `google/gemma-4-31b-it` | $0.15 / $0.40 | Reasoning configurable |
| `google/gemma-4-26b-a4b-it` | $0.13 / $0.40 | |
| `allenai/olmo-3-32b-think` | — | Purpose-built reasoning |
| `Trinity Large (Thinking)` | $0.22 / $0.85 | |

### SambaNova

**Response shape:**
- Tool calls: standard OpenAI `tool_calls[]` on `/v1/chat/completions`. Source: [docs.sambanova.ai/.../function-calling](https://docs.sambanova.ai/docs/en/features/function-calling).
- CoT field: **`message.reasoning`** (NOT `reasoning_content`). Confirmed via [Gemma-4 community example](https://community.sambanova.ai/t/gemma-4-reasoning/1675).
- Separate `/v1/responses` endpoint uses Responses-API shape (reasoning as output array item).
- `usage.completion_tokens_details.reasoning_tokens`: not documented.

**Reasoning models (4 confirmed):**

| Model | Input $/1M | Output $/1M | Notes |
|---|---|---|---|
| `gpt-oss-120b` | $0.22 | $0.59 | `reasoning_effort` low/medium/high |
| `MiniMax-M2.7` | $0.60 | $2.40 | Already in alpha.21 catalog (`minimax-m2.7`) |
| `gemma-4-31B-it` | $0.38 | $1.15 | Toggleable via `<|think|>` token; preview |
| `DeepSeek-R1-Distill-Llama-70B` | $0.70 | $1.40 | On pricing page but absent from current models doc; legacy? |

### Cerebras

**Response shape:**
- Tool calls: standard OpenAI `tool_calls[]`. Source: [inference-docs.cerebras.ai/capabilities/tool-use](https://inference-docs.cerebras.ai/capabilities/tool-use).
- CoT field: **`message.reasoning`** under default `reasoning_format: "text_parsed"`. Streaming: `delta.reasoning`. Alternative formats `raw` / `hidden` / `none` control parsing.
- `finish_reason`: four documented values — `stop` / `length` / `tool_calls` / `content_filter`. Authoritative per [chat-completions reference](https://inference-docs.cerebras.ai/api-reference/chat-completions).
- `usage.completion_tokens_details.reasoning_tokens`: not documented.

**Known edge case:** gpt-oss-120b sometimes emits the function call on the *analysis* channel instead of *commentary*, in which case `tool_calls[]` is empty and harmony tokens leak into `content`. Source: [LangChain forum thread #2554](https://forum.langchain.com/t/harmony-response-format-sometimes-outputted-when-using-gpt-oss-120b-as-an-agent/2554). Defensive parser should detect this.

**Reasoning models (2 production):**

| Model | Input $/1M | Output $/1M | Confidence |
|---|---|---|---|
| `gpt-oss-120b` | **$0.35** | **$0.75** | HIGH (primary docs) |
| `zai-glm-4.7` | **$2.25** | **$2.75** | MEDIUM (third-party only; Cerebras hides per-token rates behind redirect) |

**Catalog shrinkage observation:** Cerebras's previous lineup (Qwen3-235B/32B, Llama-3.1/3.3, DeepSeek-R1-distill, Llama-4-Scout) is no longer in the public catalog as of June 2026. All return 404. Either retired or moved to enterprise-only.

### Groq

**Response shape:**
- Tool calls: standard OpenAI `tool_calls[]`. Source: [console.groq.com/docs/tool-use](https://console.groq.com/docs/tool-use).
- CoT field: **`message.reasoning`** (matches Cerebras convention). Confirmed: [Mozilla.ai cross-provider comparison](https://blog.mozilla.ai/standardized-reasoning-content-a-first-look-at-using-openais-gpt-oss-on-multiple-providers-using-any-llm/).
- Two distinct contracts per family:
  - **gpt-oss family**: `include_reasoning` (boolean) + `reasoning_effort` (low/medium/high). NO `reasoning_format`.
  - **Qwen family**: `reasoning_format` (parsed/raw/hidden) switches the shape.
- `finish_reason`: standard OpenAI values.
- `usage.completion_tokens_details.reasoning_tokens`: not documented/unreliable.

**Reasoning models:**

| Model | Input $/1M | Cached $/1M | Output $/1M |
|---|---|---|---|
| `openai/gpt-oss-120b` | $0.15 | $0.075 | $0.60 |
| `openai/gpt-oss-20b` | $0.075 | $0.0375 | $0.30 |
| `openai/gpt-oss-safeguard-20b` | $0.075 | $0.0375 | $0.30 |
| `qwen/qwen3-32b` | $0.29 | (50% off) | $0.59 |
| `qwen-3.6-27b` | $0.60 | (50% off) | $3.00 |

**Deprecated/missing:** `qwen-qwq-32b` and `deepseek-r1-distill-*` no longer on the public catalog as of June 2026.

## Cross-provider behavior caveats

### Field-name mismatch on round-trip

When echoing assistant messages back as conversation history:

- **Cerebras + Groq**: must strip `reasoning` (reject inbound)
- **DeepInfra + Parasail**: must strip `reasoning_content` (vLLM may accept it but inconsistent)
- **All providers**: strip both fields defensively

### Tool-use during reasoning

Some providers (Groq, Cerebras) document caveats:
- Groq's `reasoning_format: "raw"` is INCOMPATIBLE with JSON mode or tool use ([Groq docs](https://console.groq.com/docs/reasoning)).
- LiteLLM #15761 + LangChain #34155 report structured outputs + tool use is broken on Groq gpt-oss.
- Cerebras gpt-oss occasionally emits tool calls on the analysis channel (harmony leak); `tool_calls[]` becomes empty.

### Reasoning effort knobs

Not standardized across providers:

| Provider | gpt-oss knob | Qwen/Other knob |
|---|---|---|
| Cerebras | `reasoning_effort` low/medium/high | `reasoning_effort` + `clear_thinking` |
| Groq | `reasoning_effort` + `include_reasoning` | `reasoning_format` |
| DeepInfra | `reasoning_effort` or `reasoning: { effort, enabled }` | model-dependent |
| SambaNova | `reasoning_effort` | model-dependent |
| Parasail | `extra_body.chat_template_kwargs.thinking: true` (DeepSeek) | model-dependent |

Standardization across providers is unrealistic; @llm-ports passes `reasoningEffort` through to the underlying provider when supported and lets undocumented combinations error visibly rather than papering over.

## Implications for the alpha.24 architectural redesign

1. **Static catalog cannot scale.** ~30+ reasoning models across 5 providers, each with provider-specific response shapes, round-trip quirks, and effort knobs. Maintaining per-(model × provider) regex matches is not the answer.

2. **Behavioral fingerprinting catches all three shape conventions in one probe.** A small probe call ("what's 2+2") with `reasoning_effort: "low"` returns a response whose shape we can inspect: presence of `reasoning`, `reasoning_content`, or inline `<think>` markers. Cache the result per (provider × model) tuple keyed by `baseURL + modelId`.

3. **The catalog stays as the cheap shortcut for the universally-recognized cases.** OpenAI native o-series, gpt-5-nano are stable; the catalog correctly fast-paths them.

4. **Runtime detection (already shipped in alpha.22) is the universal correctness path.** First-call detection of `reasoning_content` (alpha.22) + `reasoning` (alpha.22) handles novel models. Fingerprinting just skips the first-call penalty.

5. **Defensive round-trip stripping** of `reasoning` and `reasoning_content` from outbound assistant messages should ship in alpha.24 alongside the architectural changes. Currently we don't strip, which means agentic loops against Cerebras can return 400 on turn 2+.

## Sources

Every entry in this artifact cites its source URL inline. Aggregate primary sources:

- **DeepInfra**: [docs.deepinfra.com](https://docs.deepinfra.com), [deepinfra.com/models](https://deepinfra.com/models)
- **Parasail**: [parasail.io/pricing](https://parasail.io/pricing), [docs.parasail.io](https://docs.parasail.io), [openrouter.ai/provider/parasail](https://openrouter.ai/provider/parasail)
- **SambaNova**: [cloud.sambanova.ai/plans/pricing](https://cloud.sambanova.ai/plans/pricing), [docs.sambanova.ai](https://docs.sambanova.ai), [community.sambanova.ai](https://community.sambanova.ai)
- **Cerebras**: [inference-docs.cerebras.ai](https://inference-docs.cerebras.ai), [cerebras.ai/pricing](https://www.cerebras.ai/pricing)
- **Groq**: [console.groq.com/docs](https://console.groq.com/docs), [groq.com/pricing](https://groq.com/pricing)

Cross-provider reference: [Artificial Analysis providers](https://artificialanalysis.ai/providers), [Mozilla.ai standardized reasoning content](https://blog.mozilla.ai/standardized-reasoning-content-a-first-look-at-using-openais-gpt-oss-on-multiple-providers-using-any-llm/).
