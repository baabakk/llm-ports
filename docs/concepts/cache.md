# Cache control

The three major LLM providers expose prompt caching through three different mechanisms. Anthropic uses explicit `cache_control` markers on message-content blocks. OpenAI applies an implicit, automatic prompt cache with no opt-in or opt-out. Google Gemini exposes a `createCachedContent` flow that returns a handle the caller passes on subsequent requests.

`@llm-ports` normalizes those three patterns behind a single shape. The shape locked in `0.1.0-alpha.19`. End-to-end per-mode behavior on the cloud adapters + pass-through on every capability factory landed in `0.1.0-alpha.19.1`.

## The shape

```ts
import type { CacheControl } from "@llm-ports/core";

interface CacheControl {
  mode: "auto" | "manual" | "preCreated" | "off";
  ttlSeconds?: number;
  breakpoints?: Array<{ at: "tools" | "system" | "message-index"; index?: number }>;
  cachedContentHandle?: string;
  namespace?: string;
}
```

`cacheControl` is an optional field on every request option type: `GenerateTextOptions`, `GenerateStructuredOptions`, `StreamTextOptions`, `StreamStructuredOptions`, `RunAgentOptions`. Omitting it is equivalent to `{ mode: "auto" }` plus the adapter's default behavior (which is currently a no-op for everyone except Anthropic).

The same field is accepted on every capability factory's per-call input (`ClassifyInput`, `ScoreInput`, `ExtractInput`, `DraftInput`, `SummarizeInput`, `AnalyzeInput`, `PlanInput`) and forwarded to the underlying port call unchanged.

## What each mode actually does (verified, alpha.19.1)

### Anthropic (`@llm-ports/adapter-anthropic`)

| Mode | Effect on the SDK request | Verified in |
|---|---|---|
| `auto` | Promote `system: string` → `system: [{ type: "text", text, cache_control: { type: "ephemeral", ttl? } }]` when `instructions` is set. When no `instructions`, no-op. | `tests/quirks/cache-control.test.ts` |
| `manual` | Place markers at each supplied breakpoint: `{ at: "system" }` on the system block, `{ at: "tools" }` on the last tool in the tools array, `{ at: "message-index", index }` on the last content block of `messages[index]` (promoting string content to a structured array when needed). With no breakpoints, falls back to system placement. | `tests/quirks/cache-control.test.ts` |
| `preCreated` | No-op. Anthropic has no `createCachedContent` handle pattern. | `tests/quirks/cache-control.test.ts` |
| `off` | No-op (the adapter never emits `cache_control` unbidden, so "off" matches the natural default). | `tests/quirks/cache-control.test.ts` |
| `ttlSeconds: 3600` | Emits `cache_control: { type: "ephemeral", ttl: "1h" }`. | `tests/quirks/cache-control.test.ts` |
| `ttlSeconds: 300` or undefined | Omits `ttl` from the marker (Anthropic default 5m). | `tests/quirks/cache-control.test.ts` |

### Google Gemini (`@llm-ports/adapter-google`)

