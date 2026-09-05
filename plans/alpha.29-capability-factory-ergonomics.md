# alpha.29: "Capability factory ergonomics" (announced theme)

**Status:** Announced 2026-07-17, displaced 2026-08-11 by runtime observability instrumentation. **Zero of eleven announced items shipped.** This document is a retrospective inventory, written 2026-09-05, not the original plan.

**Why this document exists.** The eleven items lived only in [planning discussion #65](https://github.com/baabakk/llm-ports/discussions/65) and in the planning conversation that produced it. Nothing in this repository listed them, so the release journal could record "0 of 11" as a headline that nobody could act on. A theme cannot be repaid from a number.

Recovered 2026-09-05 from the planning conversation that assigned each consumer finding to a release, then scored against source at `alpha.32` head. `plans/alpha.29-runtime-instrumentation.md` describes what displaced this theme, not the theme itself.

---

## What was announced

`docs/migration/alpha-26-to-alpha-27.md`, shipped 2026-07-17, named this as the second of four themed releases, targeted 2026-08-19: eleven items covering the capability-factory option surface, drawn from SalesCoach, BEPA and Dramma.

---

## Inventory

Verified against source on 2026-09-05. "Not shipped" means the described symbol or behaviour was searched for and is absent, not that a changelog omitted it.

| # | Item | Asked by | Status |
|---|---|---|---|
| 13 | `Registry.validateWithEnv()` diagnostic | SalesCoach G | **Not shipped.** No such method anywhere in `packages/*/src`. |
| 14 | Partial-accept-with-defaults in `generateStructured` | SalesCoach D | **Not shipped.** No partial-accept path on the structured options or result. |
| 15 | Optional `schema` on `createSummarizer`, for a structured summary | BEPA 2 | **Not shipped.** `packages/capabilities/src/compression/summarize.ts` carries `schemaName?` but no `schema` field, so a structured summary cannot be expressed at all. |
| 16 | `groundingValidator` hook on `createExtractor` | BEPA 3 | **Not shipped.** No such symbol. |
| 17 | Optional `schema` on `createAnalyzer`, returning a string when absent | BEPA 4 | **Not shipped.** `schema: TSchema` is required at `packages/capabilities/src/reasoning/analyze.ts:40`. |
| 18 | `postValidationHook` on `createPlanner` | BEPA 5 | **Not shipped.** No such symbol. |
| 19 | `PartialResultLLMPort` / `CompatibleLLMPort` type export | BEPA 1 | **Not shipped.** Neither type exists. |
| 20 | `NonContiguousSystemError` demoted to a per-adapter warning-and-collapse | SalesCoach H | **Not shipped.** Still a hard `throw` at `adapter-anthropic/src/adapter.ts:250` and `adapter-google/src/adapter.ts:231`. |
| 28 | Named sessions: `openNamedSession` / `getSession` / `sessions()` / `snapshot()` | Dramma 3 | **Not shipped.** No such symbols. |
| 29 | Vision `port.classify` triage helper with low-detail cost gating | Dramma 6 | **Not shipped.** `understanding/classify.ts` has no image, detail or vision handling; it is text-only. |
| 30 | `responseAdapter` hook on `adapter-openai`, to parse extra fields from self-hosted responses | Dramma 2b | **Not shipped.** No such option. |

**Totals: 0 shipped, 0 partial, 11 not shipped.**

---

## By consumer

| Consumer | Asks | Shipped |
|---|---|---|
| BEPA | items 15, 16, 17, 18, 19 | **0 of 5** |
| Dramma | items 28, 29, 30 | **0 of 3** |
| SalesCoach | items 13, 14, 20 | **0 of 3** |

**The largest single block is BEPA's own**, which matters because the alpha.28 inventory concluded that displacement favours the consumer nearest to hand. One release later the pattern does not hold: BEPA went 2 of 3 on alpha.28 and 0 of 5 here. The mechanism is not favouritism and never was. It is that undisplaced scope is whatever the current work happens to touch, and nobody's asks are safe from it.

---

## The item worth pulling forward

**Item 17 is still costing its asker today.** BEPA's own project rules record that its `llmAnalyze` wrapper stays custom rather than delegating to the published factory, with the stated reason that the factory is "schema-required structured-only" and `llmAnalyze` is the text-returning escape hatch. That is item 17, described as a live constraint seven weeks after the release that was going to fix it was announced.

Item 15 is the same shape from the other direction: the summarizer cannot return structure, so a consumer wanting a structured summary must reach for `createExtractor` instead, which the summarizer's own header comment tells them to do. Both are small option-surface changes on files that already thread `schemaName`.

---

## What re-queuing requires

1. **These eleven are owed unless explicitly withdrawn.** Items 15 and 17 are the cheapest and have a named consumer still working around them.
2. **Item 20 needs a decision, not an implementation.** Demoting a thrown error to a warning is a behaviour change on two adapters, so it wants a release note and a migration line rather than a quiet relaxation.
3. **Items 28, 29 and 30 are Dramma's and should be confirmed as still wanted** before being built. They were scoped 2026-07-17 and may have been solved app-side since.
4. **Nothing here blocks on an unresolved design question**, unlike alpha.28 items 1 and 4. This theme is unusually shippable for its size.
