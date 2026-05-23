---
"@llm-ports/core": minor
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-openai": patch
"@llm-ports/adapter-google": patch
"@llm-ports/adapter-vercel": patch
"@llm-ports/adapter-ollama": patch
---

Two registry-surface improvements that close long-standing v0.1 gaps:

**Registry runtime fallback** — the registry now walks the task's fallback chain on errors matching a configurable predicate. Previously the chain was walked ONLY on budget gating; runtime errors (5xx, network failures, transient outages wrapped as `ProviderUnavailableError`) failed the call instead of trying the next provider. This was the largest functional gap in v0.1 per the status doc.

```ts
const registry = createRegistryFromEnv({
  adapters: { /* ... */ },
  // runtimeFallback: "default", // walks on ProviderUnavailableError (the default)
  // runtimeFallback: "none",    // disables; preserves v0.1 behavior
  // runtimeFallback: { shouldFallback: (err) => err instanceof MyCustomError }, // custom
});
```

Cost recording happens ONLY on the successful provider. The chain walk respects per-provider budget gates — if `fast` is over budget AND fails, the registry walks to `backup`. Streaming methods walk only on synchronous stream-creation failure (not mid-iteration), since switching providers mid-stream would emit a confusing mix.

**`forceProviderAlias` per-call option** (closes [#15](https://github.com/baabakk/llm-ports/issues/15)) — every `*Options` interface gains `forceProviderAlias?: string`. Setting it routes directly to the named provider, bypassing the `LLM_TASK_ROUTE_*` lookup. Per-provider budget gates still apply (so you can't bypass a hard cap); runtime fallback does NOT engage (caller explicitly picked this provider, falling back would defeat the point). Useful for toolbars where the operator picks the model, or for one-off "use the expensive model for this single call" patterns.

```ts
await llm.generateText({
  taskType: "describe",
  prompt: "...",
  forceProviderAlias: userSelectedProvider, // bypasses task routing
});
```

**New exports** from `@llm-ports/core`: `Registry.selectByAlias()`, `Registry.selectViableChain()`, `Registry.shouldFallback`.

**Adapter patch bumps**: no code change — adapters pick up the new `forceProviderAlias` field on `*Options` automatically via core's peer-dep type re-export.

13 new tests (8 runtime-fallback + 5 forceProviderAlias). The `registry-edges.test.ts` test that documented "runtime ProviderUnavailableError propagates and does NOT trigger fallback (TD-LLMP-09)" has been inverted to assert the new behavior.
