---
"@llm-ports/core": minor
---

**`onComplete`: one event per call, carrying what it cost and how many providers it took.**

```ts
observability: {
  onComplete: (e) => metrics.record(e.operation, e.providerAttempts, e.totalUsd, e.ok),
}
```

Previously that picture was assembled by correlating `onCost` and `onTokenUsage` with an attempt count the caller kept itself.

**It fires on failure as well as success**, with `ok: false`, the error, and the attempt count. A completion hook that only fired on success would describe a healthier system than the real one, and reliability is the reason to turn it on.

`providerAttempts` counts every provider tried, including the one that answered, so `1` means the first choice served it and more means the chain walked. `totalUsd` and `usage` are **absent rather than zero** when there is nothing to report, so failures cannot inflate a spend total and an unknown price stays distinguishable from a free call. Like every hook here it is fire-and-forget: anything it throws is swallowed, because observability never breaks the call it observes.

Wired for `generateText` and `generateChat` in this release. The other methods follow the same shape and are additive to add.

Asked for by ADW and SalesCoach as alpha.28 item 2, owed since July.
