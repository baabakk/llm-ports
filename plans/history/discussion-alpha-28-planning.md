**Status:** Planning discussion. Target ship 2026-08-05 (two weeks after alpha.27). Extendable to 2026-08-19 if design questions surface.

**Theme:** Reliability + observability polish. Sixteen items synthesized from independent findings by four consumers (ADW, SalesCoach, BEPA, Dramma).

**Prior release:** alpha.27 (planned 2026-07-22; removes deprecated `instructions?` / `prompt?` fields; see release plan).

---

## What ships in alpha.28

Sixteen items grouped by leverage. Every item is scoped ≤200 LoC + tests; no item requires a design pass beyond the open questions below.

### Cross-consumer items (multiple asks)

1. **Per-attempt deadline auto-triggers failover** (ADW A + SalesCoach B). Introduces `AttemptTimeoutError extends ProviderUnavailableError` in `@llm-ports/core`. Modifies `withPerAttemptTimeout` in `registry.ts` to catch the SDK-native abort at the wrapper boundary and re-throw as `AttemptTimeoutError`. Every consumer whose `shouldFallback` catches `ProviderUnavailableError` (default OR aggressive OR custom classifiers that walk on it) automatically gets deadline-triggered failover. ~50 LoC.
2. **Combined `onComplete(event)` hook** (ADW C + SalesCoach C). Additive; fires alongside `onCost` + `onTokenUsage`. Combined event payload: usage, cost, refs, operation, modelId, providerAlias, taskType, budgetScope, latencyMs. ~30 LoC.
3. **Registry-level `pricingOverrides`** (BEPA 10 + SalesCoach in-tree 4). `createRegistryFromEnv({ pricingOverrides })` accepts one global table; per-adapter overrides still supported (per-adapter wins). ~50 LoC.

### Reliability items

4. **Per-scope total budget ceiling** (ADW B). Extends `BudgetScopeRef` to `{ scope, scopeId, totalTokens?, totalUSD? }`. Registry-level accumulator; throws `SessionBudgetExceededError`. Composes with per-provider gates. ~150 LoC.
5. **Adapter-openai opaque-400 detection** (ADW D). Extends `learnConstraintsFromError` to match `status === 400 && body.length < 20 && request.response_format?.strict === true` as a `jsonModeUnsupported` capability signal; triggers strict-mode downgrade retry. ~40 LoC.
6. **Integrated local JSON repair before retry-with-feedback** (SalesCoach E). Extends `attemptValidationRepair` with fence-strip + brace-balance + trailing-comma repair + append-missing-`}` on truncation. Runs BEFORE retry-with-feedback; salvages truncated output without a round-trip. ~120 LoC. Unblocks SalesCoach's interview-agent migration + json-repair.ts retirement.
7. **Per-call `timeoutMs` / `maxAttempts` overrides** (SalesCoach B). Optional fields on all 5 call-options interfaces; per-call wins over Registry default. ~40 LoC.
8. **Retry-on-empty as transient policy** (SalesCoach F). Default `runtimeFallback` treats `EmptyResponseError` as transient-retry-then-fallback (retry same provider once, advance chain on second empty). Configurable. ~30 LoC.

### Observability items

9. **`registry.recentRetries(n)` query API** (Dramma 5). Ring-buffer of retry events queryable at Registry level; kills Dramma's hand-rolled `retryHistory` array and response-smuggling channel. ~50 LoC.
10. **Shared telemetry-envelope types exported from `@llm-ports/core`** (Dramma 8). Publishes the `CostEvent` / `TokenUsageEvent` / `CompletionEvent` types explicitly so consumers can re-use them without re-declaring. ~10 LoC (type-level).

### Ergonomics items

11. **`pricingPolicy: "throw" | "warn" | "silent"`** (ADW F). Default `"throw"` (backwards-compat). `"warn"` logs a `pino` warning + treats cost as 0 with `costEstimated: true` flag on result. ~20 LoC.
12. **`pricing: 'free'` sentinel** (Dramma 2a). `AdapterRegistration.pricing: 'free' | ModelPricing`; free adapters skip pricing lookups entirely. Extends Item 11's philosophy. ~15 LoC.
13. **`tolerantKeylessAliases: true` in `createRegistryFromEnv`** (SalesCoach A). Skips provider aliases whose adapter is missing (with a structured warning) + prunes those aliases from route chains automatically. Kills SalesCoach's 40-line `buildSyntheticEnv` workaround. ~80 LoC.
14. **`@llm-ports/express` helper package with `signalFromResponse(res)`** (Dramma 7). Small QoL helper; kills three copies of the `res.on('finish'/'close')` block in Dramma. Own tiny package to avoid coupling core to Express. ~40 LoC.

