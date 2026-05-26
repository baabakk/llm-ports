# @llm-ports/adapter-anthropic

Direct [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) adapter for [llm-ports](https://github.com/baabakk/llm-ports). Implements `LLMPort` for Claude models with prompt caching, vision, and tool use.

## Install

```bash
pnpm add @llm-ports/core @llm-ports/adapter-anthropic @anthropic-ai/sdk zod
```

## Configure

```typescript
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

const registry = createRegistryFromEnv({
  adapters: {
    anthropic: createAnthropicAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    }),
  },
});

const llm = registry.getPort();

const result = await llm.generateText({
  taskType: "triage",
  prompt: "Classify this email: ...",
});
```

`.env`:

```
LLM_PROVIDER_FAST=anthropic|claude-haiku-4-5|cost:5/day
LLM_PROVIDER_SMART=anthropic|claude-sonnet-4-6-20250514|cost:50/day
LLM_TASK_ROUTE_TRIAGE=fast,smart
```

## Adapter options

```ts
interface AnthropicAdapterOptions {
  apiKey: string;
  baseURL?: string;                            // typically only useful for testing
  fetch?: typeof fetch;                        // inject custom fetch (tests, proxies)
  validationStrategy?: ValidationStrategy;
  pricingOverrides?: Record<string, ModelPricing>;
  imageSizeLimitBytes?: number;                // default 5 MB (Anthropic's per-image limit)
  onRetry?: OnRetry;                           // observability hook for retries
}
```

## Bundled pricing

The bundled `ANTHROPIC_PRICING` table covers Claude Opus 4.5, Sonnet 4.5/4.6, Haiku 4.5 with full cache-read / cache-write rates. Override per model via `pricingOverrides`.

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ with `retry-with-feedback` (default) |
| `streamText` | ✓ (yields text chunks) |
| `streamStructured` (partial JSON) | ✓ (best-effort partial parse) |
| `runAgent` (multi-turn tool use) | ✓ |
| Prompt caching | ✓ — reported in cost via `cacheReadTokens` / `cacheWriteTokens` |
| Vision input — base64 images | ✓ |
| Vision input — URL images | ✓ |
| Audio input | ✗ — throws `ContentBlockUnsupportedError` |
| Embeddings | ✗ — Anthropic ships no embedding models |
| `AbortSignal` cancellation | ✓ entry + in-flight (alpha.6) |

## Content blocks supported

`text`, `image` (base64 + URL), `tool_use`, `tool_result`. Throws `ContentBlockUnsupportedError` for `audio`.

## Cancellation

Full `AbortSignal` support shipped in `0.1.0-alpha.6`. The signal is threaded into both `client.messages.create` (non-streaming) and `client.messages.stream`, so `controller.abort()` cancels the in-flight HTTP request. `runAgent` also re-checks the signal between steps so cancellation propagates mid-loop. See the [Cancellation guide](https://baabakk.github.io/llm-ports/guides/cancellation).

## Temperature handling on reasoning models

Claude 4.5+ reasoning models (`claude-opus-4-5*`, `claude-sonnet-4-5*`) reject custom `temperature` values. The adapter learns this constraint at runtime (or via the static `KNOWN_TEMPERATURE_REJECTORS` catalog) and strips the parameter automatically. The `onRetry` hook fires once with `reason: "capability-fallback"` + `capability: "temperatureLocked"`. See [`docs/known-quirks.md`](https://github.com/baabakk/llm-ports/blob/main/docs/known-quirks.md) for the full catalog.

## SDK version compatibility

The adapter is tested against `@anthropic-ai/sdk` `0.32.0` ≤ v < `0.50.0`. If your installed SDK is outside that range, a one-time `console.warn` fires at adapter creation with guidance.

## Reading next

- [Anthropic adapter docs](https://baabakk.github.io/llm-ports/adapters/anthropic) — full feature deep-dive
- [Known model quirks](https://baabakk.github.io/llm-ports/known-quirks) — temperature rejection, prompt-caching nuances
- [Tool-use security guide](https://baabakk.github.io/llm-ports/guides/security) — `runAgent` safety patterns
- [Multi-provider routing](https://baabakk.github.io/llm-ports/guides/multi-provider) — chain Anthropic with OpenAI / Gemini fallbacks
