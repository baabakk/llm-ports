# `@llm-ports/adapter-openai`

Direct adapter for the [OpenAI SDK](https://www.npmjs.com/package/openai). Implements both `LLMPort` and `EmbeddingsPort`. The `baseURL` option means the same adapter serves OpenAI plus 10+ OpenAI-compatible providers.

## Install

```bash
pnpm add @llm-ports/core @llm-ports/adapter-openai openai zod
```

## Configure (OpenAI default)

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const registry = createRegistryFromEnv({
  adapters: {
    openai: createOpenAIAdapter({
      apiKey: process.env.OPENAI_API_KEY!,
    }),
  },
});

export const llm = registry.getPort();
```

## Configure (compat providers via `baseURL`)

| Provider | `baseURL` | Notes |
|----------|-----------|-------|
| OpenAI | (none) | Default |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>` | Needs `api-version` header |
| Groq | `https://api.groq.com/openai/v1` | Fast inference |
| Together AI | `https://api.together.xyz/v1` | Open models |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | Open models |
| DeepInfra | `https://api.deepinfra.com/v1/openai` | Open models |
| Perplexity | `https://api.perplexity.ai` | Online models with citations |
| Cerebras | `https://api.cerebras.ai/v1` | Fast inference |
| Clarifai | `https://api.clarifai.com/v2/ext/openai/v1` | Personal Access Token (PAT) as `apiKey`; hosts Qwen3.6 + others |
| SambaNova | `https://api.sambanova.ai/v1` | Bearer token as `apiKey`; hosts MiniMax-M2.7 + others |
| LiteLLM proxy | self-hosted, e.g. `http://localhost:4000` | Self-hosted proxy |
| Ollama (compat mode) | `http://localhost:11434/v1` | Prefer [`adapter-ollama`](/adapters/ollama) for native API + management |

Each compatible provider has its own pricing — supply via `pricingOverrides`:

```ts
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

createOpenAIAdapter({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
  pricingOverrides: {
    "llama-3.3-70b-versatile": { inputPer1M: 0.59, outputPer1M: 0.79 },
  },
});
```

### Worked example: Clarifai (Qwen3.6 35B A3B FP8)

Clarifai exposes an OpenAI-compatible surface at `/v2/ext/openai/v1`. Authenticate with a Personal Access Token (PAT), pass the model ID exactly as published by Clarifai (`Qwen3_6-35B-A3B-FP8`), and the adapter handles the rest. Qwen3.6 is a reasoning model and ships in `KNOWN_REASONING_MODELS`, so the first call already uses the reasoning-headroom multiplier — no wasted round-trip.

```ts
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const clarifai = createOpenAIAdapter({
  apiKey: process.env.CLARIFAI_PAT!,
  baseURL: "https://api.clarifai.com/v2/ext/openai/v1",
  displayName: "clarifai",
  pricingOverrides: {
    "Qwen3_6-35B-A3B-FP8": {
      inputPer1M: 0.76,
      outputPer1M: 0.43,
      // Blended ~$0.72/1M; 262k context window.
      // reasoningModel: true is auto-seeded via KNOWN_REASONING_MODELS;
      // setting it here would override the catalog if you ever need to.
    },
  },
});
```

> **Pricing note**: Clarifai's Qwen3.6 FP8 has output pricing *lower* than input ($0.43 vs $0.76 per 1M). That's not a typo. The FP8 quantization makes output token generation cheaper than the prefill stage; most providers price the other way, so verify with [Clarifai's pricing page](https://clarifai.com/pricing) before locking it in.

### Worked example: SambaNova (MiniMax M2.7)

SambaNova exposes an OpenAI-compatible surface at `https://api.sambanova.ai/v1`. Pass your SambaNova bearer token as `apiKey`, use the published model ID (`MiniMax-M2.7`). MiniMax-M2.7 is also pre-seeded as a reasoning model.

```ts
const sambanova = createOpenAIAdapter({
  apiKey: process.env.SAMBANOVA_API_KEY!,
  baseURL: "https://api.sambanova.ai/v1",
  displayName: "sambanova",
  pricingOverrides: {
    "MiniMax-M2.7": {
      inputPer1M: 0.60,
      outputPer1M: 2.40,
      // Blended ~$0.78/1M; 197k context window.
    },
  },
});
```

> **Reasoning models need budget.** Both Qwen3.6 and MiniMax-M2.7 burn tokens on hidden reasoning before producing visible output. Always supply `maxOutputTokens` (8k+ recommended) so the auto-retry headroom multiplier has a number to expand. Calls without `maxOutputTokens` skip the safety net.

> **Cost shape**: At blended $0.72/1M (Clarifai Qwen3.6) and $0.78/1M (SambaNova MiniMax-M2.7), these are comparable to Cerebras GptOSS 120B ($0.65 in / $0.85 out per 1M) and substantially cheaper than Claude Sonnet 4.5 ($3 in / $15 out). The 4:1 output:input premium on MiniMax-M2.7 means reasoning-heavy workloads (long internal chain-of-thought) will skew higher than the blended number suggests — budget on output tokens, not the blend.

## Adapter options

```ts
interface OpenAIAdapterOptions {
  apiKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
  validationStrategy?: ValidationStrategy;
  pricingOverrides?: Record<string, ModelPricing>;
  displayName?: string;             // for error messages when pointed at a non-OpenAI baseURL
  imageSizeLimitBytes?: number;     // default 20 MB
  maxRetries?: number;              // SDK-level retries (default 2)
  transientAuthRetries?: number;    // project-key 401 burst-protection retries (default 2)
  transientAuthBackoffMs?: (attempt: number) => number;
  dangerouslyAllowBrowser?: boolean; // alpha.9; opt in to browser execution
  useStrictResponseFormat?: boolean; // alpha.9; auto-detect expanded in alpha.14
  onRetry?: OnRetry;                // observability hook
}
// Per-call option (on every *Options interface, since alpha.12):
//   reasoningEffort?: "low" | "medium" | "high"
//   — Forwarded as `reasoning_effort` on the SDK call.
```

### `reasoningEffort` per-call (alpha.12)

OpenAI's `o3` / `o4-mini` / `gpt-5-nano` / `gpt-5` family and OpenAI-compat providers like Groq's `openai/gpt-oss-120b` accept a `reasoning_effort: "low" | "medium" | "high"` parameter that controls how many tokens the model spends on hidden chain-of-thought. Set it via the per-call option:

```ts
const result = await port.generateText({
  taskType: "complex-reasoning",
  prompt: "...",
  reasoningEffort: "high",  // adapter forwards as reasoning_effort
});
```

Groq's `openai/gpt-oss-120b` is the immediate case where this matters most — the model is exposed as a single model ID with no separate "low/medium/high" variants, so this knob is the only way to escalate quality. OpenAI's own reasoning models default to `"medium"`; setting `"high"` notably increases reasoning token spend (and quality on hard problems).

Forwarded verbatim with no per-model gating in v0.1. If you set `reasoningEffort` on a model that rejects the field, the SDK throws. Runtime capability learning for this case (parallel to `jsonModeUnsupported`) is v0.2 scope.

### `useStrictResponseFormat` (alpha.9 base + alpha.14 auto-detect expansion)

`generateStructured` can emit OpenAI / Cerebras / Groq strict JSON Schema mode:

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "<schemaName>", "schema": { ... }, "strict": true }
  }
}
```

…instead of the classic `{ type: "json_object" }`. With strict mode the provider constrains decoding to the exact schema before tokens are produced — invalid JSON and missing required fields are impossible (modulo provider bugs).

```ts
// All three of these auto-enable strict mode in alpha.14+:
const openai   = createOpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY! });
const cerebras = createOpenAIAdapter({
  apiKey: process.env.CEREBRAS_API_KEY!,
  baseURL: "https://api.cerebras.ai/v1",
});
const groq = createOpenAIAdapter({
  apiKey: process.env.GROQ_API_KEY!,
  baseURL: "https://api.groq.com/openai/v1",
});
```

**Auto-detection (alpha.14+).** `useStrictResponseFormat` defaults to `true` when:

| Condition | Why |
|---|---|
| `baseURL` is unset OR contains `api.openai.com` | OpenAI native — strict `json_schema` has been GA on gpt-4o / gpt-5 / o-series since August 2024 |
| `baseURL` contains `api.cerebras.ai` | Cerebras silently ignores classic `json_object` mode on gpt-oss / Qwen3.6 tiers — strict mode is the only reliable path |
| `baseURL` contains `api.groq.com` | Groq verified to support strict `response_format: json_schema` with constrained decoding (per Groq docs, May 2026) |
| `baseURL` contains `api.sambanova.ai` (alpha.15+) | Empirically verified 2026-05-27 — MiniMax-M2.7 with strict mode forced on jumped from 0/10 → 10/10 schema-valid on a nested production scoring schema |

For other compat providers (Together AI, Fireworks AI, Clarifai, LiteLLM proxy), the option **stays opt-in** — set `useStrictResponseFormat: true` explicitly once you've verified the provider's strict-mode support.

**Schema conversion.** Zod schemas are converted via `zod-to-json-schema` (`target: "openAi"`, `$refStrategy: "none"`), then post-processed to add `additionalProperties: false` on every nested object — a hard requirement of strict mode the SDK does not auto-inject.

**When NOT to use it / how to opt out.** Set `useStrictResponseFormat: false` explicitly when:

- **Your Zod schemas use open shapes** that can't accept `additionalProperties: false`: `z.record(...)`, schemas where the model is allowed to add extra fields, schemas with computed/optional sections.
- **You target a model that rejects `response_format` entirely.** Some Azure deployments, very old OpenAI models, certain compat providers. The adapter's runtime capability learning catches this on the first 400 (`jsonModeUnsupported: true` is remembered; subsequent calls fall back to prompted JSON without the wasted round-trip), but explicit `false` saves even the first failure.

**Runtime fallback.** If a model unexpectedly rejects the strict response format, the adapter learns the constraint on the first 400 and retries the same call with `response_format` stripped. The same learning applies to legacy `json_object` mode rejections; either signature flips `jsonModeUnsupported: true` for the model.

**Auto-detect helper exported.** If you build adapter instances programmatically and want to inherit the same default logic:

```ts
import { autoDetectStrictResponseFormat } from "@llm-ports/adapter-openai";

