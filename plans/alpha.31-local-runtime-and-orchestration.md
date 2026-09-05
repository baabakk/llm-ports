# alpha.31: "Local runtime + orchestration" (announced theme)

**Status:** Announced 2026-07-17, displaced 2026-08-19 by a single-issue `operation_id` hotfix. **Zero of three announced items shipped.** Proposed for withdrawal 2026-08-21; **that proposal rests on a misreading and should be re-decided.** Retrospective inventory, written 2026-09-05.

**Why this document exists.** The three items lived only in [planning discussion #67](https://github.com/baabakk/llm-ports/discussions/67). Recovered 2026-09-05 from the planning conversation that assigned each consumer finding to a release, then scored against source at `alpha.32` head.

Writing them down changed the recommendation, which is the argument for writing them down.

---

## What was announced

`docs/migration/alpha-26-to-alpha-27.md`, shipped 2026-07-17, named this as the fourth of four themed releases, targeted 2026-09-15 to 2026-09-29. All three items come from Dramma, and the theme was created *because* of them: the planning note records that the local-adapter ask was "the largest single feature ask across all four consumers" and "deserves its own release theme, not folded into anything else".

---

## Inventory

Verified against source on 2026-09-05.

| # | Item | Asked by | Status |
|---|---|---|---|
| 31 | `@llm-ports/adapter-transformers-node`, wrapping `@xenova/transformers` so SmolVLM, SmolDocling and siblings run as first-class `LLMPort`s | Dramma 1a | **Not shipped.** No such package. Estimated ~800 to 1200 LoC including tests. |
| 32 | `@llm-ports/adapter-tesseractjs`, wrapping `tesseract.js` `worker.recognize` as a first-class `LLMPort` | Dramma 1b | **Not shipped.** No such package. Sibling of item 31, OCR only. |
| 33 | Pipeline primitive `port.pipeline([...])` with automatic aggregation of cost, usage, latency, provider alias and retry events across steps | Dramma 4 | **Not shipped.** No `.pipeline(` call site or definition anywhere in `packages/*/src`. |

**Totals: 0 shipped, 0 partial, 3 not shipped.**

Recorded alongside these for completeness: **item 23, session and conversation state (ADW G), was ruled permanently out of scope as app-side.** That is a decision, not a debt, and it is the only one of the 32 announced items with that status.

---

## The withdrawal proposal is built on a misreading

The near-term queue and the release journal both record this theme as "proposed for withdrawal 2026-08-21: it contradicts the v0.3 roadmap, which already places browser-native inference much further out."

**Item 31 is not browser-native inference.** The package name in the ask is `adapter-transformers-node`, it targets the Node runtime, and its stated purpose is to delete Dramma's `local-ocr-server` subprocess, its Docker service, and roughly 800 lines of app-side plumbing by making a local model reachable through the same port as a cloud one. `@xenova/transformers` runs in both environments, and the ask picked one. Whatever the v0.3 roadmap says about browsers does not reach it.

Item 32 is the same shape, narrower. Item 33 is not inference at all: it is an orchestration primitive that composes calls and aggregates their telemetry, and it is independent of where the models run.

So the withdrawal, as written, would discard three items on grounds that apply to none of them. **That does not mean the theme should ship**, and the size is real: items 31 and 32 together are on the order of two new provider ecosystems. It means the decision has not actually been made yet, because what was weighed was not what was asked for.

**The honest options are three, not two.** Withdraw on stated grounds that are true, such as cost against current priorities or the absence of a second asker. Keep item 33 and withdraw 31 and 32, since the pipeline primitive is cheap and independent. Or keep the theme. Any of those is defensible; the current status is none of them.

---

## What re-queuing or withdrawing requires

1. **Confirm with Dramma that the ask is still live.** These were scoped 2026-07-17. A consumer who needed local OCR badly enough to run a subprocess and a Docker service may have since hardened that path, in which case the value has moved.
2. **Item 33 should be split out regardless of the other two.** It is a port-level primitive with a novel design surface, it does not depend on local adapters existing, and the original note's argument that "pipelines only pull real weight once local adapters exist" is weaker than it looked: cost, usage and latency aggregation across a multi-call chain is exactly what a consumer running cloud-only chains reconstructs by hand today.
3. **If withdrawing, say so where it was announced.** The migration guide named this theme with a target date. A withdrawal costs one paragraph in a release note; carrying it silently is the failure this whole sequence exists to stop.