### Consistency items

15. **Consistent `ValidationError` wrapping across adapters** (BEPA 7). Contract-test that every adapter surfaces schema validation failures as `ValidationError` (from `@llm-ports/core`) with `ZodIssue[]` preserved. Fix any non-compliant adapters. Kills BEPA's 5-level `.cause` chain walker. ~80 LoC of contract tests + per-adapter fixes.
16. **Universal enum case normalization in `attemptValidationRepair`** (BEPA 8). Walks any Zod schema; for every `.enum()` field, attempts case-insensitive match against enum values. If model returned `"Low"` and enum is `["low","medium","high"]`, coerces. ~50 LoC + expanded tests.

---

## Open design questions (please weigh in)

Six questions consumers should signal on before implementation begins:

1. **`AttemptTimeoutError` class shape.** Subclass `ProviderUnavailableError` (existing classifiers catch it AND consumers can `instanceof AttemptTimeoutError`) VERSUS wrap the abort as generic `ProviderUnavailableError` (zero-classifier-change downstream). **Recommendation:** distinct subclass.
2. **`budgetScope: { totalTokens, totalUSD }` accumulation.** Registry-level accumulator VERSUS backend-delegated (`BudgetBackend.recordScopeUsage` hook; enables Redis-backed cross-worker accounting). **Recommendation:** Registry-level for alpha.28; backend hook in alpha.30 alongside `@llm-ports/budget-redis`.
3. **`onComplete` shape.** Additive (fires alongside `onCost` + `onTokenUsage`; consumer wires whichever it wants) VERSUS replace. **Recommendation:** additive.
4. **Opaque-400 detection pattern.** Strict (`status === 400 && body.length < 20 && request.response_format?.strict === true`) VERSUS loose. **Recommendation:** strict; document what triggers.
5. **`pricingPolicy: "warn"` default cost value.** 0 with new `CostUsage.costEstimated?: true` flag VERSUS `NaN`. **Recommendation:** 0 + flag.
6. **Alpha.28 target ship date.** 2026-08-05 (two weeks after alpha.27) VERSUS 2026-08-19 (four weeks). **Recommendation:** 2026-08-05 base; extend to 2026-08-19 if design questions surface.

---

## Four-consumer credit

Every finding here was filed by at least one production consumer during their alpha.20.1 / alpha.24 / alpha.26 audits. Consumers:

- **ADW** (Agentic Development Worker): findings A, B, C, D, F (5 asks).
- **SalesCoach**: findings A, B, C, D, E, F (6 asks; D deferred to alpha.29).
- **BEPA** (Babak Personal Assistant): findings 7, 8, 10 (3 asks in alpha.28; others deferred).
- **Dramma**: findings 5, 8, 2a, 7 (4 asks in alpha.28; others deferred).

Full four-consumer synthesis: see [alpha.27 release plan §A.11.6](https://github.com/baabakk/llm-ports/blob/main/docs/plans/alpha-27-release-plan.md) (published post-alpha.27).

## Cross-references

- Alpha.27 release plan: to be published post-ship (target 2026-07-22).
- Alpha.26 release: [github.com/baabakk/llm-ports/releases/tag/v0.1.0-alpha.26](https://github.com/baabakk/llm-ports/releases/tag/v0.1.0-alpha.26)
- Alpha.26 planning: [Discussion #62](https://github.com/baabakk/llm-ports/discussions/62)
- Alpha.26 release: [Discussion #63](https://github.com/baabakk/llm-ports/discussions/63)
- Alpha.29 planning: filed alongside this discussion.
- Alpha.30 planning: filed alongside this discussion.
- Alpha.31 planning: filed alongside this discussion.

Post design-question answers below by 2026-07-31 for baseline scope; earlier is better.
