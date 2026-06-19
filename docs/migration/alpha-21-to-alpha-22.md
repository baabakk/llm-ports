# Migrating from alpha.21 to alpha.22

> **Zero breaking changes — runtime AND type-level.** alpha.22 is fully additive. Existing code compiles and runs without modification. Only two packages bumped: `@llm-ports/adapter-openai` and `@llm-ports/adapter-google`. `@llm-ports/core`, `@llm-ports/capabilities`, and the other adapters stay at `0.1.0-alpha.21`.

## Install

```bash
pnpm add @llm-ports/adapter-openai@alpha @llm-ports/adapter-google@alpha
```

## What was added

### 1. Reasoning-model architecture (adapter-openai)

Two improvements, both empirically motivated by ADW's 2026-06-19 finding that `openai/gpt-oss-120b` (DeepInfra's namespaced ID for gpt-oss-120b) wasn't being recognized as a reasoning model in alpha.21:

- **`normalizeModelId(modelId)` helper** exported from the adapter. Strips the `<owner>/` namespace prefix and returns the canonical name. Used internally at every capability-learner entry point so the static catalog matches against canonical names regardless of which provider serves the model.

- **Broadened runtime detection**:
  - `learnFromResponse` now also reads `message.reasoning_content` (DeepInfra's harmony serving field).
  - `reasoningStarvedResponse` accepts `finish_reason: "stop"` in addition to `"length"`.
  - Both paths guard against rescuing successful tool-use (response with `message.tool_calls` populated is never starved).

- **Xiaomi MiMo catalog entry** (`/^mimo[-_]?v\d/i`) — distinct from MiniMax. Added after ADW observed `XiaomiMiMo/MiMo-V2.5` starvation in production this morning.

**Behavior impact**: providers that pre-alpha.22 saw a wasted first call against a namespaced reasoning model now get the budget multiplier on call 1. The DeepInfra `finish=stop` starvation pattern is now detected and triggers the rescue retry. **No code changes required to consume these improvements** — they kick in automatically.

### 2. `httpOptions` pass-through on `createGoogleAdapter`

`GoogleAdapterOptions` gains an optional `httpOptions` field forwarded verbatim to the `@google/genai` `GoogleGenAI` constructor:

```ts
import { createGoogleAdapter, type HttpOptions } from "@llm-ports/adapter-google";

const adapter = createGoogleAdapter({
  apiKey: process.env.YOUR_BACKEND_BEARER!,
  httpOptions: {
    baseUrl: "https://your-app.example/api/llm/google",
    apiVersion: "v1beta",
    headers: { "X-Custom-Tag": "production" },
    timeout: 30000,
  },
});
```

`HttpOptions` is re-exported from `@llm-ports/adapter-google` so you can type your override without adding `@google/genai` as a peer dep.

**When to use it**: backend-proxy architectures where the browser bundle should NOT hold the real `GEMINI_API_KEY`. The bundle Bearers a token your backend recognizes; the backend strips that, adds the real key, and forwards. See the [Dramma backend-proxy plan](https://github.com/baabakk/llm-ports/issues/46) for the motivating use case.

## What did NOT change

- `@llm-ports/core` exports — unchanged (alpha.21).
- `@llm-ports/capabilities` factories — unchanged (alpha.21).
- `@llm-ports/adapter-anthropic`, `@llm-ports/adapter-ollama`, `@llm-ports/adapter-vercel` — unchanged (alpha.21).
- All existing public types, options, hooks, contracts — unchanged.

## Should you do anything?

If you're upgrading from alpha.21 with no changes, nothing breaks. Pick from these on your own schedule:

| If you want… | Do this |
|---|---|
| Better reasoning-model handling on DeepInfra/Parasail/Groq | Just upgrade `@llm-ports/adapter-openai` — improvements are automatic |
| Cleaner backend-proxy architecture for Gemini | Upgrade `@llm-ports/adapter-google` and pass `httpOptions: { baseUrl: ... }` |
| Both | Upgrade both |

## What this release does NOT fix

DeepInfra-served gpt-oss tool-use still doesn't execute the model's tool-call intent end-to-end. With alpha.22 the budget is correct (multiplier applies on call 1), the starvation rescue fires (giving the model a second chance), but the tool-call intent often lands in `message.reasoning_content` rather than `message.tool_calls`. Parsing the harmony channel for tool calls is a separate research-first workstream.

**For tool-use workloads against gpt-oss, route to Cerebras (where the harmony channels are translated to standard `tool_calls` by the provider's serving layer).**

## Reference

- [Release notes](https://github.com/baabakk/llm-ports/releases/tag/v0.1.0-alpha.22) | [Discussion #50](https://github.com/baabakk/llm-ports/discussions/50)
- [ADW Development_Logs.md b1eeee2](https://github.com/baabakk/agentic_development_worker/commit/b1eeee2) — code-grounded root cause of the gpt-oss DeepInfra tool-loop failure
