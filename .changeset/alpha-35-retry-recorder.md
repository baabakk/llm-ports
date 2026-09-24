---
"@llm-ports/core": minor
---

**`createRetryRecorder`: see recent retries without subscribing to every event.**

```ts
const retries = createRetryRecorder();
const adapters = { openai: createOpenAIAdapter({ apiKey, onRetry: retries.onRetry }) };
retries.recent(10);   // newest first, bounded
```

Bounded by construction, default fifty. The feature exists to look at recent instability, and an unbounded log of every retry a long-running worker performed is a memory leak wearing a feature's clothes. `total` still counts everything seen, so "three retained" is distinguishable from "three out of two hundred".

**Why it is not `registry.recentRetries()`, which is how the ask was phrased.** Retries happen inside adapters: provider backoff, and the retry-with-feedback round when a model returns the wrong shape. The registry's own recovery is walking to the next provider, which is a fallback rather than a retry. Adapters report retries through the `onRetry` hook they are constructed with, and the consumer constructs the adapters, so the registry never sees them. A method on the registry would have had to return nothing useful, or report only fallbacks under a name that says retries.

One recorder can be shared by every adapter, since each event carries its provider alias.

Partially answers alpha.28 item 9 (Dramma). What remains for a registry-level query is that adapters emit retries into the observability stream; that is additive and not scheduled here.