const wouldDefaultTo = autoDetectStrictResponseFormat("https://api.groq.com/openai/v1");
// → true
```

### `dangerouslyAllowBrowser` (alpha.9)

The OpenAI SDK refuses to construct in a browser environment unless `dangerouslyAllowBrowser: true` is passed explicitly. Set this option only when the API key is NOT a long-lived secret: short-lived proxy tokens, BYO-key UIs where the end user supplies their own key, or trusted internal tools running behind auth. For server-side proxy patterns where the secret stays on the server, leave it unset.

```ts
const adapter = createOpenAIAdapter({
  apiKey: ephemeralUserKey,
  dangerouslyAllowBrowser: true,
});
```

## Bundled pricing

| Model | Input/1M | Output/1M | Cached input |
|-------|---------:|----------:|-------------:|
| `gpt-5` | $2.50 | $10.00 | $0.25 |
| `gpt-5-mini` | $0.15 | $0.60 | $0.075 |
| `gpt-5-nano` | $0.05 | $0.20 | $0.025 |
| `gpt-4o` | $2.50 | $10.00 | $1.25 |
| `gpt-4o-mini` | $0.15 | $0.60 | $0.075 |
| `o3` | $15.00 | $60.00 | $7.50 |
| `o3-mini` | $1.10 | $4.40 | $0.55 |
| `text-embedding-3-small` | n/a | n/a | $0.02 (per 1M input tokens) |
| `text-embedding-3-large` | n/a | n/a | $0.13 |

Source: openai.com/pricing. Verified 2026-04-10.

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (native `response_format: json_object`; or strict `json_schema` mode when `useStrictResponseFormat` is set; + retry-with-feedback safety net) |
| `streamText` | ✓ |
| `streamStructured` | ✓ |
| `runAgent` (multi-turn tool use) | ✓ |
| `generateEmbedding` / `generateEmbeddings` | ✓ |
| Vision input — base64 images | ✓ (data URI) |
| Vision input — URL images | ✓ |
| Audio input — base64 wav, mp3 | ✓ |
| Audio input — base64 ogg | ✗ (OpenAI doesn't support ogg) |
| Audio input — URL audio | ✗ (OpenAI requires base64) |
| Prompt caching | partial (`cached_tokens` reported in usage) |
| `AbortSignal` cancellation | ✓ entry + in-flight (alpha.6) |
| `listModels()` | ✓ (alpha.9; via `client.models.list()`) |
| `dangerouslyAllowBrowser` opt-in | ✓ (alpha.9) |
| Strict JSON schema mode (`useStrictResponseFormat`) | ✓ (alpha.9; auto-detects on `api.cerebras.ai`) |
| `reasoningEffort` per-call passthrough | ✓ (alpha.12; threaded through every call shape) |

## Content blocks supported

`text`, `image` (base64 → data URI; URL passthrough), `audio` (base64 wav/mp3 only), `tool_use`, `tool_result`. The adapter throws `ContentBlockUnsupportedError` for unsupported variants.

### Image cost-vs-fidelity: the `detail` hint

OpenAI's vision pipeline accepts a `detail` hint per image: `"auto"` (default), `"low"`, or `"high"`.

| `detail` | Token cost | Use case |
|---|---|---|
| `"low"` | ~85 tokens regardless of image size | Triage, broad classification, "is this a screenshot of X?" |
| `"high"` | ~170 tokens per 512×512 tile (so a 1024×1024 image is ~765 tokens) | OCR, small-text reading, fine-grained reasoning |
| `"auto"` (default) | OpenAI picks based on image size | Sensible default for mixed workloads |

The field lives on `ImageSource` and is forwarded to `image_url.detail` when set:

```ts
const result = await llm.generateText({
  taskType: "screenshot_triage",
  prompt: [
    { type: "text", text: "Is this a login form or a settings page?" },
    {
      type: "image",
      source: {
        kind: "base64",
        mediaType: "image/png",
        data: screenshotBase64,
        detail: "low",  // 85 tokens vs ~765 for the default — 9x cheaper for triage
      },
    },
  ],
});
```

Other adapters ignore the field — Anthropic and Ollama don't have an equivalent knob.

## Reasoning models (auto-handled)

Reasoning models — OpenAI's `o3`, `o3-mini`, `gpt-5-nano`, plus compat-provider reasoning models like Cerebras `gpt-oss-120b` — burn tokens on internal chain-of-thought before producing visible output. A naive call with `maxOutputTokens: 20` against `gpt-5-nano` reliably returns empty text and `finish_reason=length` because the budget got consumed by reasoning.

**The OpenAI adapter handles this automatically**, with no configuration:

1. **Detection.** The adapter inspects each response for two reasoning signals: `usage.completion_tokens_details.reasoning_tokens > 0` (OpenAI o-series, gpt-5-nano shape) or a populated `message.reasoning` string field (Cerebras gpt-oss shape). Either signal marks the model as a reasoning model in a process-wide cache.
2. **Auto-retry on starvation.** If a response shows the starvation signature (`text === ""` + `finish_reason === "length"` + reasoning signal), the adapter retries the call once with `max_completion_tokens` multiplied by a headroom factor (default 10×). The retry typically succeeds with visible output.
3. **Subsequent calls skip discovery.** Once a model is marked reasoning in the cache, every later call to that model uses the multiplier up front — no wasted first-attempt round-trip.

The default headroom multiplier (10×) is calibrated against o-series reasoning intensity. You can override per-model via `pricingOverrides[modelId].capabilities.reasoningHeadroomMultiplier`.

> **First-call cost.** The first call to an unknown reasoning model in a given process pays one wasted round-trip (the starved attempt) before the cache learns the constraint. The adapter ships a `KNOWN_REASONING_MODELS` static catalog that pre-seeds the cache for well-known reasoning lineups so the wasted round-trip is skipped. Models the catalog already knows about (as of `0.1.0-alpha.4`):
>
> - OpenAI o-series (`o1*`, `o3*`, `o4*`)
> - OpenAI `gpt-5-nano*`
> - Cerebras `gpt-oss-*` (via `baseURL=https://api.cerebras.ai/v1`)
> - Clarifai `Qwen3_6-*` (via `baseURL=https://api.clarifai.com/v2/ext/openai/v1`)
> - SambaNova `MiniMax-M2.7` (via `baseURL=https://api.sambanova.ai/v1`)
>
> For other reasoning models the adapter doesn't know yet, runtime learning still catches the constraint on first call. To skip even that one wasted round-trip, set `pricingOverrides[modelId].capabilities.reasoningModel = true`. Tracked at [TD-LLMP-03](https://github.com/baabakk/llm-ports/blob/main/TECH-DEBT.md#td-llmp-03).

