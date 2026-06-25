# @llm-ports/adapter-openai

[OpenAI SDK](https://www.npmjs.com/package/openai) adapter for [llm-ports](https://github.com/baabakk/llm-ports). Implements `LLMPort` and `EmbeddingsPort`. The same adapter serves OpenAI plus 12+ OpenAI-compatible providers via `baseURL`, including Groq, Together AI, Fireworks AI, Cerebras, Clarifai, and SambaNova.

## Install

```bash
pnpm add @llm-ports/core @llm-ports/adapter-openai openai zod
```

## Configure

```typescript
import { createRegistryFromEnv } from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const registry = createRegistryFromEnv({
  adapters: {
    openai: createOpenAIAdapter({
      apiKey: process.env.OPENAI_API_KEY!,
    }),
  },
});

const llm = registry.getPort();
const embed = registry.getEmbeddingsPort();
```

### Compat providers

The same adapter works for any provider that exposes an OpenAI-shaped API. Just supply a `baseURL`:

| Provider | `baseURL` |
|----------|-----------|
| OpenAI (default) | (none) |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>` |
| Groq | `https://api.groq.com/openai/v1` |
| Together AI | `https://api.together.xyz/v1` |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Perplexity | `https://api.perplexity.ai` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Clarifai | `https://api.clarifai.com/v2/ext/openai/v1` |
| SambaNova | `https://api.sambanova.ai/v1` |
| LiteLLM proxy | self-hosted, e.g. `http://localhost:4000` |
| Ollama compat-mode | `http://localhost:11434/v1` (prefer `adapter-ollama` for native API) |

Each compatible provider has its own pricing — supply via `pricingOverrides`:

```typescript
createOpenAIAdapter({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
  displayName: "groq",
  pricingOverrides: {
    "llama-3.3-70b-versatile": { inputPer1M: 0.59, outputPer1M: 0.79 },
  },
});
```

## Adapter options

```ts
interface OpenAIAdapterOptions {
  apiKey: string;
  baseURL?: string;                            // for OpenAI-compat providers
  fetch?: typeof fetch;                        // inject custom fetch (tests, proxies)
  validationStrategy?: ValidationStrategy;
  pricingOverrides?: Record<string, ModelPricing>;
  displayName?: string;                        // friendlier alias in error messages
  imageSizeLimitBytes?: number;                // default 20 MB
  dangerouslyAllowBrowser?: boolean;           // opt in to browser execution (alpha.9)
  maxRetries?: number;                         // SDK-level retries (default 2)
  transientAuthRetries?: number;               // project-key 401 burst retries (default 2)
  transientAuthBackoffMs?: (attempt: number) => number;
  onRetry?: OnRetry;                           // observability hook
}
```

### `dangerouslyAllowBrowser` (alpha.9+)

The OpenAI SDK refuses to construct in a browser environment unless `dangerouslyAllowBrowser: true` is passed explicitly. Set this option only when the API key is NOT a long-lived secret: short-lived proxy tokens, BYO-key UIs where the end user supplies their own key, or trusted internal tools running behind auth. For server-side proxy patterns where the secret stays on the server, leave it unset.

```ts
const adapter = createOpenAIAdapter({
  apiKey: ephemeralUserKey,
  dangerouslyAllowBrowser: true,
});
```

## Bundled pricing

The bundled `OPENAI_PRICING` table covers GPT-5 family (gpt-5, gpt-5-mini, gpt-5-nano), GPT-4o family, o3 / o3-mini, and the embedding models. Override per model via `pricingOverrides`.

Bundled pricing does NOT cover compat-provider models (Groq, Together AI, Fireworks, Cerebras, Clarifai, SambaNova, LiteLLM proxy, etc.) — supply `pricingOverrides` for those.

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (uses native `response_format: json_object` + `retry-with-feedback`) |
| `streamText` | ✓ |
| `streamStructured` (partial JSON) | ✓ (best-effort partial parse) |
| `runAgent` (multi-turn tool use) | ✓ |
| `generateEmbedding` / `generateEmbeddings` | ✓ (text-embedding-3-small / -large) |
| Vision input — base64 images | ✓ (data URI) |
| Vision input — URL images | ✓ |
| Audio input — base64 wav/mp3 | ✓ |
| Audio input — base64 ogg | ✗ (OpenAI doesn't support ogg) |
| Audio input — URL audio | ✗ (OpenAI requires base64) |
| Prompt caching | ✓ — reported via `cachedTokens` |
| `AbortSignal` cancellation | ✓ entry + in-flight (alpha.6) |

## Content blocks supported

`text`, `image` (base64 → data URI; URL passthrough), `audio` (base64 wav/mp3 only), `tool_use`, `tool_result`. Throws `ContentBlockUnsupportedError` for unsupported variants.

## Capability detection — three-tier architecture (alpha.24+)

Reasoning models consume output tokens on hidden chain-of-thought before producing visible text. The adapter detects this and retries once with the budget expanded by a headroom multiplier.

**The detection mechanism has three tiers** (see [Capability Detection](https://github.com/baabakk/llm-ports/blob/main/docs/concepts/capability-detection.md) for the full design):

1. **Runtime detection (alpha.22+)** — universal correctness path. Every successful response is inspected for four CoT field shapes (`usage.completion_tokens_details.reasoning_tokens`, `message.reasoning`, `message.reasoning_content`, inline `<think>`). Catches every reasoning model with zero maintenance.
2. **Behavioral fingerprint cache (alpha.24+)** — opt-in cross-process optimization. `createOpenAIAdapter({ fingerprintCache })` skips the first-call discovery penalty.
3. **Static catalog (`KNOWN_REASONING_MODELS`, FROZEN)** — cheap shortcut for the stable well-known cases. Closed to new entries.

### Behavioral fingerprint cache

```ts
import { createOpenAIAdapter, FileFingerprintCache } from "@llm-ports/adapter-openai";

// Long-running worker: persist across restarts
const adapter = createOpenAIAdapter({
  apiKey: process.env.DEEPINFRA_API_KEY!,
  baseURL: "https://api.deepinfra.com/v1/openai",
  fingerprintCache: new FileFingerprintCache("~/.llm-ports/fingerprints.json"),
});
```

Bundled backends: `InMemoryFingerprintCache` (dev/tests; lifetime is the current process), `FileFingerprintCache` (atomic JSON; survives restarts). Bring-your-own backend (Redis, S3, KV) via the `FingerprintCacheBackend` interface. Standalone helper `fingerprintModel()` for CI warm-starts.



**Two detection layers (alpha.22+):**

1. **Runtime detection (correctness path).** On every successful response, the adapter inspects three reasoning signals and marks the model as reasoning if any is present:
   - `usage.completion_tokens_details.reasoning_tokens > 0` (OpenAI o-series, gpt-5-nano)
   - `choices[0].message.reasoning` populated (Cerebras gpt-oss-* serving)
   - `choices[0].message.reasoning_content` populated (DeepInfra harmony serving; alpha.22)

   And the starvation rescue fires when visible output is empty (no `content`, no executable `tool_calls`) AND a reasoning signal is present AND `finish_reason` is either `length` or `stop`. The `stop`-also-counts relaxation in alpha.22 catches the DeepInfra harmony case where providers return `stop` despite the model not having finished.

2. **Static catalog (optimization).** `KNOWN_REASONING_MODELS` pre-seeds the cache at port creation so the first call against a known model already uses the expanded budget — skipping the wasted round-trip. **As of alpha.22 the catalog is matched against the *normalized* model ID** (the canonical name after stripping any `<owner>/` prefix), so namespaced provider IDs match the same canonical patterns:

| Pattern (against canonical name) | Matches |
|---|---|
| `o1*` / `o3*` / `o4*` | OpenAI native |
| `gpt-5-nano*` | OpenAI native |
| `gpt-oss-*` | Cerebras `gpt-oss-120b`, DeepInfra `openai/gpt-oss-120b`, Groq `openai/gpt-oss-120b`, any future namespaced variant |
| `qwen3[._-]?6*` | Clarifai `Qwen3_6-35B-A3B-FP8`, any future namespaced Qwen3.6 variant |
| `minimax[-_]?m2[._]7*` | SambaNova `MiniMax-M2.7`, any future namespaced variant |
| `mimo[-_]?v\d*` | Parasail `XiaomiMiMo/MiMo-V2.5`, any future MiMo-V version (alpha.22+) |

The architectural payoff of normalization: the same canonical model served by two providers (Cerebras's `gpt-oss-120b` and DeepInfra's `openai/gpt-oss-120b`) shares learned state. A constraint learned at runtime for one is visible to the other.

Unknown reasoning models still get caught by runtime learning on first call; the catalog only saves the first-call round-trip. User-supplied `pricingOverrides[modelId].capabilities.reasoningModel` always wins.

### Known limitation: DeepInfra gpt-oss harmony tool-use (alpha.22)

DeepInfra serves gpt-oss in OpenAI's harmony format where tool-call intent lands in `message.reasoning_content` rather than `message.tool_calls`. **The adapter does NOT parse the harmony channel for tool calls.** Concretely:

- The `runAgent` response parser ([`fromOpenAIAssistantMessage` in `src/content.ts`](https://github.com/baabakk/llm-ports/blob/main/packages/adapter-openai/src/content.ts#L221-L247)) reads tool calls only from the standard `message.tool_calls` field, never from `message.reasoning_content`.
- When DeepInfra emits harmony-format tool intent in `reasoning_content`, that intent is invisible to the loop — the assistant message is parsed as having empty content and no executable tool calls.

What alpha.22 DOES change for this case is observability + a rescue retry:
- The model is correctly identified as reasoning (via the alpha.22 model-ID normalization).
- The reasoning-budget multiplier applies on call 1 (no first-call starvation penalty).
- The starvation rescue fires when content is empty + `reasoning_content` is populated + `finish_reason` is `stop`. The retry gives the model one more chance to emit standard `tool_calls`. If the model emits standard fields on retry, the loop converges; if it lands the intent in `reasoning_content` again, the loop still terminates without executing the tool.

**For tool-use workloads against gpt-oss, route to Cerebras** (where the harmony channels are translated into standard `tool_calls` by the provider's serving layer). Empirical observation (ADW, 2026-06-19): Cerebras `gpt-oss-120b` writes 5 files in the multi-turn build loop; DeepInfra `openai/gpt-oss-120b` writes 0.

The harmony-channel tool-call parser is a research-first follow-up tracked for a future release.

### Update for alpha.23: harmony extraction now works

The harmony-channel tool-call parser shipped in alpha.23. When `tool_calls` is empty AND `reasoning_content` contains a parseable harmony tool call (the DeepInfra-served gpt-oss case), the adapter extracts and executes it. **Zero extra LLM calls.** No code change required — the improvement applies to any `runAgent` call automatically.

The parser is also exported for direct use:

```ts
import { parseHarmonyToolCalls } from "@llm-ports/adapter-openai";

// Extract one or more tool calls from a harmony-formatted reasoning_content.
// Returns null when no parseable harmony tool call is found (prose, bare JSON
// without a tool name, malformed, etc.).
const calls = parseHarmonyToolCalls(reasoningContent);
```

Emits `onRetry` with reason `"harmony-tool-call-extracted"` on success (observability only; no retry actually happens).

### Tool-use prose rescue (alpha.23+)

When the model returns a clean completion (`finish_reason: "stop"` or `"length"`) with prose content, empty `tool_calls`, and the request had a tools array, the adapter retries once with a corrective system message asking the model to use the standard `tool_calls` format. Single-shot retry. Five discriminators prevent over-firing (no tools, populated tool_calls, empty content, populated reasoning_content, prior tool-result message in conversation).

Empirically the mimo-parasail case from ADW's 2026-06-19 diagnostic where the model returned ~69 tokens of "I would do this..." prose with zero tool_calls. Post-alpha.23, the rescue gives the model one corrective shot.

Emits `onRetry` with reason `"zero-tool-call-prose-retry"` for observability.

```typescript
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const clarifai = createOpenAIAdapter({
  apiKey: process.env.CLARIFAI_PAT!,
  baseURL: "https://api.clarifai.com/v2/ext/openai/v1",
  displayName: "clarifai",
  pricingOverrides: {
    "Qwen3_6-35B-A3B-FP8": { inputPer1M: 0.76, outputPer1M: 0.43 },
  },
});
```

## Cancellation

Full `AbortSignal` support shipped in `0.1.0-alpha.6`. The signal is threaded as the 2nd-arg request options to `client.chat.completions.create`, so `controller.abort()` cancels the in-flight HTTP request — both for one-shot calls and for streaming. `runAgent` also re-checks the signal between steps. See the [Cancellation guide](https://baabakk.github.io/llm-ports/guides/cancellation).

## Reading next

- [OpenAI adapter docs](https://baabakk.github.io/llm-ports/adapters/openai) — full feature deep-dive
- [Compat providers](https://baabakk.github.io/llm-ports/adapters/openai#compat-providers) — Clarifai, SambaNova, Groq, Cerebras worked examples
- [Known reasoning models](https://baabakk.github.io/llm-ports/known-quirks) — static catalog + runtime learning
- [Multi-provider routing](https://baabakk.github.io/llm-ports/guides/multi-provider) — chain OpenAI with Anthropic / Gemini fallbacks
