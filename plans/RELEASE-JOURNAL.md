# Release journal

One row per release: what was **announced**, what **shipped**, and where anything displaced **went**.

## Why this exists

Between alpha.28 and alpha.31, four consecutive themed releases were announced publicly and then replaced by other work. Nobody noticed until a consumer counted, four releases later, and reported that its findings had never shipped. Reconstructing what had actually happened took a full audit against source.

Each individual displacement looked reasonable at the time. That is the problem: judgment applied release by release cannot see a pattern that only exists across releases. The changelog records what shipped, and the plan documents record what was intended, but **nothing recorded the gap between them**, so the gap was invisible until it was four releases wide.

This file is that missing surface.

## The rule

**A release is not finished until its row here is filled in.** Not when the packages publish, not when the changelog is written. This row.

Filling it takes about a minute and forces one question that is otherwise never asked out loud: *did this release ship what it said it would, and if not, where did the rest go?* An answer of "nowhere yet" is fine and is the point of writing it down.

Two supporting rules, both learned the same way:

- Every release gets a plan document in this directory **before** it ships. Alpha.28 is the one release whose scope lived only in a GitHub discussion, and it is the one that drifted. That is not a coincidence.
- The near-term queue in [`docs/v0-1-status.md`](../docs/v0-1-status.md) is reconciled against **shipped artifacts**, never against recollection. The queue added on 2026-08-19 was built from working context and inherited the exact omission it was created to prevent.

## Journal

Scored against source, not against changelogs. "Announced" means stated in a shipped artifact or a planning discussion linked from one.

