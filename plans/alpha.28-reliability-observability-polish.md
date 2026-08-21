# alpha.28 — "Reliability + observability polish" (four-consumer synthesis)

**Status:** Shipped 2026-07-22 as an observability contract foundation. **Four of sixteen announced items shipped.** This document is a retrospective inventory, written 2026-08-21, not the original plan.

**Why this document exists.** Alpha.28's scope came from four production consumers and lived only in [planning discussion #64](https://github.com/baabakk/llm-ports/discussions/64). Every other release from alpha.29 onward has a plan document in this directory; this one did not, and it is the only release whose announced scope silently drifted. That is not a coincidence. Scope that lives outside the repository is scope nobody reconciles against shipped code.

It was written after an external consumer reported that its findings had not shipped, and no one could confirm or refute that because nobody had read the slate against the code. See `TD-LLMPORTS-FOUR-DISPLACED-RELEASE-THEMES`.

---

## What was announced

`docs/migration/alpha-26-to-alpha-27.md`, shipped 2026-07-17: *"Alpha.28 'Reliability + observability polish' ships next (target 2026-08-05). Sixteen items synthesized from findings by four consumers (ADW, SalesCoach, BEPA, Dramma). Highest-leverage item: per-attempt deadline that automatically triggers failover."*

Every item was scoped at 200 lines or fewer plus tests.

---

## Inventory

Verified against source on 2026-08-21. "Shipped" means the described behaviour exists and was checked, not that a changelog claimed it.

| # | Item | Asked by | Status |
|---|---|---|---|
| 1 | `AttemptTimeoutError extends ProviderUnavailableError`; per-attempt deadline auto-triggers failover | ADW A, SalesCoach B | **Not shipped.** No such class exists. This was the release's stated highest-leverage item. |
| 2 | Combined `onComplete(event)` hook | ADW C, SalesCoach C | **Not shipped.** No `onComplete` in the observability surface. |
| 3 | Registry-level `pricingOverrides` | BEPA 10, SalesCoach 4 | **Shipped.** `RegistryOptions.pricingOverrides`, per-adapter still wins. |
| 4 | Per-scope total budget ceiling on `BudgetScopeRef` | ADW B | **Not shipped.** No `totalTokens` / `totalUSD` on the scope type. |
| 5 | adapter-openai opaque-400 detection as a capability signal | ADW D | **Not shipped.** No such branch in the capability learner. |
| 6 | JSON text repair before retry-with-feedback: fence-strip, brace-balance, trailing comma, append-missing-brace on truncation | SalesCoach E | **Partial, and predating the release.** A two-layer repair exists (jsonrepair fallback in `extractJSON`, plus eight Zod-issue patterns), but those are alpha.5 and alpha.13 work fixing *parsed-but-invalid values*. The ask was salvaging *truncated JSON text*. No evidence the truncation-specific additions landed. |
| 7 | Per-call `timeoutMs` and `maxAttempts` overrides | SalesCoach B | **Half, two releases late.** `perAttemptTimeoutMs` exists on all five call-options interfaces, but it shipped in alpha.30, not here. `maxAttempts` never shipped. |
| 8 | Retry-on-empty as transient policy | SalesCoach F | **Shipped.** `EmptyResponseError` walks the chain in the documented walk-table. |
| 9 | `registry.recentRetries(n)` query API | Dramma 5 | **Not shipped.** No such method. |
| 10 | Shared telemetry-envelope types exported from core | Dramma 8 | **Shipped.** `CostEvent`, `TokenUsageEvent` and siblings are public. |
| 11 | `pricingPolicy: "throw" \| "warn" \| "silent"` | ADW F | **Not shipped.** No such option. |
| 12 | `pricing: 'free'` sentinel on `AdapterRegistration` | Dramma 2a | **Not shipped.** |
| 13 | `tolerantKeylessAliases` in `createRegistryFromEnv` | SalesCoach A | **Not shipped.** The 40-line consumer workaround it was meant to kill is presumably still there. |
| 14 | `@llm-ports/express` helper with `signalFromResponse(res)` | Dramma 7 | **Not shipped.** No such package. |
| 15 | Contract test that every adapter surfaces `ValidationError` with `ZodIssue[]` | BEPA 7 | **Not shipped.** No `ValidationError` assertions in the contract-test package. |
| 16 | Universal enum case normalization in `attemptValidationRepair` | BEPA 8 | **Shipped.** Pattern 5 strips wrappers and lower-cases enum drift. |

**Totals: 4 shipped, 2 partial, 10 not shipped.**

---

## By consumer, which is the part that matters

| Consumer | Asks | Shipped |
|---|---|---|
| ADW | A, B, C, D, F (items 1, 4, 2, 5, 11) | **0 of 5** |
| SalesCoach | A, B, C, E, F (items 13, 7, 2, 6, 8) | 1 of 5, plus 2 partial |
| Dramma | 5, 8, 2a, 7 (items 9, 10, 12, 14) | 1 of 4 |
| BEPA | 7, 8, 10 (items 15, 16, 3) | 2 of 3 |

**ADW's report was exactly right.** They said five of their findings did not ship. All five did not ship, and none has been re-queued since.

The distribution is worth stating plainly rather than leaving for someone else to notice: **the maintainer's own consumer got the best outcome and the most distant consumer got nothing.** Nobody decided that. It is what happens when scope is displaced item by item without a written record, because the items nearest to hand survive and the rest fall off silently.

---

## What this means for re-queuing

1. **The ten unshipped items are still owed** unless explicitly withdrawn. Four of the five ADW asks are small (roughly 30 to 150 lines each by the original scoping); only item 4 approaches real design work.
2. **Items 1 and 2 are cross-consumer**, wanted by two consumers each, so they carry more weight than their size suggests. Item 1 was the release's own stated highest-leverage item and remains unbuilt.
3. **Withdraw rather than carry silently.** Item 14 (`@llm-ports/express`) is a separate package for a small convenience; if it is not wanted, say so where it was promised. The same question applies to item 12.
4. **The six open design questions in discussion #64 were never resolved**, including the `AttemptTimeoutError` shape and whether scope budgets accumulate at the Registry or delegate to the backend. Item 1 cannot be built without answering the first, and item 4 without the second. Note that question 2's recommendation deferred the backend hook to "alpha.30 alongside `@llm-ports/budget-redis`", a package that also does not exist, so two announced threads terminate at the same missing piece.

---

## Process note

This document exists because its absence caused the drift. The rule that follows: **every release gets a plan document in `plans/` before it ships, and the near-term queue in `docs/v0-1-status.md` is reconciled against shipped artifacts rather than against recollection.**

The queue added on 2026-08-19 was itself built from working context and inherited exactly the omission it was created to prevent. A durable record populated from memory is not a durable record.