The adapter also handles two other transient OpenAI quirks transparently:

- **Capability rejection.** Some models reject custom `temperature`, `response_format: { type: "json_object" }`, or a separate `system` message. The adapter catches the `unsupported_value` error, learns the constraint, retries with the offending parameter dropped, and remembers it for the rest of the process.
- **Project-key burst protection (sk-proj-* keys).** New OpenAI project keys briefly return 401 "Incorrect API key" under burst protection — even when the key is valid. The adapter retries with exponential backoff (default 500ms / 1500ms / 4500ms), but only if a prior request on the same client succeeded (so a real bad key doesn't get masked). Configurable via the `transientAuthRetries` and `transientAuthBackoffMs` options.

All three retry kinds (plus `validation-feedback` retries inside `generateStructured`) fire the `onRetry` hook shipped in `0.1.0-alpha.1` — pass an `OnRetry` callback at adapter construction time to observe them. See [`examples/with-onretry/`](https://github.com/baabakk/llm-ports/tree/main/examples/with-onretry) for a worked example wiring the hook to a console logger and a metrics sink.

## Cancellation

Full `AbortSignal` support shipped in `0.1.0-alpha.6`. The signal is threaded as the 2nd-arg request options to `client.chat.completions.create`, so `controller.abort()` cancels the in-flight HTTP request — both for one-shot calls and for streaming. `runAgent` also re-checks the signal between steps. See the [Cancellation guide](/guides/cancellation).

## Reading next

- [Tool-use security guide](/guides/security) — `runAgent` code patterns, the destructive / requiresConfirmation / maxOutputBytes flags, the approval-gate wrapper
- [Content blocks reference](/concepts/content-blocks) — `tool_use` and `tool_result` block shapes
- [Multi-provider routing](/guides/multi-provider) — wire multiple compat providers as separate aliases
- [OpenAI pricing](https://openai.com/api/pricing/) — verify bundled table

> **Compat-provider test coverage.** Compat providers (Cerebras, Groq, Together AI, Fireworks AI, DeepInfra, Perplexity, Azure OpenAI, LiteLLM proxy) are exercised today by basic `generateText` live tests. Structured-output, streaming, agent, and embeddings coverage for compat providers is one-test-deep — e.g. a regression in Cerebras's `message.reasoning` parsing wouldn't be caught by the existing live suite. Tracked at [TD-LLMP-02](https://github.com/baabakk/llm-ports/blob/main/TECH-DEBT.md#td-llmp-02); full compat-provider matrix coverage ships with v0.2.
