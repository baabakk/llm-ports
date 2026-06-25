# Capability detection — the three-tier architecture

This page documents how `@llm-ports/adapter-openai` decides whether a model is a reasoning model (and therefore needs a budget multiplier, harmony parsing, prose rescue, etc.). It's the architectural answer to the question: **how do we handle the explosion of (model × provider) variants without maintaining a static regex catalog forever?**

## Three tiers, ranked by responsibility

The detection mechanism has three layers. Each does one job. They compose cleanly.

```
┌───────────────────────────────────────────────────────────────┐
│ Tier 1 — Runtime detection (alpha.22+)                        │
│ The CORRECTNESS path. Universal. No maintenance.              │
│ Every successful response is inspected for reasoning signals. │
│ First-call discovery → learn → cache for this process.        │
└───────────────────────────────────────────────────────────────┘
                              ▲
                              │ falls through when uncached
┌─────────────────────────────┴─────────────────────────────────┐
│ Tier 2 — Behavioral fingerprint cache (alpha.24+)             │
│ The CROSS-PROCESS optimization. Opt-in.                       │
│ A user-supplied cache backend persists observed shapes by     │
│ (baseURL, modelId). Skips the first-call discovery penalty    │
│ on subsequent process starts.                                 │
└─────────────────────────────┬─────────────────────────────────┘
                              ▲
                              │ shortcut for known cases
┌─────────────────────────────┴─────────────────────────────────┐
│ Tier 3 — Static catalog (KNOWN_REASONING_MODELS, FROZEN)      │
│ The CHEAP SHORTCUT for the well-known cases. Zero work for    │
│ the common path. Closed to new entries — see freeze policy.   │
└───────────────────────────────────────────────────────────────┘
```

A model identified by ANY of the three tiers gets the reasoning treatment (budget multiplier, starvation rescue, harmony extraction). The tiers are AND-aggregated: Tier 3 hit OR Tier 2 hit OR Tier 1 hit → reasoning model.

## Tier 1 — Runtime detection (correctness)

On every successful chat-completion response, the adapter inspects four signals:

| Signal | Provider convention |
|---|---|
| `usage.completion_tokens_details.reasoning_tokens > 0` | OpenAI native (o-series, gpt-5-nano) |
| `choices[0].message.reasoning` populated | Cerebras, Groq, SambaNova |
| `choices[0].message.reasoning_content` populated | DeepInfra, Parasail (vLLM substrate) |
| `<think>...</think>` markers in `choices[0].message.content` | Legacy R1 distills emitted raw |

If any signal is present, the model is marked reasoning in the process-wide learner. Subsequent calls in the same process use the headroom multiplier up front — no wasted round-trip.

**Cost of Tier 1 alone:** one wasted first-call against an unknown reasoning model, then zero overhead. Acceptable for long-running workers; possibly worth optimizing for short-lived workers (Lambda, CI) — see Tier 2.

**Maintenance burden of Tier 1:** zero. New reasoning models with any of the four canonical response shapes are caught automatically. The empirical survey at [docs/research/reasoning-models-survey-2026-06.md](../research/reasoning-models-survey-2026-06.md) confirmed all current reasoning models on Cerebras, Groq, SambaNova, DeepInfra, and Parasail use one of the four shapes.

## Tier 2 — Behavioral fingerprint cache (cross-process optimization)

Opt-in via `createOpenAIAdapter({ fingerprintCache: ... })`. Eliminates the first-call penalty by persisting observed shapes across process boundaries.

### How it works

1. **On every successful response**, the adapter writes a fingerprint to the cache keyed by `(baseURL, modelId)`. This is free observability — no extra probe call needed.
2. **On port creation for a new model**, the adapter reads the cache. If a fingerprint exists, the learner is seeded with `reasoningModel: true` (or left alone for non-reasoning models).
3. **Backwards compat**: when `fingerprintCache` is undefined (default), the adapter behaves exactly as in alpha.23 — Tier 1 still catches everything.

### Bundled backends

```ts
import {
  createOpenAIAdapter,
  InMemoryFingerprintCache,
  FileFingerprintCache,
} from "@llm-ports/adapter-openai";

// Development / tests: lifetime is the current process.
const adapter = createOpenAIAdapter({
  apiKey: process.env.DEEPINFRA_API_KEY!,
  baseURL: "https://api.deepinfra.com/v1/openai",
  fingerprintCache: new InMemoryFingerprintCache(),
});

// Production: atomic JSON file. Survives restarts; warm-start in CI by
// checking the fingerprint file into your repo or fetching from a known
// location at boot.
const adapter = createOpenAIAdapter({
  apiKey: process.env.DEEPINFRA_API_KEY!,
  baseURL: "https://api.deepinfra.com/v1/openai",
  fingerprintCache: new FileFingerprintCache("~/.llm-ports/fingerprints.json"),
});
```

### Bring-your-own backend

Implement the `FingerprintCacheBackend` interface for Redis, S3, KV store, etc.:

```ts
import type { FingerprintCacheBackend, ModelFingerprint } from "@llm-ports/adapter-openai";

class RedisFingerprintCache implements FingerprintCacheBackend {
  constructor(private redis: RedisClient) {}

  async get(key: string): Promise<ModelFingerprint | null> {
    const raw = await this.redis.get(`fp:${key}`);
    return raw ? JSON.parse(raw) : null;
  }

  async set(key: string, value: ModelFingerprint): Promise<void> {
    await this.redis.set(`fp:${key}`, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`fp:${key}`);
  }
}
```