| Release | Date | Announced as | Shipped | Displaced work went |
|---|---|---|---|---|
| alpha.0 | 2026-05-09 | Not announced in advance | Initial public alpha: ports and adapters for LLMs, multi-provider routing, USD cost gating | Not applicable |
| alpha.1 | 2026-05-11 | Not announced in advance | `OnRetry` hook plus `RetryEvent` / `RetryReason` types. Closed four audit issues (#1, #3, #4, #5) | Not applicable |
| alpha.3 | 2026-05-20 | Not announced in advance | Shared adapter utilities, replacing helpers duplicated across adapter packages | Not applicable |
| alpha.4 | 2026-05-20 | Not announced in advance | `ImageSource.detail` for OpenAI vision cost control | Not applicable |
| alpha.5 | 2026-05-21 | Not announced in advance | Image-block boundary validation; Gemini adapter; session-scoped cost gate. Closed #19, #20, #21 | Not applicable |
| alpha.6 | 2026-05-23 | Not announced in advance | `signal?: AbortSignal` on all five options interfaces (#24) | Not applicable |
| alpha.7 | 2026-05-23 | Not announced in advance | Registry runtime fallback and `forceProviderAlias` | Not applicable |
| alpha.9 | 2026-05-26 | Not announced in advance | Runtime model discovery: `listModels()` and `checkPricingFreshness()` (#9) | Not applicable |
| alpha.12 | 2026-05-26 | Not announced in advance | `reasoningEffort` on all five options interfaces | Not applicable |
| alpha.13 | 2026-05-26 | Not announced in advance | Capability factories thread `reasoningEffort`, `signal`, `forceProviderAlias` through to the port | Not applicable |
| alpha.16 | 2026-05-27 | Not announced in advance | `providerExtras` per-call escape hatch on all five options interfaces | Not applicable |
| alpha.17 | 2026-05-30 | Not announced in advance | First alpha of the v0.1 line formally approved; five small additive items | Not applicable |
| alpha.18 | 2026-06-05 | Not announced in advance | Typed-error taxonomy. **Breaking**: `ContextWindowExceededError` no longer matches `instanceof ProviderUnavailableError` | Not applicable |
| alpha.19 | 2026-06-12 | Not announced in advance | `CacheControl` shape. **Breaking**: `cost.cacheDiscountUSD` renamed to `cost.cacheSavingsUSD` | Not applicable |
| alpha.19.1 | 2026-06-12 | Not announced in advance | `CacheControl` behaviour backed by verified per-mode conduct on the cloud adapters | Not applicable |
| alpha.20 | 2026-06-13 | Not announced in advance | `BudgetScope` plus minute and session gating grammar | Not applicable |
| alpha.20.1 | 2026-06-15 | Not announced in advance | Migration safeguards: postinstall banner on version change | Not applicable |
| alpha.21 | 2026-06-18 | Not announced in advance | Per-call `strict` on structured options; five OpenTelemetry-aligned observability hooks | Not applicable |
| alpha.23 | 2026-06-24 | Not announced in advance | `RegistryOptions.perAttemptTimeoutMs`; two new retry discriminators | Not applicable |
| alpha.24 | 2026-06-24 | Not announced in advance | `deriveValidationRetryFromAdapterRetry`, closing an alpha.21 deferral | Closed an alpha.21 deferral, which is the pattern working as intended |
| alpha.25 | 2026-07-02 | Not announced in advance | Observability surface and reliability hardening; three additive features | Not applicable |
| alpha.26 | 2026-07-02 | Not announced in advance | API unification on canonical `messages` input, alongside the deprecated fields | Not applicable |
| alpha.27 | 2026-07-17 | Not announced in advance | Legacy `{instructions, prompt}` fields removed. **Breaking**. Two-cycle window closed | Not applicable. **This release announced the four themes below** |
| alpha.28 | 2026-07-22 | "Reliability + observability polish", 16 items from four consumers ([#64](https://github.com/baabakk/llm-ports/discussions/64)) | Observability contract foundation. **4 of 16**, plus 2 partial | **Nowhere, for a month.** Re-queued 2026-08-21 across alpha.33 to alpha.35; see [`alpha.28-reliability-observability-polish.md`](./alpha.28-reliability-observability-polish.md) for per-item scoring |
| alpha.29 | 2026-08-11 | "Capability factory ergonomics", 11 items ([#65](https://github.com/baabakk/llm-ports/discussions/65)) | Runtime observability instrumentation. **0 of 11** | Nowhere. Re-queued 2026-08-21 as alpha.37, needing re-scoping first |
| alpha.30 | 2026-08-14 | "Persistent backends + caching", 2 items plus a bonus ([#66](https://github.com/baabakk/llm-ports/discussions/66)) | Streaming instrumentation, adapter-side emission, OpenTelemetry bridge. **0 of 2** | Nowhere. Re-queued 2026-08-21 as alpha.35 (budget) and alpha.36 (cache) |
| alpha.31 | 2026-08-19 | "Local runtime + orchestration", 3 items ([#67](https://github.com/baabakk/llm-ports/discussions/67)) | A single-issue `operation_id` hotfix. **0 of 3** | **Proposed for withdrawal** 2026-08-21: it contradicts the v0.3 roadmap, which already places browser-native inference much further out |
| alpha.31.1 | 2026-08-19 | Not announced in advance; cut in response to a consumer report | Injectable `AuthBackend`; OTel `Tracer` type compatibility | n/a |
| alpha.31.2 | 2026-08-19 | The eval scope originally announced for alpha.31 | Postgres eval backend, evaluation-workflow tooling. ClickHouse withdrawn on verified grounds | n/a. Paid a displacement from alpha.31 |
| alpha.32 | 2026-08-19 | Not announced in advance | `streamChat`, `@llm-ports/integration-livekit` | n/a |
| alpha.33 | in progress | "Failover that actually fires" ([plan](./alpha.33-failover-that-fires.md)) | — | — |

**Totals for the four announced themes: 32 items announced, 4 shipped, 2 partial, 26 not shipped.**

## What the full history shows

**Twenty-nine core releases between 2026-05-09 and 2026-08-19.** Reconstructed 2026-08-21 from git tags and per-package changelogs.

Two observations that only become visible with every release in one table.

**Nothing was announced in advance until alpha.27.** The first twenty-three releases shipped what they shipped, and there was no forward promise to break. That is why the displacement problem starts exactly where the announcements start: you cannot silently drop scope you never advertised. Publishing a roadmap created an obligation the project had no mechanism to track, and this file is that mechanism arriving three months late.

**Version numbers are not contiguous.** alpha.2, 8, 10, 11, 14, 15, and 22 have no core tag, because those releases bumped only adapter or capability packages. A reader counting versions will mis-count releases; a reader counting rows here will not.

## Scope

Rows track `@llm-ports/core`, which is bumped by nearly every release. Releases that touched only other packages (`alpha.31.2`, eval-only) get their own row and are marked as such.

Dates are the tag dates, which is when the version was cut rather than when work began.
