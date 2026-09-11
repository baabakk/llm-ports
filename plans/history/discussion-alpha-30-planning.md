**Status:** Planning discussion. Target ship 2026-09-02 (two weeks after alpha.29). Extendable to 2026-09-16 if design questions surface.

**Theme:** Persistent backends + caching. Two items; each is substantial enough to be its own release note but they pair thematically (both close the "state that survives restart" gap).

**Prior release:** alpha.29 (planned 2026-08-19; capability factory ergonomics; see planning discussion filed alongside).

---

## What ships in alpha.30

Two items, both larger than the alpha.28 / alpha.29 median scope.

### Item 1 — Content-result cache primitive

Consumer: ADW (E). Also aligns with SalesCoach's response-caching hand-roll for coaching cue prompts.

**Current gap.** `fingerprintCache` shipped in alpha.24 caches per-provider behavioral fingerprints (reasoning-model discovery outcomes) across restarts. There is no analogous cache for actual LLM response content. Consumers that want to cache "same prompt + same schema + same task → same result" wrap `generateText` on the app side with a SHA-256 keyed store; caching is uneven across `generateText` / `generateStructured` / stream methods.

**Fix shape.**

`RegistryOptions.contentCache?: ContentCacheBackend` analogous to `fingerprintCache`. Bundled backends:

- `InMemoryContentCache(opts?: { maxEntries?, ttlMs? })` — dev / test / short-worker default.
- `FileContentCache(path, opts?)` — atomic JSON, persistent across restart.
- `RedisContentCache(client, opts?)` — cross-worker; requires the alpha.30 `@llm-ports/budget-redis`-style optional peer dep pattern.

Consumer implements `ContentCacheBackend` for custom stores (S3, DynamoDB, Postgres, etc.).

**Cross-method wiring.** `generateText`, `generateStructured`, `streamText`, `streamStructured`. NOT `runAgent` — multi-turn state complicates cache-key correctness; skip until a follow-up.

**Cache key.** SHA-256 of a canonical serialization: `{ taskType, model_alias, messages, options.schema?.description, options.temperature?, options.maxOutputTokens?, options.reasoningEffort?, options.refs, options.strict?, options.cacheControl }`. Refs go in the key so `{ prompt: {key, version} }` variants don't collide. Consumers can override via `contentCache: { keyDerivation: (opts) => string }`.

**Semantics.** On hit: adapter is bypassed entirely; the cached result is returned with `cacheHit: true` in the observability event. Onmiss: adapter is called; result is stored before returning.

**Estimated:** ~300 LoC (interface + three bundled backends + cross-method wiring + tests + conformance suite for BYO-backend).

### Item 2 — `@llm-ports/budget-redis` package

Consumer: BEPA (9).

**Current gap.** `@llm-ports/core` ships `InMemoryBudget` and `InMemoryCost` as the default backends for `BudgetBackend` and `CostBackend`. Both reset on worker restart. Every serious consumer that wants cost limits to survive deploys writes the same Redis `INCR`/`EXPIRE` logic against those interfaces.

**Fix shape.**

New optional peer package `@llm-ports/budget-redis`. Two factories:

- `createRedisBudget(client: RedisClient, opts?: { keyPrefix? })` returns `BudgetBackend`.
- `createRedisCost(client: RedisClient, opts?: { keyPrefix? })` returns `CostBackend`.

Both implement the existing `BudgetBackend` / `CostBackend` interfaces from `@llm-ports/core` unchanged. Consumers wire `createRegistryFromEnv({ budget: createRedisBudget(client), cost: createRedisCost(client) })`.

**Redis contract.** Uses `INCR` + `EXPIRE` for the per-hour / per-minute counters. Uses a Lua script for the atomic cost check-and-record. Requires Redis 5+ (any modern hosted instance).

**Cross-worker semantics.** Multiple workers sharing a Redis instance see a single global budget. Restart-safe: the Redis keys survive process cycles. TTL-aligned: `req:100/hour` correctly expires after 1 hour of quiet time.

**Optional dep pattern.** `ioredis` is an optional peer dep (`peerDependenciesMeta.optional`), consistent with how `@llm-ports/adapter-anthropic` treats `@anthropic-ai/sdk`. Consumers install `ioredis` or `redis` themselves.

**Estimated:** ~250 LoC across the package + tests + `docs/adapters/budget-redis.md`.

### Item 3 (bonus) — Item 2 subsumes named-session persistence from alpha.29

Alpha.29's Item 8 (named sessions) ships as Registry-in-memory. If `@llm-ports/budget-redis` also ships a `createRedisSessionStore(client)`, cross-worker session lookup lands automatically. Recommend adding `createRedisSessionStore` to the alpha.30 package if the design review agrees.

---

## Open design questions

1. **Content cache: cache-control opt-out per-call.** Should consumers be able to disable caching per-call (e.g. for time-sensitive tool-use continuations)? **Recommendation:** yes, via `bypassContentCache?: boolean` on call options; opt-out is per-call.
2. **Content cache: streaming semantics.** Cache the concatenated stream output and replay as a single chunk on hit, OR cache chunk-by-chunk and replay chunks? **Recommendation:** concatenated + single-chunk replay for alpha.30; per-chunk replay in a follow-up if consumers ask.
3. **`@llm-ports/budget-redis` vs `@llm-ports/backend-redis`.** Naming: budget-redis is precise but excludes the session-store use case in Item 3. **Recommendation:** name it `@llm-ports/backend-redis` and ship budget + cost + session-store factories from one package.
4. **Cache key includes provider alias?** If cached response was produced by `gptoss-cerebras` and consumer forces `forceProviderAlias: "gpt5"` on the retry, is the cache hit valid? **Recommendation:** NO — cache key includes the resolved provider alias; forced-alias variants get their own cache entry.
5. **Alpha.30 target ship date.** 2026-09-02 (two weeks after alpha.29) VERSUS 2026-09-16 (four weeks). **Recommendation:** 2026-09-02 base; extend to 2026-09-16 if the ContentCacheBackend interface design surfaces new questions during alpha.29 execution.

---

## Consumer credit

- **ADW**: E (content-result caching).
- **BEPA**: 9 (Redis budget backends).

Both consumers documented the pattern in their production code; both hand-rolled the same shape independently. The alpha.30 theme takes the two patterns and moves them behind first-class backends.

---

## Cross-references

- Alpha.28 planning: filed alongside.
- Alpha.29 planning: filed alongside.
- Alpha.31 planning: filed alongside.
- Consumer inputs synthesized in the alpha.27 release plan §A.11 (published post-alpha.27 ship).

Post design-question answers below by 2026-08-26 for baseline scope.
