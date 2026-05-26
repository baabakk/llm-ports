# `@llm-ports/adapter-anthropic`

Direct adapter for the [Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk). Implements `LLMPort` for Claude models. Does NOT implement `EmbeddingsPort` — Anthropic ships no embedding models.

## Install

```bash
pnpm add @llm-ports/core @llm-ports/adapter-anthropic @anthropic-ai/sdk zod
```

## Configure

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

const registry = createRegistryFromEnv({
  adapters: {
    anthropic: createAnthropicAdapter({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    }),
  },
});

export const llm = registry.getPort();
```

`.env`:

```
LLM_PROVIDER_FAST=anthropic|claude-haiku-4-5|cost:5/day
LLM_PROVIDER_PREMIUM=anthropic|claude-sonnet-4-6-20250514|cost:50/day
LLM_TASK_ROUTE_TRIAGE=fast,premium
```

## Adapter options

```ts
interface AnthropicAdapterOptions {
  apiKey: string;
  baseURL?: string;                 // typically only useful for testing
  fetch?: typeof fetch;             // inject a custom fetch (tests, proxies)
  validationStrategy?: ValidationStrategy;
  pricingOverrides?: Record<string, ModelPricing>;
  imageSizeLimitBytes?: number;     // default 5 MB (Anthropic's per-image limit)
  dangerouslyAllowBrowser?: boolean; // alpha.9; opt in to browser execution
  onRetry?: OnRetry;                // observability hook for retries
}
```

### `dangerouslyAllowBrowser` (alpha.9)

The Anthropic SDK refuses to construct in a browser environment unless `dangerouslyAllowBrowser: true` is passed explicitly. When enabled, the SDK auto-adds the `anthropic-dangerous-direct-browser-access` header on every request. Set this option only when the API key is NOT a long-lived secret: short-lived proxy tokens, BYO-key UIs where the end user supplies their own key, or trusted internal tools running behind auth. For server-side proxy patterns where the secret stays on the server, leave it unset.

```ts
const adapter = createAnthropicAdapter({
  apiKey: ephemeralUserKey,
  dangerouslyAllowBrowser: true,
});
```

### Claude 4.5+ temperature deprecation (alpha.10)

Anthropic deprecated the `temperature` parameter on the Claude 4 Opus + Sonnet reasoning family. The static catalog seeds `temperatureLocked: true` BEFORE the first call against any `claude-opus-4-N` or `claude-sonnet-4-N` model (N >= 5), so:

- Non-streaming methods skip the wasted "send temperature, get 400, retry without" round-trip.
- Streaming methods (`streamText`, `streamStructured`) work at all — they can't mid-stream retry, so the catalog hit is the ONLY thing that prevents a hard 400.

Bare `claude-opus-4` (the original 4.0 release) and the Claude Haiku 4-5 family still accept `temperature` and are passed through unchanged. The Anthropic adapter's `applyCapabilityFilter` strips `temperature` from the request body when the model is catalog-marked or has been learned at runtime.

## Bundled pricing

| Model | Input/1M | Output/1M | Cache read | Cache write |
|-------|---------:|----------:|-----------:|------------:|
| `claude-opus-4-7` | $15.00 | $75.00 | $1.50 | $18.75 |
| `claude-opus-4` | $15.00 | $75.00 | $1.50 | $18.75 |
| `claude-sonnet-4-6-20250514` | $3.00 | $15.00 | $0.30 | $3.75 |
| `claude-sonnet-4-5` | $3.00 | $15.00 | $0.30 | $3.75 |
| `claude-haiku-4-5` | $0.80 | $4.00 | $0.08 | $1.00 |

Source: anthropic.com/pricing. Verified 2026-05-26.

Override per model via `pricingOverrides` if prices change between releases:

```ts
createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  pricingOverrides: {
    "claude-sonnet-4-6-20250514": { inputPer1M: 3.5, outputPer1M: 17.5 },
  },
});
```

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (prompted JSON + retry-with-feedback) |
| `streamText` | ✓ |
| `streamStructured` | ✓ (best-effort partial parse) |
| `runAgent` (multi-turn tool use) | ✓ |
| Vision input — base64 images | ✓ |
| Vision input — URL images | ✓ |
| Audio input | ✗ (Anthropic chat doesn't support audio) |
| Prompt caching | ✓ native; cost reflects `cacheReadPer1M` rate |
| `AbortSignal` cancellation | ✓ entry + in-flight (alpha.6) |
| `listModels()` | ✓ (alpha.9; via direct fetch to `/v1/models`) |
| `dangerouslyAllowBrowser` opt-in | ✓ (alpha.9) |
| Claude 4.5+ temperature auto-strip | ✓ catalog + runtime learning (alpha.3, expanded alpha.10) |
| Embeddings | ✗ (Anthropic ships no embedding models) |

## Content blocks supported

`text`, `image` (base64 + URL), `tool_use`, `tool_result`. The adapter throws `ContentBlockUnsupportedError` for `audio` blocks.

## Cancellation

Full `AbortSignal` support shipped in `0.1.0-alpha.6`. The signal is threaded into both `client.messages.create` (non-streaming) and `client.messages.stream`, so `controller.abort()` cancels the in-flight HTTP request. `runAgent` also re-checks the signal between steps so cancellation propagates mid-loop. See the [Cancellation guide](/guides/cancellation).

## Reading next

- [Tool-use security guide](/guides/security) — `runAgent` code patterns, the destructive / requiresConfirmation / maxOutputBytes flags, the approval-gate wrapper
- [Content blocks reference](/concepts/content-blocks) — `tool_use` and `tool_result` block shapes
- [Anthropic prompt caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) — how cache reads are billed
- [Pricing source](https://www.anthropic.com/pricing) — verify the bundled table is current
