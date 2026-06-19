---
"@llm-ports/adapter-openai": minor
---

Reasoning-model architecture cleanup: model-ID normalization + runtime detection broadening. Both changes are additive (no breaking changes); together they make the catalog stop needing per-(model × provider) regex variants and let runtime detection catch provider-specific response shapes the previous narrow assumptions missed.

## Why this exists (one-paragraph backstory)

ADW's 2026-06-19 instrumentation of the multi-team agentic build loop discovered that DeepInfra-hosted `gpt-oss-120b` was silently failing as a reasoning model in alpha.21. Two root causes:

1. The catalog pattern `/^gpt-oss-/i` is anchored at `^` and can't match the namespaced model ID `openai/gpt-oss-120b` (DeepInfra prefixes provider/owner). The model isn't recognized as reasoning → budget multiplier isn't applied → first call starves on hidden chain-of-thought.
2. Runtime detection requires `finish_reason === "length"` and looks at `message.reasoning` only. DeepInfra's gpt-oss serving returns `finish_reason: "stop"` and exposes the harmony channel as `message.reasoning_content` (different field name). Both safety nets miss the failure.

The fix isn't another regex — that's catalog-debt-by-another-name. The fix is architectural: normalize model IDs to canonical names before catalog/learner lookup, and broaden runtime detection to handle the response-shape variance.

## What changed

### 1. Model-ID normalization

New `normalizeModelId(modelId)` helper in `capabilities.ts`: strips a provider/namespace prefix, returning the canonical name (the substring after the last `/`). Model IDs without `/` pass through unchanged.

Examples:
- `gpt-oss-120b` → `gpt-oss-120b` (OpenAI-native; unchanged)
- `openai/gpt-oss-120b` → `gpt-oss-120b` (DeepInfra/Groq form)
- `deepseek-ai/DeepSeek-V4-Flash` → `DeepSeek-V4-Flash`
- `XiaomiMiMo/MiMo-V2.5` → `MiMo-V2.5` (Parasail form)
- `google/gemma-4-31B-it` → `gemma-4-31B-it`

Every internal call to the capability learner (`seedKnownConstraints`, `getEffectiveCapabilities`, `rememberConstraint`) normalizes the model ID first. The catalog's anchored patterns (`/^gpt-oss-/i`, `/^qwen3[._-]?6/i`, `/^minimax[-_]?m2[._]7/i`, etc.) now correctly match the canonical name regardless of which provider serves it.

The raw model ID is still used in SDK request bodies — DeepInfra expects `openai/gpt-oss-120b`, not `gpt-oss-120b`. Normalization is scoped to the capability-learning layer only.

**Architectural payoff:** the same canonical model served by two providers (Cerebras `gpt-oss-120b` and DeepInfra `openai/gpt-oss-120b`) now shares learned state. A constraint learned at runtime for one is visible to the other.

### 2. Broadened runtime reasoning detection

`learnFromResponse` now reads three reasoning signals (was two):
- `usage.completion_tokens_details.reasoning_tokens > 0` (existing — OpenAI o-series, gpt-5-nano)
- `choices[0].message.reasoning` populated (existing — Cerebras gpt-oss-*)
- `choices[0].message.reasoning_content` populated (NEW — DeepInfra harmony serving)

`reasoningStarvedResponse` relaxes the `finish_reason` guard:
- Pre-alpha.22: required `finish_reason === "length"` (OpenAI native + Cerebras pattern)
- Post-alpha.22: accepts `length` OR `stop` (DeepInfra's gpt-oss harmony returns `stop`)

The starvation discriminator is now "empty visible output (no content, no executable tool_calls) AND any reasoning signal AND finish was either length or stop." This catches the empirical DeepInfra-gpt-oss pattern without false-positiving on models that legitimately finish with stop.

`reasoningStarvedResponse` also now checks `message.tool_calls`: if the model emitted executable tool calls, the response is NOT starved (even if `content` is empty), regardless of reasoning signal. Genuine tool-use successes are not retried.

## What this DOES NOT do

The DeepInfra-served gpt-oss tool-use case is not fully fixed by this release. Even with the budget correct and starvation observable, the tool-call intent lands in `message.reasoning_content` rather than `message.tool_calls`. Until the adapter parses the harmony channel for tool calls (a separate research-first workstream), `runAgent` against DeepInfra-served gpt-oss still won't execute the model's intended tool calls. **For tool-use workloads against gpt-oss, route to Cerebras.** This will be addressed in a future release after harmony-format research; tracked in a follow-up issue.

## Backwards compatibility

All changes are additive at the call-site level. The normalized-vs-raw model ID distinction is internal to the capability-learning layer; SDK requests continue to use raw IDs. Existing tests against OpenAI-native and Cerebras-served model IDs pass unchanged (197 adapter-openai tests, 0 regressions).

## Tests

22 new tests:
- 15 model-ID normalization tests (including namespace stripping for each provider variant, catalog matching with normalized IDs, shared learner state across canonical-equivalent IDs, user-supplied capability precedence)
- 7 runtime detection broadened tests (DeepInfra harmony shape recognition, finish=stop rescue, OpenAI o-series regression, no-spurious-rescue regressions)

Plus a new mock-SDK helper `buildDeepInfraHarmonyResponse` that mirrors ADW's empirically-captured DeepInfra gpt-oss response shape.

## Empirical motivation

- ADW Development_Logs.md commit b1eeee2 — code-grounded root cause of the deepseek + gpt-oss DeepInfra tool-loop failures
- Raw 2-turn DeepInfra probe (2026-06-19): `finish: "stop"`, `content: ""`, `tool_calls: []`, `reasoning_content: "{\"path\":\"\",\"depth\":3}\n"`
- See llm-ports#46 / discussion #49 for the architectural critique that drove the design
