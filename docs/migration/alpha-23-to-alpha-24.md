# Migrating from alpha.23 to alpha.24

> **Zero breaking changes — runtime AND type-level.** alpha.24 is fully additive. Existing code compiles and runs without modification.

## Install

```bash
pnpm add @llm-ports/core@alpha @llm-ports/adapter-openai@alpha
```

All 7 publishable packages bumped to `0.1.0-alpha.24`.

## The headline

**The static catalog is now FROZEN.** New reasoning models are caught by:

1. **Runtime detection** (universal correctness path, shipped alpha.22, no maintenance)
2. **Behavioral fingerprint cache** (new opt-in optimization, shipped alpha.24)

The `KNOWN_REASONING_MODELS` catalog stays for the well-known cases (OpenAI o-series, gpt-5-nano, gpt-oss family, Qwen3.6, MiniMax-M2.7, MiMo-V) but stops growing. See [Capability Detection](/concepts/capability-detection) for the three-tier architecture.

## What was added

### 1. Behavioral fingerprint cache (adapter-openai)

Opt-in via `createOpenAIAdapter({ fingerprintCache })`. Bundled backends:

```ts
import {
  createOpenAIAdapter,
  InMemoryFingerprintCache,
  FileFingerprintCache,
} from "@llm-ports/adapter-openai";

// Long-running worker: persist across restarts.
const adapter = createOpenAIAdapter({
  apiKey: process.env.DEEPINFRA_API_KEY!,
  baseURL: "https://api.deepinfra.com/v1/openai",
  fingerprintCache: new FileFingerprintCache("~/.llm-ports/fingerprints.json"),
});

// Dev / tests / short workers: lifetime is the current process.
const adapter = createOpenAIAdapter({
  apiKey: process.env.DEEPINFRA_API_KEY!,
  fingerprintCache: new InMemoryFingerprintCache(),
});
```

Bring-your-own backend (Redis, S3, KV) by implementing `FingerprintCacheBackend`:

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
}
```

CI warm-start helper:

```ts
import { fingerprintModel, FileFingerprintCache, buildFingerprintKey } from "@llm-ports/adapter-openai";

const cache = new FileFingerprintCache(".llm-ports/fingerprints.json");
const fp = await fingerprintModel(client, "openai/gpt-oss-120b");
await cache.set(buildFingerprintKey(client.baseURL, "openai/gpt-oss-120b"), fp);
```

### 2. `onValidationRetry` Registry-level emission (`@llm-ports/core`)

Closes the alpha.21-deferred Registry-level emission. The `observability.onValidationRetry` hook was type-only since alpha.21; alpha.24 ships the helper that makes it fire:

```ts
import { createRegistryFromEnv, deriveValidationRetryFromAdapterRetry } from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const registry = createRegistryFromEnv({
  // ...
  observability: {
    onValidationRetry: (e) => myMetrics.validationRetries.inc({ model: e.modelId }),
  },
});

const adapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  onRetry: deriveValidationRetryFromAdapterRetry(registry, {
    userOnRetry: (e) => myLogger.warn("retry", e), // optional chaining
  }),
});
```

### 3. Cerebras pricing entries

`OPENAI_PRICING` extended with two Cerebras production models:

| Model | Input $/1M | Output $/1M | Confidence |
|---|---|---|---|
| `gpt-oss-120b` | $0.35 | $0.75 | HIGH (primary docs) |
| `zai-glm-4.7` | $2.25 | $2.75 | MEDIUM (third-party only) |

### 4. Newly exported helpers

```ts
import {
  parseHarmonyToolCalls,        // alpha.23 — exposed in alpha.24
  normalizeModelId,             // alpha.22 — exposed in alpha.24
  buildFingerprintKey,          // new
  fingerprintModel,             // new
  FileFingerprintCache,         // new
  InMemoryFingerprintCache,     // new
  inspectResponseForFingerprint,// new
  type FingerprintCacheBackend, // new
  type ModelFingerprint,        // new
} from "@llm-ports/adapter-openai";

import {
  deriveValidationRetryFromAdapterRetry,  // new
} from "@llm-ports/core";
```

## What did NOT change

- All existing public types and interfaces unchanged.
- All existing call patterns unchanged.
- All existing adapter constructions work unmodified.
- Runtime behavior with default options (no fingerprint cache, no custom onRetry chaining) is identical to alpha.23.

## Should you do anything?

If you're upgrading from alpha.23 with no changes, nothing breaks. Pick from these on your own schedule:

| If you want… | Do this |
|---|---|
| Faster cold start on a worker that routes to compat-provider reasoning models | Add `fingerprintCache: new FileFingerprintCache(path)` to adapter construction |
| Registry-level observability of validation-feedback retries | Wire `deriveValidationRetryFromAdapterRetry(registry)` as the adapter's `onRetry` |
| Cerebras gpt-oss-120b or zai-glm-4.7 pricing built-in | Just upgrade — automatic |
| All three | Upgrade + add `fingerprintCache` + wire the derivation helper |

## New conceptual docs

- [Capability detection](/concepts/capability-detection) — the three-tier architecture (runtime > fingerprint > catalog)
- [Reasoning-model survey, 2026-06](https://github.com/baabakk/llm-ports/blob/main/docs/research/reasoning-models-survey-2026-06.md) — empirical data behind the architecture (30+ models across 5 providers; three CoT field conventions; round-trip caveats)

## Reference

- [Release notes](https://github.com/baabakk/llm-ports/releases/tag/v0.1.0-alpha.24) | [Discussion](https://github.com/baabakk/llm-ports/discussions)
- [Research artifact](https://github.com/baabakk/llm-ports/blob/main/docs/research/reasoning-models-survey-2026-06.md)
