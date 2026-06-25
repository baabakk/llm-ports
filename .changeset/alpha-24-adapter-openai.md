---
"@llm-ports/adapter-openai": minor
---

Catalog architectural redesign + Cerebras pricing. The catalog stops being load-bearing for correctness.

## Behavioral fingerprinting (the architectural fix)

`createOpenAIAdapter({ fingerprintCache })` — opt-in cross-process cache that skips the first-call discovery penalty for reasoning models without static catalog entries. Bundled backends:

- `InMemoryFingerprintCache` — Map; lifetime is the current process
- `FileFingerprintCache(path)` — atomic JSON file; survives restarts
- Bring-your-own backend (Redis, S3, KV) via the `FingerprintCacheBackend` interface

Every successful response is inspected for reasoning signals and written to the cache for free. On port creation for a known model, the cache is read and the learner is seeded. The four CoT field conventions from the [June 2026 reasoning-model survey](https://github.com/baabakk/llm-ports/blob/main/docs/research/reasoning-models-survey-2026-06.md) are all caught:

- `usage.completion_tokens_details.reasoning_tokens` → OpenAI native
- `message.reasoning` → Cerebras, Groq, SambaNova
- `message.reasoning_content` → DeepInfra, Parasail (vLLM substrate)
- `<think>...</think>` inline in `content` → legacy R1 distills

Standalone helper `fingerprintModel(client, modelId)` for CI warm-starts.

## Catalog freeze policy

`KNOWN_REASONING_MODELS` docstring rewritten to make the optimization-only framing explicit. The catalog is now FROZEN — new reasoning models are caught by runtime detection (alpha.22, correctness) or the fingerprint cache (alpha.24, performance). PRs adding regex entries no longer accepted.

Existing entries (OpenAI o-series, gpt-5-nano, gpt-oss family, Qwen3.6, MiniMax-M2.7, MiMo-V) stay — they capture the stable production families with no false positives.

## Cerebras pricing entries

Two production models added to `OPENAI_PRICING`:

- `gpt-oss-120b`: $0.35 / $0.75 per 1M (HIGH confidence — primary docs)
- `zai-glm-4.7`: $2.25 / $2.75 per 1M (MEDIUM confidence — third-party only; Cerebras's model page redirects pricing to a generic page)

Cerebras's catalog has shrunk; the previous Qwen3-235B/32B, Llama-3.1/3.3, DeepSeek-R1-distill, Llama-4-Scout entries are 404 as of June 2026.

## Public API additions

```ts
export {
  buildFingerprintKey,
  fingerprintModel,
  FileFingerprintCache,
  InMemoryFingerprintCache,
  inspectResponseForFingerprint,
  normalizeModelId,             // promoted from internal
  parseHarmonyToolCalls,        // promoted from internal
  type FingerprintCacheBackend,
  type ModelFingerprint,
} from "@llm-ports/adapter-openai";
```

## Tests

- 25 new fingerprint tests (analyzer + 2 backends + adapter integration + error swallowing)
- 2 new Cerebras pricing tests
- 247 adapter-openai tests total (was 220; +27, 0 regressions)

## Backwards compatibility

All changes additive. When `fingerprintCache` is undefined (default), the adapter behaves identically to alpha.23. The catalog still pre-seeds the existing well-known cases.
