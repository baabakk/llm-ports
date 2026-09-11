# Alpha.28 scoping: observability contract foundation

Filing a scoping update for alpha.28 (target 2026-08-05) after the cross-consumer review pass completed 2026-07-21. This narrows the release to a **contract-foundation-only** scope and points at the concrete implementation TDs already filed in this repo.

## What alpha.28 ships

A new package: `@llm-ports/observability-contract@0.1.0`, published alongside `@llm-ports/core@0.1.0-alpha.28`.

The package contains **only**:
- Plain TypeScript types for the event envelope, correlation model, lifecycle events, error info, cache stats, prompt fingerprint, evaluation refs, capture policy, and W3C Trace Context + Baggage shapes.
- Zod validation schemas for every event type.
- Canonicalization helpers (prompt normalization, hash computation).
- ID helpers (nanoid-based generators).
- Golden vectors in `test-vectors.json` for canonicalization determinism.

**Zero runtime instrumentation at alpha.28.** Adapters do not emit contract events yet. That work lands in alpha.29 (runtime instrumentation), alpha.30 (streaming + OTel), and alpha.31 (persistence + consumer cutovers). Rationale: get the contract right before hardwiring it.

## Concrete implementation deliverables (already filed as TDs)

Five TDs in `TECH-DEBT.md` map to the alpha.28 scope:

- **TD-LLMP-16.** `adapter-openai` `ContextWindowExceededError` reports `model "(unknown)"` even when the model name is at request-construction time. Small point fix; ships as alpha.28 pre-work.
- **TD-LLMP-17.** `runAgent` throws raw TypeError when `tools` omitted, and local TypeErrors get misclassified as `ServiceUnavailableError` triggering futile chain-wide failover. Introduces new typed class `AdapterInternalError` with `fallback_worthy: false`.
- **TD-LLMP-18.** `attemptValidationRepair` should normalize Unicode confusables (dashes, quotes, spaces) on `invalid_enum_value` Zod errors before retry. Schema-aware fix; content-preserving.
- **TD-LLMP-19.** Publish canonical walk-table plus two new typed classes (`CreditExhaustionError`, `ProviderMalformed400Error`) so consumers stop hand-coding wrong failover policies. Export `defaultShouldFallback`.
- **TD-LLMP-20.** Registry needs a capability-based router (declarative `TaskRequirements` + `ProviderCapabilities` + boot-time chain resolution). Queued for alpha.29 or alpha.30 depending on scope decisions; not on the alpha.28 hook but named here for visibility.

## Design decisions locked in for alpha.28

1. **Separate `@llm-ports/observability-contract` package.** Not a subpath of `@llm-ports/core`. Rationale: non-port callers can import the contract types without pulling in the registry code path (mirror the neutral-core + opt-in-companions pattern the observability adapters already use).
2. **Four-release cadence.** alpha.28 contract foundation only; alpha.29 runtime instrumentation; alpha.30 streaming + OTel adapter; alpha.31 persistence adapters + consumer cutovers. Deliberately conservative: get the contract right before wiring it.
3. **Correlation ingress via `withObservabilityContext(port, context)` scoped-port wrapper.** No changes to the `LLMPort` interface. Caller-provided context flows in via the wrapper; the port generates `operation_id` and per-attempt `attempt_id`s.
4. **HMAC in alpha.28 core** via `hash_algorithm: "sha256" | "hmac-sha256"` on the fingerprint. Default `sha256`; consumers in regulated environments (healthcare, finance) opt in to HMAC.

## Related ecosystem discussions

- Discussion #69 (Ideas) posted 2026-07-21 covers the `@llm-ports/tools-*` companion family (sandboxed file I/O, HTTP, exec, search primitives). Separate architectural direction; not on the alpha.28 hook. Feedback welcome there separately.

## For consumers

The alpha.28 scope is the taxonomy contract only. No runtime behavior changes. Your existing hooks (`OnTokenUsage`, `OnCost`, `OnFallback`, `OnCacheHit`, `OnValidationRetry`, `StreamCompleteCallback`) stay working through alpha.29. Consumer cutovers to `defaultShouldFallback` and the new typed classes happen at alpha.31.

Discussion open for scope pushback until the alpha.28 tag lands.

## Provenance

Cross-consumer review pass 2026-07-21 (BEPA + ADW as the two reporting consumers).
