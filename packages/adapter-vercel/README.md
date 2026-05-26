# @llm-ports/adapter-vercel

[Vercel AI SDK](https://www.npmjs.com/package/ai) adapter for [llm-ports](https://github.com/baabakk/llm-ports). Migration helper for users already using `@ai-sdk/*`.

## Why this adapter exists

If you've already wired your project around `@ai-sdk/anthropic`, `@ai-sdk/openai`, etc., you can adopt llm-ports without rewriting that integration. This adapter takes your pre-configured Vercel `LanguageModel` instances and routes `LLMPort` calls through Vercel's `generateText`, `streamText`, `embed`, and `embedMany` helpers. You get cost gating, fallback chains, and capability factories on top of the stack you already have.

For new projects, prefer the direct adapters (`@llm-ports/adapter-anthropic`, `@llm-ports/adapter-openai`, `@llm-ports/adapter-google`) — fewer layers, more control.

## Install

```bash
pnpm add @llm-ports/core @llm-ports/adapter-vercel ai @ai-sdk/anthropic
```

## Configure

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createRegistryFromEnv } from "@llm-ports/core";
import { createVercelAdapter } from "@llm-ports/adapter-vercel";

const registry = createRegistryFromEnv({
  adapters: {
    vercel: createVercelAdapter({
      models: {
        "claude-sonnet-4-6": anthropic("claude-sonnet-4-6"),
        "gpt-5": openai("gpt-5"),
      },
      embeddingModels: {
        "text-embedding-3-small": openai.textEmbeddingModel("text-embedding-3-small"),
      },
      // pricing is optional in alpha.8+ — bundled VERCEL_PRICING covers common
      // @ai-sdk/* models. Supply pricingOverrides only for missing entries.
    }),
  },
});

const llm = registry.getPort();
```

`.env`:

```
LLM_PROVIDER_FAST=vercel|claude-sonnet-4-6|cost:50/day
LLM_PROVIDER_GPT=vercel|gpt-5|cost:100/day
LLM_TASK_ROUTE_TRIAGE=fast,gpt
```

## Adapter options

```ts
interface VercelAdapterOptions {
  models?: Record<string, LanguageModel>;             // pre-configured @ai-sdk/* instances
  embeddingModels?: Record<string, EmbeddingModel<string>>;
  pricing?: Record<string, ModelPricing>;             // optional; merges over VERCEL_PRICING
  validationStrategy?: ValidationStrategy;
  imageSizeLimitBytes?: number;                       // default 20 MB
  onRetry?: OnRetry;                                  // observability hook
}
```

### Browser execution

This adapter does NOT expose its own `dangerouslyAllowBrowser` option, because the underlying provider client is constructed by you when you build the `LanguageModel` instance. For browser execution, pass the SDK's flag at LanguageModel construction time:

```ts
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({
  apiKey: ephemeralUserKey,
  dangerouslyAllowBrowser: true,        // ← set this on the @ai-sdk/* client
});

const adapter = createVercelAdapter({
  models: { default: openai("gpt-5") },
});
```

The same pattern applies to `@ai-sdk/anthropic` (and any other browser-restricted SDK). The `adapter-openai` and `adapter-anthropic` packages expose the flag directly because they construct the SDK client internally.

## Bundled pricing

`VERCEL_PRICING` (alpha.8+) covers the common OpenAI / Anthropic / Google models used via `@ai-sdk/*`. Values mirror the direct adapters' bundled tables. For uncommon `@ai-sdk/*` providers (LMStudio, OpenRouter, perplexity-ai, custom routes), supply `pricing` entries yourself.

## Supported features

| Feature | Status |
|---------|--------|
| `generateText` | ✓ |
| `generateStructured` (Zod schemas) | ✓ (prompted JSON + retry-with-feedback + alpha.5 repair pass) |
| `streamText` | ✓ |
| `streamStructured` (partial JSON) | ✓ (best-effort partial parse) |
| `runAgent` (multi-turn) | ✓ (alpha.8+; via Vercel's native `tools` + `maxSteps` loop) |
| `generateEmbedding` / `generateEmbeddings` | ✓ |
| Multimodal content blocks | ✓ (alpha.8+; via Vercel `MessagePart[]` shape) |
| `AbortSignal` cancellation | ✓ entry + in-flight (alpha.6) |

## Content blocks supported

`text`, `image` (base64 → data URI; URL → passthrough), `audio` (base64 → Vercel `file` part), `tool_use`, `tool_result`. Throws for URL-form audio (Vercel routes audio via file-data; pass base64 + mediaType instead).

## Cancellation

Full `AbortSignal` support shipped in `0.1.0-alpha.6`. The signal is passed through to Vercel's `abortSignal` field on `generateText` / `streamText`, so `controller.abort()` cancels the in-flight provider HTTP request (the cancellation propagates from Vercel to the underlying provider SDK). See the [Cancellation guide](https://baabakk.github.io/llm-ports/guides/cancellation).

## Known limitations

- **No reasoning-model headroom-multiplier.** Unlike `adapter-openai`, the Vercel adapter doesn't apply a 10× headroom for OpenAI o-series / gpt-5-nano / Cerebras gpt-oss when called with small `maxOutputTokens`. The Vercel adapter does retry on `finishReason: "length"` with empty text + reasoning signal (alpha.1 fix #4), but it doesn't pre-seed the multiplier. **Workaround**: set `maxOutputTokens` 5-10× higher than your visible-output budget, or use `@llm-ports/adapter-openai` directly for reasoning models in v0.1.

## When to use this vs the direct adapters

| Scenario | Choose |
|---|---|
| Already on `@ai-sdk/*` and want to add llm-ports | This adapter |
| New project | `adapter-anthropic` / `adapter-openai` / `adapter-google` directly |
| Need full multimodal richness (Anthropic prompt-caching, Gemini context-caching, etc.) | Direct adapters expose those; Vercel abstracts them away |

## Reading next

- [Vercel adapter docs](https://baabakk.github.io/llm-ports/adapters/vercel) — full feature deep-dive
- [Migration from Vercel AI SDK guide](https://baabakk.github.io/llm-ports/migration/from-vercel-ai) — two migration paths (wrap vs. replace)
- [Adapter feature matrix](https://baabakk.github.io/llm-ports/adapters/) — direct adapter comparison
