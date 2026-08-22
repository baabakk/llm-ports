# alpha.33 — "Failover that actually fires"

**Status:** In progress. Item 1 shipped, item 2 outstanding.
**Date opened:** 2026-08-21.
**Journal row:** [`RELEASE-JOURNAL.md`](./RELEASE-JOURNAL.md). This release is not finished until that row is filled.

**Why this document exists at all.** It was written *after* work on the release had already started, which is a violation of the rule this project adopted the same day: every release gets a plan document before it ships. Recorded rather than quietly corrected, because the rule came from diagnosing alpha.28, whose scope lived only in a discussion thread and was the one release that silently drifted. Re-committing the same mistake within hours of naming it is worth writing down; it is evidence that the rule needs a mechanical check rather than good intentions.

---

## Why these two items, and why together

Both are the same defect seen from opposite directions: **failover that consumers believe they have and do not.**

Item 1 is shipped code contradicting its own documentation. Item 2 is the announced highest-leverage item of alpha.28, wanted by two consumers, never built. Shipping them apart would mean answering the same design question twice.

This is also the first release of the debt-repayment sequence set out in [`docs/v0-1-status.md`](../docs/v0-1-status.md), and it leads with correctness rather than with features on purpose. Of everything owed, only this one is *actively wrong* rather than merely absent.

---

## Item 1 — Streamed chains must fall back. **Shipped.**

**The defect.** `walkStreamChain` opens a provider's stream inside a `try` and treats a throw as the signal to walk to the next provider. Every adapter implements streaming as an async generator, and calling one returns a generator object **without executing any of its body**. The request that contacts the provider therefore does not happen until the consumer iterates, long after the walker returned.

So the walker saw a healthy open for a dead provider, recorded the attempt, marked the alias authenticated, and returned. The real failure surfaced during consumer iteration, with no chain left to walk.

**Consequence:** `streamText` and `streamStructured` have never fallen back, on any released version. A consumer who configured `runtimeFallback: "aggressive"` across three providers got no failover at all on the streamed methods, and no error, log line, or dropped-event counter said so.

**The fix.** Prime: pull the first event inside the walker's `try`, where a failure can still be acted on, and replay it to the consumer. `primeStream` and `replayPrimed` already existed, added for `streamChat` in alpha.32, which hit this on its very first fallback test.

**Verification.** Eight tests in `packages/core/tests/stream-fallback.test.ts`. **Four of them fail against the pre-fix implementation**, confirmed by stashing the fix and re-running rather than by reasoning about it.

That mattered, because the existing streaming tests all pass either way. They stub providers as arrays, or as generators that yield before failing, and neither shape reproduces the defect: both run the failing line only after the walker has already returned. A test suite that cannot fail on the bug is why this survived to alpha.32.

The suite also covers what a careless fix would break: the primed first chunk must be replayed rather than swallowed, an empty stream must not hang, a mid-stream failure after the first chunk must still reach the consumer, and a provider whose stream never opened must **not** be marked authenticated.

**Commit:** 22709ef.

---

## Item 2 — `AttemptTimeoutError`. **Outstanding.**

**Origin.** Alpha.28 item 1, from ADW finding A and SalesCoach finding B. The migration guide that announced alpha.28 called it that release's "highest-leverage item". It was never built.

**Shape, as originally scoped (~50 LoC).** Introduce `AttemptTimeoutError extends ProviderUnavailableError` in `@llm-ports/core`. `withPerAttemptTimeout` catches the SDK-native abort at the wrapper boundary and re-throws as `AttemptTimeoutError`.

The subclassing is the whole trick: every consumer whose `shouldFallback` already catches `ProviderUnavailableError`, whether through the default classifier, the aggressive preset, or a custom one, gets deadline-triggered failover with **no code change**. Consumers who want to distinguish a timeout from an outage can still `instanceof` the subclass.

**Open design question 1 from discussion #64, now answerable.** The question was whether to subclass `ProviderUnavailableError` or wrap the abort as a generic one. The recommendation was a distinct subclass, and item 1's work supports it with evidence rather than preference: priming proved that consumers cannot currently distinguish "provider never opened" from "provider failed mid-stream", and a distinct class is what makes that distinction available at all. **Adopt the subclass.**

**What to watch.** The per-attempt timeout already exists (`perAttemptTimeoutMs`, shipped alpha.30, which is itself the delivered half of alpha.28 item 7 arriving two releases late). What is missing is only the typed error at the boundary, so this is genuinely small. The risk is not size but interaction: an abort raised by a caller's own `AbortSignal` must **not** be reclassified as a timeout, or a deliberate cancellation would trigger a pointless walk down the whole chain. That distinction needs a test.

---

## Out of scope, deliberately

The other nine unshipped alpha.28 items. They are queued for alpha.34 and are features rather than corrections; mixing them here would make a small verifiable release into an unreviewable one, which is the failure mode this whole sequence exists to avoid.
