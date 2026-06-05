# @llm-ports/adapter-google

Native Google Gemini adapter for [`llm-ports`](https://github.com/baabakk/llm-ports), built on the unified [`@google/genai`](https://www.npmjs.com/package/@google/genai) SDK. Implements `LLMPort` with full multimodal support — image content blocks pass through as `inlineData` (base64) or `fileData` (URL), not degraded to placeholder text.

## Install

```bash
pnpm add @llm-ports/core @llm-ports/adapter-google @google/genai zod
```

## Configure

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createGoogleAdapter } from "@llm-ports/adapter-google";

const registry = createRegistryFromEnv({
  adapters: {
    google: createGoogleAdapter({
      apiKey: process.env.GOOGLE_API_KEY!, // get one at https://aistudio.google.com/apikey
    }),
  },
});

const llm = registry.getPort();
```

Env config:

```bash
LLM_PROVIDER_FAST=google|gemini-2.5-flash|cost:5/day
LLM_PROVIDER_SMART=google|gemini-2.5-pro|cost:50/day
LLM_TASK_ROUTE_TRIAGE=fast,smart
```

## Why use this over the OpenAI-compat baseURL

Gemini exposes an OpenAI-compatible surface at `https://generativelanguage.googleapis.com/v1beta/openai/`. It works for most cases. Reasons to prefer this native adapter:

| Concern | OpenAI-compat baseURL | `adapter-google` |
|---|---|---|
| `ImageSource.detail` field | Silently ignored | Ignored explicitly (consistent w/ other non-OpenAI providers) |
| `systemInstruction` | Prepended to user message — changes Gemini's behavior | Native top-level field |
| Multimodal image richness | image_url with base64 data URI (lossy) | inlineData with explicit mediaType |
| Bundled pricing | None — supply via `pricingOverrides` | Gemini 2.5 + 2.0 family bundled |
| `responseSchema` constrained-decoding | Not exposed | v0.2 (currently prompted-JSON + Zod) |

## Supported features (v0.1)

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (prompted JSON + alpha.5 repair pass; native `responseSchema` in v0.2) |
| `streamText` | ✓ |
| `streamStructured` | ✓ (best-effort partial parse) |
| `runAgent` (single-turn) | ✓ (multi-turn native function-calling in v0.2) |
| Vision input — base64 images | ✓ (inlineData) |
| Vision input — URL images | ✓ (fileData) |
| Audio input — base64 | ✓ (inlineData) |
| Image size + URL validation at boundary | ✓ (alpha.5) |
| `onRetry` observability hook (validation-feedback retries) | ✓ (alpha.17) |
| Embeddings (`gemini-embedding-001`) | ✗ — v0.2 |
| Explicit context caching | ✗ — v0.2 |
| Code execution tool | ✗ — v0.2 |

## Adapter options

```ts
interface GoogleAdapterOptions {
  apiKey: string;
  pricingOverrides?: Record<string, ModelPricing>;
  validationStrategy?: ValidationStrategy;
  imageSizeLimitBytes?: number; // default 20 MB
}
```

## Bundled pricing

| Model | Input/1M | Output/1M | Cached input/1M |
|-------|---------:|----------:|----------------:|
| `gemini-2.5-pro` | $1.25 | $5.00 | $0.3125 |
| `gemini-2.5-flash` | $0.075 | $0.30 | $0.01875 |
| `gemini-2.5-flash-lite` | $0.0375 | $0.15 | $0.009375 |
| `gemini-2.0-flash` | $0.10 | $0.40 | $0.025 |
| `gemini-2.0-flash-lite` | $0.075 | $0.30 | — |

Pricing source: <https://ai.google.dev/gemini-api/docs/pricing> (verified 2026-05). Bundled values are the under-200k-token tier. For long-context workloads, supply `pricingOverrides` with the over-200k rates.

## Content blocks supported

`text`, `image` (base64 → inlineData; URL → fileData), `audio` (base64 only — Gemini accepts inlineData for audio), `tool_use`, `tool_result`. Throws `ContentBlockUnsupportedError` for URL-form audio.

## Cancellation

Full `AbortSignal` support shipped in `0.1.0-alpha.6`. The signal is threaded into the `config` arg of `client.models.generateContent`, so `controller.abort()` cancels the in-flight HTTP request. `runAgent` also re-checks the signal between steps. See the [Cancellation guide](https://baabakk.github.io/llm-ports/guides/cancellation).

## Reading next

- [Google adapter docs](https://baabakk.github.io/llm-ports/adapters/google) — full feature deep-dive
- [OpenAI adapter](https://baabakk.github.io/llm-ports/adapters/openai) — comparison when choosing between native Gemini and OpenAI-compat path
- [Multi-provider routing](https://baabakk.github.io/llm-ports/guides/multi-provider) — chain Gemini with Anthropic / OpenAI fallbacks
- [@google/genai SDK docs](https://github.com/googleapis/js-genai) — underlying SDK reference
