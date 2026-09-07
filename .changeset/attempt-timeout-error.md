---
"@llm-ports/core": minor
---

Add `AttemptTimeoutError`, so a blown per-attempt deadline triggers failover instead of ending the call.

`perAttemptTimeoutMs` has aborted the attempt since alpha.30, but the abort reached the caller as whatever the provider SDK raises, so the chain stopped there. A deadline that stops a call without buying the failover it implies is the opposite of what a chain is for.

Timeouts now raise `AttemptTimeoutError`, which **extends `ProviderUnavailableError`**. That subclassing is the whole mechanism: every consumer whose fallback predicate already accepts `ProviderUnavailableError`, through the default preset, the aggressive preset, or a hand-written classifier, gets deadline-triggered failover with no code change. Consumers who need to tell a timeout from an outage can test the subclass, and read `timeoutMs` and `cause` off it.

Announced as alpha.28's highest-leverage item, asked for by two consumers, unbuilt until now.

**A cancellation you requested is never reclassified.** The deadline and the caller's own `AbortSignal` abort the same controller, so they are indistinguishable from the resulting error alone; the classification is made from which trigger fired, and the caller's signal wins any race. Reclassifying a cancellation would have walked the entire remaining chain after someone explicitly asked to stop, spending money on every provider in it.

Classification is deliberately not gated on the error looking like an abort. SDKs disagree about that shape, using `AbortError`, the signal's `reason`, or their own class, and gating on a set we cannot enumerate is how a feature ships looking complete while firing for only some providers.

**Behaviour change if you relied on a timeout ending the call.** It now walks. Set `runtimeFallback: "none"` for the previous behaviour, or catch `AttemptTimeoutError`. Note that an exhausted chain still surfaces `NoProvidersAvailableError`, with the timeout recorded in its `reasons`; the typed error surfaces directly when there is nowhere left to walk, such as a `forceProviderAlias` call.