| Mode | Effect on the SDK request | Verified in |
|---|---|---|
| `auto` | No-op. Gemini has no caller-controllable equivalent — the adapter intentionally does nothing rather than silently switching to a different mechanism. | `tests/quirks/cache-control.test.ts` |
| `manual` | No-op. | `tests/quirks/cache-control.test.ts` |
| `preCreated` with `cachedContentHandle` | Sets `config.cachedContent = cachedContentHandle` on the `generateContent` call. | `tests/quirks/cache-control.test.ts` |
| `preCreated` without a handle | No-op. The cached-content creation flow is a separate API surface that ships in `@llm-ports/capabilities` in beta.2; until then callers must `cachedContents.create()` themselves. | `tests/quirks/cache-control.test.ts` |
| `off` | No-op (no API to disable Gemini's caching). | `tests/quirks/cache-control.test.ts` |

### OpenAI (`@llm-ports/adapter-openai`) and OpenAI-compatible providers

Every mode is a no-op. OpenAI's prompt cache is implicit and always on; there is no API to influence it. The field is accepted on every request so callers can write forward-compatible code, but no markers are emitted.

OpenAI's compat-via-`baseURL` providers (Cerebras, Groq, Fireworks, Together AI, SambaNova, etc.) inherit this behavior.

### Ollama (`@llm-ports/adapter-ollama`)

Every mode is a no-op. Local models do not have a billed prompt cache surface.

### Vercel bridge (`@llm-ports/adapter-vercel`)

Every mode is a no-op at this layer. If the bridged provider supports caching, configure it through that provider's own knobs; the `cacheControl` field is accepted but not forwarded to the underlying Vercel AI SDK call.

## Per-call namespace

`namespace` is accepted on the shape but is not currently forwarded by any adapter. Helicone-style proxy header forwarding for `namespace` is the canonical example and ships in beta.2 alongside the pluggable `CacheBackend`. Setting `namespace` today does no harm — adapters ignore it and the field is forward-compatible for callers writing against the locked shape.

## Reading cache effect from the result

Every result object carries `usage` and `cost`. Cache effects show up in both:

```ts
const result = await port.generateText({
  taskType: "summary",
  instructions: longSystemPrompt,
  prompt: shortUserTurn,
  cacheControl: { mode: "auto", ttlSeconds: 3600 },
});

// Tokens that came from cache vs were freshly read
result.usage.cacheReadTokens;    // e.g. 80_000
result.usage.cacheWriteTokens;   // e.g. 0

// USD saved by the cache hit, vs paying the full input rate
result.cost.cacheSavingsUSD;     // e.g. 0.216
result.cost.totalUSD;            // total bill for this call
```

`cacheSavingsUSD` is populated whenever the provider returns cache telemetry (`cacheReadTokens > 0`). When no cache reads occurred, the field is `undefined`.

Capability factories carry the same field on their `onResult` event:

```ts
const classify = createClassifier({
  port,
  schema: IntentSchema,
  schemaName: "intent",
  onResult: (event) => {
    console.log(event.cost.cacheSavingsUSD);   // present when the underlying port returned cache telemetry
  },
});
```

## Worked example: Anthropic auto mode

```ts
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

const adapter = createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
const port = adapter.createLLMPort("claude-opus-4-7", "claude-opus");

const result = await port.generateText({
  taskType: "longform-summary",
  instructions: theBookEqualsLongSystemPrompt,
  prompt: thisTurnsShortUserQuestion,
  cacheControl: { mode: "auto", ttlSeconds: 3600 },
});
```

The adapter sends:

```jsonc
{
  "model": "claude-opus-4-7",
  "max_tokens": 1024,
  "system": [
    { "type": "text", "text": "<theBookEqualsLongSystemPrompt>", "cache_control": { "type": "ephemeral", "ttl": "1h" } }
  ],
  "messages": [{ "role": "user", "content": "<short user turn>" }]
}
```

On the second call with the same system prompt, Anthropic serves the cached prefix at the read rate and reports `cache_read_input_tokens` in the response. Our adapter populates `result.usage.cacheReadTokens` from that field and computes `result.cost.cacheSavingsUSD` against the pricing table.

## Worked example: Gemini `preCreated`

```ts
import { GoogleGenAI } from "@google/genai";
import { createGoogleAdapter } from "@llm-ports/adapter-google";

const genai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
const cached = await genai.cachedContents.create({
  config: {
    contents: [{ role: "user", parts: [{ text: longContext }] }],
    systemInstruction: longSystemPrompt,
    ttl: "3600s",
  },
  model: "gemini-2.5-flash",
});

const adapter = createGoogleAdapter({ apiKey: process.env.GOOGLE_API_KEY! });
const port = adapter.createLLMPort("gemini-2.5-flash", "gemini");

const result = await port.generateText({
  taskType: "longform-qa",
  prompt: thisTurnsShortQuestion,
  cacheControl: { mode: "preCreated", cachedContentHandle: cached.name! },
});
```

The adapter sends `config.cachedContent = cached.name` on the `generateContent` call. Gemini serves the cached prefix and reports `cachedContentTokenCount` in `usageMetadata`; our adapter populates `result.usage.cacheReadTokens` from that field and computes `cacheSavingsUSD`.

The cached-content lifecycle helper that wraps `cachedContents.create()` ships in `@llm-ports/capabilities` in beta.2. Until then callers manage the handle themselves (per the example above).

## Shape stability promise

The shape locked in alpha.19. The per-mode behaviors documented above are verified in alpha.19.1. Future beta minors will extend behaviors without breaking the shape:

- `namespace` proxy header forwarding (Helicone) — beta.2.
- Gemini `createCachedContent` lifecycle helper — beta.2.
- Tools-array breakpoint placement on Anthropic when no tools are supplied at the time of the call (no-op today, friendlier diagnostic in beta.1).

If you write call sites against this shape today, your code does not change as those behaviors land.

## When the field name moved (alpha.19)

The result field `cost.cacheDiscountUSD` was renamed to `cost.cacheSavingsUSD` in alpha.19. The previous name implied a vendor-applied discount, which obscured that the value is the caller-visible reduction in their bill regardless of how the provider books it internally. The OpenInference `llm.cost.cache_savings` convention and Helicone's dashboard vocabulary use "savings" for the same concept. See the [alpha.18 → alpha.19 migration guide](../migration/alpha-18-to-alpha-19.md).
