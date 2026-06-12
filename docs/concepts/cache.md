# Cache control

The three major LLM providers expose prompt caching through three different mechanisms. Anthropic uses explicit `cache_control` markers on message-content blocks. OpenAI applies an implicit, automatic prompt cache with no opt-in or opt-out. Google Gemini exposes a `createCachedContent` flow that returns a handle the caller passes on subsequent requests.

`@llm-ports` normalizes these three patterns behind a single shape that the caller sets once and the adapter translates per provider. The shape locks in `alpha.19` so callers can write against it before `beta.0`.

## The shape

```ts
interface CacheControl {
  mode: "auto" | "manual" | "preCreated" | "off";
  ttlSeconds?: number;
  breakpoints?: Array<{ at: "tools" | "system" | "message-index"; index?: number }>;
  cachedContentHandle?: string;
  namespace?: string;
}
```

`cacheControl` is an optional field on every request option type: `GenerateTextOptions`, `GenerateStructuredOptions`, `StreamTextOptions`, `StreamStructuredOptions`, `RunAgentOptions`. Omitting it is the same as `{ mode: "auto" }`: the adapter does whatever its provider does by default.

## The four modes

### `mode: "auto"`

Let the adapter decide. The right default for most callers.

- **Anthropic**: place a `cache_control` marker at the last static block when one is identifiable (system prompt or first user-turn). Beta minors will mature the static-block detector.
- **OpenAI**: no-op. OpenAI's prompt cache is implicit and always on; no API to influence it.
- **Google Gemini**: no-op. Without `cachedContentHandle`, no cache is engaged.

### `mode: "manual"`

The caller supplies explicit `breakpoints`. The adapter places `cache_control` markers at the named positions.

```ts
const cacheControl: CacheControl = {
  mode: "manual",
  breakpoints: [
    { at: "tools" },
    { at: "system" },
    { at: "message-index", index: 4 },
  ],
  ttlSeconds: 3600,
};
```

- **Anthropic**: places markers at the named positions. `ttlSeconds: 3600` requests the 1-hour cache tier; `ttlSeconds: 300` requests the 5-minute tier; other values fall back to `300`.
- **OpenAI** and **Google Gemini**: no-op.

### `mode: "preCreated"`

The caller supplies a `cachedContentHandle` returned from a previous `createCachedContent` call. The adapter sends the handle as the source of the cached content.

```ts
const cacheControl: CacheControl = {
  mode: "preCreated",
  cachedContentHandle: "projects/.../cachedContents/abc123",
};
```

- **Google Gemini**: required. The adapter sends the handle to the provider.
- **Anthropic** and **OpenAI**: no-op.

### `mode: "off"`

The caller opts out where the provider allows it.

- **Anthropic**: strip `cache_control` from message blocks for this call only.
- **OpenAI** and **Google Gemini**: no-op (no API to disable their caching).

## Per-call namespace

`namespace` partitions cache lookups by tenant or customer when the request flows through a caching proxy that supports partition keys. Helicone's `Cache-Seed` header is the reference pattern.

```ts
const cacheControl: CacheControl = {
  mode: "auto",
  namespace: "tenant:acme-corp",
};
```

When the adapter is configured to forward proxy headers, it forwards `namespace` verbatim. Otherwise the field is ignored. `namespace` never changes the provider request body, so it is safe to set unconditionally.

## Reading cache effect from the result

Every result object carries `usage` and `cost`. Cache effects show up in both:

```ts
const result = await port.generateText({
  taskType: "summary",
  prompt: longContext,
  cacheControl: { mode: "auto" },
});

// Tokens that came from cache vs were freshly read
result.usage.cacheReadTokens;    // 80_000
result.usage.cacheWriteTokens;   // 0

// USD saved by the cache hit, vs paying the full input rate
result.cost.cacheSavingsUSD;     // 0.216
result.cost.totalUSD;            // total bill for this call
```

`cacheSavingsUSD` is populated whenever the provider returns cache telemetry (`cacheReadTokens > 0`). When no cache reads occurred, the field is `undefined`.

## Per-provider behavior summary

| Mode | Anthropic | OpenAI | Google Gemini |
|---|---|---|---|
| `auto` | place marker at last static block | no-op (implicit cache always on) | no-op |
| `manual` | place markers at supplied breakpoints | no-op | no-op |
| `preCreated` | no-op | no-op | required; uses `cachedContentHandle` |
| `off` | strip `cache_control` from message blocks | no-op (no API to disable) | no-op (no API to disable) |
| `namespace` | forwarded via proxy headers when configured | forwarded via proxy headers when configured | forwarded via proxy headers when configured |
| `ttlSeconds` | 300 or 3600; else falls back to 300 | ignored | passed through to Gemini API |

## When the field name moved (alpha.19)

The result field `cost.cacheDiscountUSD` was renamed to `cost.cacheSavingsUSD` in `alpha.19`. The previous name implied a vendor-applied discount, which obscured that the value is the caller-visible reduction in their bill regardless of how the provider books it internally. The OpenInference `llm.cost.cache_savings` convention and Helicone's dashboard vocabulary use "savings" for the same concept. See the [alpha.18 → alpha.19 migration guide](../migration/alpha-18-to-alpha-19.md).

## Shape stability promise

The shape locks at `alpha.19`. Per-mode adapter behaviors mature across beta minors without breaking the shape:

- Full breakpoint placement logic for Anthropic.
- Gemini `createCachedContent` handle lifecycle helpers in `@llm-ports/capabilities`.
- Helicone and other proxy header bridges for `namespace`.

If you write callers against this shape today, the breakpoint placement Anthropic does in `beta.1` will simply be "more correct" placement of the same markers your caller already specified. Your call sites will not change.