The interface is intentionally minimal (get/set/optional delete) so backends are easy to write. All methods may return synchronously OR as Promises — the adapter awaits regardless.

### Standalone helper

For CI warm-start, fingerprint models explicitly before any production traffic:

```ts
import { fingerprintModel, FileFingerprintCache } from "@llm-ports/adapter-openai";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.DEEPINFRA_API_KEY!,
  baseURL: "https://api.deepinfra.com/v1/openai",
});

const cache = new FileFingerprintCache(".llm-ports/fingerprints.json");

const fp = await fingerprintModel(client, "openai/gpt-oss-120b");
await cache.set(buildFingerprintKey(client.baseURL, "openai/gpt-oss-120b"), fp);
// Now the cache contains the fingerprint; production code can warm from it.
```

### What the fingerprint contains

```ts
interface ModelFingerprint {
  modelId: string;         // canonical (normalized) — "gpt-oss-120b"
  baseURL: string;         // provider — "https://api.deepinfra.com/v1/openai"
  reasoningModel: boolean;
  reasoningField?: "reasoning" | "reasoning_content" | "reasoning_tokens" | "inline-think";
  fingerprintedAt: string; // ISO timestamp
  schemaVersion: 1;
}
```

The `reasoningField` is informational (which response field the provider exposes CoT on); it's not currently used by the runtime path (alpha.24), but reserved for future per-shape optimization.

## Tier 3 — Static catalog (FROZEN)

`KNOWN_REASONING_MODELS` in [packages/adapter-openai/src/capabilities.ts](https://github.com/baabakk/llm-ports/blob/main/packages/adapter-openai/src/capabilities.ts) holds anchored regex patterns matched against the *normalized* model ID (the part after the last `/`):

| Pattern | Production cases |
|---|---|
| `/^o1(-|$)/`, `/^o3(-|$)/`, `/^o4(-|$)/` | OpenAI o-series |
| `/^gpt-5-nano/` | OpenAI gpt-5-nano family |
| `/^gpt-oss-/i` | Cerebras + DeepInfra + Groq gpt-oss-120b/20b |
| `/^qwen3[._-]?6/i` | Clarifai Qwen3.6 |
| `/^minimax[-_]?m2[._]7/i` | SambaNova MiniMax-M2.7 |
| `/^mimo[-_]?v\d/i` | Parasail Xiaomi MiMo-V family |

### Freeze policy (effective alpha.24+)

**The catalog is closed to new entries.** PRs adding regex patterns to `KNOWN_REASONING_MODELS` are not accepted. New reasoning models are handled by:

1. **Runtime detection** (Tier 1) — automatic on first call, no catalog edit needed
2. **Fingerprint cache** (Tier 2) — opt-in for users who want zero first-call penalty

### Why we froze it

- **Maintenance burden grows linearly with model count.** The empirical survey identified 30+ reasoning models across 5 providers. Maintaining 30+ regex entries (each potentially needing per-provider variants if naming conventions drift) is exactly the burden Tier 1 + Tier 2 eliminate.
- **Catalog gaps are silent correctness bugs.** Every missing entry is a model that pays the first-call penalty without anyone noticing — until it shows up in a production incident (see alpha.22's mimo-parasail diagnostic). Tier 1 + Tier 2 close those bugs by construction.
- **Provider naming conventions drift.** Cerebras renames `gpt-oss-120b` to `openai/gpt-oss-120b` to `gpt-oss-120b-fast` over time. Regex maintenance to track those drifts is unsustainable.
- **The existing entries are stable.** OpenAI's o-series naming is canonical; gpt-oss is fixed; Qwen3.6, MiniMax-M2.7, MiMo-V have stable family-prefix patterns. The catalog as it stands captures the durable cases.

### What the catalog still does well

The six entries above represent **stable production-grade families** with predictable naming. They capture ~80% of catalog-matchable reasoning calls in typical production workloads with zero false positives. Keeping them costs nothing.

What we don't do anymore: add an entry every time a new model ships. That's Tier 1's job (automatic) or Tier 2's job (cached).

## When to use which tier

| Use case | Recommended tier(s) |
|---|---|
| Backwards compatibility (existing code) | Tier 1 + Tier 3 (default; works since alpha.22) |
| Long-running worker (BEPA, ADW) | Tier 1 + Tier 3 (first-call penalty amortizes to nothing) |
| Short-lived CI / Lambda | Tier 1 + Tier 2 + Tier 3 (fingerprint file checked in, no first-call penalty) |
| Routing to a brand-new reasoning model | Tier 1 alone is sufficient; first call learns, rest of process is fast |
| Maximum production hardening | All three tiers + the per-attempt timeout (alpha.23) |

## See also

- [Reasoning model survey, 2026-06](../research/reasoning-models-survey-2026-06.md) — empirical data behind this architecture
- [Observability hooks](/concepts/observability) — including the `onCacheHit` event for fingerprint cache observability (planned alpha.25)
- [Validation strategies](/concepts/validation-strategies) — `onRetry` discriminators for the four reasoning-related rescue paths
