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
| alpha.28 | 2026-07-22 | "Reliability + observability polish", 16 items from four consumers ([#64](https://github.com/baabakk/llm-ports/discussions/64)) | Observability contract foundation. **4 of 16**, plus 2 partial | **Nowhere, for a month.** Re-queued 2026-08-21 across alpha.33 to alpha.35; see [`alpha.28-reliability-observability-polish.md`](./alpha.28-reliability-observability-polish.md) for per-item scoring |
| alpha.29 | 2026-08-11 | "Capability factory ergonomics", 11 items ([#65](https://github.com/baabakk/llm-ports/discussions/65)) | Runtime observability instrumentation. **0 of 11** | Nowhere. Re-queued 2026-08-21 as alpha.37, needing re-scoping first |
| alpha.30 | 2026-08-14 | "Persistent backends + caching", 2 items plus a bonus ([#66](https://github.com/baabakk/llm-ports/discussions/66)) | Streaming instrumentation, adapter-side emission, OpenTelemetry bridge. **0 of 2** | Nowhere. Re-queued 2026-08-21 as alpha.35 (budget) and alpha.36 (cache) |
| alpha.31 | 2026-08-19 | "Local runtime + orchestration", 3 items ([#67](https://github.com/baabakk/llm-ports/discussions/67)) | A single-issue `operation_id` hotfix. **0 of 3** | **Proposed for withdrawal** 2026-08-21: it contradicts the v0.3 roadmap, which already places browser-native inference much further out |
| alpha.31.1 | 2026-08-19 | Not announced in advance; cut in response to a consumer report | Injectable `AuthBackend`; OTel `Tracer` type compatibility | n/a |
| alpha.31.2 | 2026-08-19 | The eval scope originally announced for alpha.31 | Postgres eval backend, evaluation-workflow tooling. ClickHouse withdrawn on verified grounds | n/a. Paid a displacement from alpha.31 |
| alpha.32 | 2026-08-19 | Not announced in advance | `streamChat`, `@llm-ports/integration-livekit` | n/a |
| alpha.33 | in progress | "Failover that actually fires" ([plan](./alpha.33-failover-that-fires.md)) | — | — |

**Totals for the four announced themes: 32 items announced, 4 shipped, 2 partial, 26 not shipped.**

## Before alpha.28

Not reconstructed. Releases alpha.1 through alpha.27 predate this journal, and rebuilding their announced-versus-shipped record would mean reading twenty-seven releases of changelogs and discussions against current source.

That is real work with real value, and it is deliberately not being guessed at here. An invented row is worse than an absent one, because the absent one is visibly absent.
