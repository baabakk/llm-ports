---
"@llm-ports/adapter-openai": patch
---

Add `KNOWN_REASONING_MODELS` static catalog. Pre-seeds the capability learner at port creation so the first call against well-known reasoning models skips the starvation-retry round-trip.

Catalog covers:
- OpenAI o-series (`o1*`, `o3*`, `o4*`)
- OpenAI `gpt-5-nano*`
- Cerebras `gpt-oss-*` (via `baseURL=https://api.cerebras.ai/v1`)
- Clarifai `Qwen3_6-*` (via `baseURL=https://api.clarifai.com/v2/ext/openai/v1`); canonical ID `Qwen3_6-35B-A3B-FP8`
- SambaNova `MiniMax-M2.7` (via `baseURL=https://api.sambanova.ai/v1`)

Runtime learning still catches unknown reasoning models on first call; the catalog only saves the first-call round-trip for known ones. User-supplied `pricingOverrides[modelId].capabilities.reasoningModel` still overrides the catalog.

The compat-providers table in `docs/adapters/openai.md` now lists Clarifai and SambaNova alongside Groq, Together, Fireworks, etc., with worked-example configs and concrete pricing:

- Clarifai Qwen3.6 35B A3B FP8: $0.76 input / $0.43 output per 1M; 262k context (output cheaper than input — FP8 quantization quirk)
- SambaNova MiniMax-M2.7: $0.60 input / $2.40 output per 1M; 197k context

Exports added: `KNOWN_REASONING_MODELS` from `@llm-ports/adapter-openai` (read-only catalog). Public API otherwise unchanged.
