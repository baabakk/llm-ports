# `@llm-ports/adapter-google`

Native [Google Gemini](https://ai.google.dev/) adapter for [`llm-ports`](https://github.com/baabakk/llm-ports), built on the unified [`@google/genai`](https://www.npmjs.com/package/@google/genai) SDK (v2.x). Implements `LLMPort` with full multimodal support — image content blocks pass through as `inlineData` (base64) or `fileData` (URL), not degraded to placeholder text.

Shipped in `0.1.0-alpha.5`.

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
      apiKey: process.env.GOOGLE_API_KEY!, // from https://aistudio.google.com/apikey
    }),
  },
});

export const llm = registry.getPort();
```

`.env`:

```
LLM_PROVIDER_FAST=google|gemini-2.5-flash|cost:5/day
LLM_PROVIDER_PREMIUM=google|gemini-2.5-pro|cost:50/day
LLM_TASK_ROUTE_TRIAGE=fast,premium
```

## Adapter options

```ts
interface GoogleAdapterOptions {
  apiKey: string;
  pricingOverrides?: Record<string, ModelPricing>;
  validationStrategy?: ValidationStrategy;
  imageSizeLimitBytes?: number; // default 20 MB
}
```

## Why this over the OpenAI-compat baseURL

Gemini exposes an OpenAI-compatible surface at `https://generativelanguage.googleapis.com/v1beta/openai/`. It works for most cases. Reasons to prefer this native adapter:

| Concern | OpenAI-compat baseURL | `adapter-google` |
|---|---|---|
| `ImageSource.detail` | Silently ignored — Gemini has no equivalent | Ignored explicitly (consistent with adapter-anthropic) |
| `systemInstruction` | Prepended to user message, changing Gemini's behavior | Native top-level field |
| Multimodal richness | image_url with base64 data URI (lossy) | inlineData with explicit mediaType |
| Bundled pricing | None — bring your own | Gemini 2.5 + 2.0 family bundled |
| Image-block boundary validation | Inherits from adapter-openai | First-class, with `imageSizeLimitBytes` option |
| Native `responseSchema` | Not exposed | v0.2 (currently prompted-JSON + Zod) |

## Bundled pricing

| Model | Input/1M | Output/1M | Cache read |
|-------|---------:|----------:|-----------:|
| `gemini-2.5-pro` | $1.25 | $5.00 | $0.3125 |
| `gemini-2.5-flash` | $0.075 | $0.30 | $0.01875 |
| `gemini-2.5-flash-lite` | $0.0375 | $0.15 | $0.009375 |
| `gemini-2.0-flash` | $0.10 | $0.40 | $0.025 |
| `gemini-2.0-flash-lite` | $0.075 | $0.30 | — |

Source: <https://ai.google.dev/gemini-api/docs/pricing> (verified 2026-05).

> **Long-context premium**: bundled values are the under-200k-token rates. Gemini charges a higher rate above 200k tokens. For long-context workloads, supply `pricingOverrides` with the over-200k rates.

## Supported features (v0.1)

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (prompted JSON + alpha.5 repair pass; native `responseSchema` in v0.2) |
| `streamText` | ✓ |
| `streamStructured` | ✓ (best-effort partial parse) |
| `runAgent` | single-turn shim (multi-turn native function-calling in v0.2; matches adapter-vercel's v0.1 shape) |
| Vision input — base64 images | ✓ (inlineData) |
| Vision input — URL images | ✓ (fileData) |
| Audio input — base64 | ✓ (inlineData) |
| Image-block size + URL validation at boundary | ✓ (alpha.5) |
| `AbortSignal` cancellation | ✓ entry + in-flight (alpha.6) |
| Embeddings (`gemini-embedding-001`) | ✗ — v0.2 |
| Explicit context caching | ✗ — v0.2 |
| Code execution tool | ✗ — v0.2 |

## Content blocks supported

`text`, `image` (base64 → inlineData; URL → fileData), `audio` (base64 only), `tool_use`, `tool_result`. The adapter throws `ContentBlockUnsupportedError` for unsupported variants (audio URLs).

## Cancellation

Full `AbortSignal` support shipped in `0.1.0-alpha.6`. Threading the signal cancels the in-flight provider HTTP fetch, not just the JS await:

```ts
const controller = new AbortController();
const promise = llm.generateText({
  taskType: "describe_image",
  prompt: [...],
  signal: controller.signal,
});
// User clicks cancel:
controller.abort();
// promise rejects; the HTTP request to generativelanguage.googleapis.com is cancelled.
```

See the [Cancellation guide](/guides/cancellation) for the full pattern.

## Image cost note

Gemini does not have a separate cost-vs-fidelity knob equivalent to OpenAI's `image_url.detail`. Image cost is determined by the model's automatic tiling — typically ~258 tokens per image for `gemini-2.5-flash`, ~1,290 for high-resolution inputs to `gemini-2.5-pro`. If you set `ImageSource.detail` on a call routed to a Gemini model, the adapter ignores the field (consistent with adapter-anthropic).

## Reading next

- [`@llm-ports/adapter-openai`](/adapters/openai) — comparison if you're choosing between native Gemini and the OpenAI-compat path
- [Cancellation guide](/guides/cancellation) — `AbortSignal` usage
- [Multi-provider routing](/guides/multi-provider) — chain Gemini with Anthropic / OpenAI fallbacks
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) — verify bundled table
- [@google/genai SDK docs](https://github.com/googleapis/js-genai) — underlying SDK reference
