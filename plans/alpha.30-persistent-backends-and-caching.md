# alpha.30: "Persistent backends + caching" (announced theme)

**Status:** Announced 2026-07-17, displaced 2026-08-14 by streaming instrumentation, adapter-side emission and the OpenTelemetry bridge. **Zero of two announced items shipped.** Retrospective inventory, written 2026-09-05.

**Why this document exists.** The two items lived only in [planning discussion #66](https://github.com/baabakk/llm-ports/discussions/66). Recovered 2026-09-05 from the planning conversation that assigned each consumer finding to a release, then scored against source at `alpha.32` head.

This is the smallest displaced theme and the most consequential, because both items are named by consumers as still-missing on current versions, and because one of them is the terminus of a deferral chain that also blocks an alpha.28 item.

---

## What was announced

`docs/migration/alpha-26-to-alpha-27.md`, shipped 2026-07-17, named this as the third of four themed releases, targeted 2026-09-02. Two items, each large enough to carry its own surface.

---

## Inventory

Verified against source on 2026-09-05.

| # | Item | Asked by | Status |
|---|---|---|---|
| 21 | Content-result cache as a port hook, the analogue of the existing fingerprint cache | ADW E | **Not shipped.** No response cache exists at any layer. `ResponseCache` and `responseCache` match nothing in `packages/*/src`. |
| 22 | `@llm-ports/budget-redis` companion package | BEPA 9 | **Not shipped.** No such package. `packages/core/src/budget/` holds `cost.ts`, `memory.ts` and `types.ts`; the only implementations are `InMemoryBudget` and `InMemoryCost`. |

**Totals: 0 shipped, 0 partial, 2 not shipped.**

The release journal records this theme as "2 items plus a bonus". The two items are recovered above; **what the bonus referred to is not established** and should not be guessed at. If it mattered it will be in discussion #66.

---

## By consumer

| Consumer | Asks | Shipped |
|---|---|---|
| ADW | item 21 | **0 of 1** |
| BEPA | item 22 | **0 of 1** |

---

## Why this theme outranks its size

**Three separate threads terminate at item 22.**

First, the theme itself. Second, alpha.28 item 4, the per-scope total budget ceiling on `BudgetScopeRef`: that item's unresolved design question was whether scope budgets accumulate at the Registry or delegate to the backend, and the planning discussion's own recommendation deferred the answer to "alpha.30 alongside `@llm-ports/budget-redis`". Third, every consumer running more than one process.

So a deferral pointed at a package, and the package was itself only ever named inside a deferral. Neither exists. Building them separately means answering the same design question twice, which is why the repayment sequence puts item 4 and item 22 in one release rather than treating the ceiling as an alpha.28 leftover.

**The injectable seam already exists and is the reason this is smaller than it looks.** `RegistryOptions.budget` and `RegistryOptions.cost` accept a `BudgetBackend` and a `CostBackend`, and `InMemoryBudget` / `InMemoryCost` are ordinary implementations of those interfaces. A consumer can write a Redis backend against the published interface today without waiting for us. That is worth telling consumers explicitly, because at least two have recorded the opposite belief.

**One consumer's tech-debt entry says so in the wrong direction.** The RLM gateway defers its persistent-budget work with the stated reason that "upstream persistent `BudgetBackend`/`CostBackend` is roadmapped for beta.2 and not shipped". The interface they need is in the version they have installed. They are blocked on a package that would be convenient, not on a seam that is missing, and nothing we published told them the difference.

---

## What re-queuing requires

1. **Item 22 needs the design question from alpha.28 answered first**: does a scope budget accumulate at the Registry, or delegate to the backend? The answer determines the backend interface, so it cannot be deferred again into the implementation.
2. **Item 21 has no such blocker.** A content-result cache is a port-level hook with a precedent already in the tree, the fingerprint cache, and one asker.
3. **Publish the "you can already do this" note regardless of when the package ships.** The injectable seam is public API that consumers are not finding. That costs a paragraph in the status page and closes a real misconception this week rather than next release.
