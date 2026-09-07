# alpha.33: "Failover that fires, and documents that route"

**Status:** In progress. Item 1 shipped; items 2 and 3 outstanding.
**Scope changed 2026-09-06** by the owner, to add item 3 (`DocumentBlock`). Recorded in the changelog at the foot of this document rather than edited in silently.
**Date opened:** 2026-08-21.
**Journal row:** [`RELEASE-JOURNAL.md`](./RELEASE-JOURNAL.md). This release is not finished until that row is filled.

**Why this document exists at all.** It was written *after* work on the release had already started, which is a violation of the rule this project adopted the same day: every release gets a plan document before it ships. Recorded rather than quietly corrected, because the rule came from diagnosing alpha.28, whose scope lived only in a discussion thread and was the one release that silently drifted. Re-committing the same mistake within hours of naming it is worth writing down; it is evidence that the rule needs a mechanical check rather than good intentions.

---

## Why these items, and why together

Items 1 and 2 are the same defect seen from opposite directions: **failover that consumers believe they have and do not.**

Item 1 is shipped code contradicting its own documentation. Item 2 is the announced highest-leverage item of alpha.28, wanted by two consumers, never built. Shipping them apart would mean answering the same design question twice.

This is also the first release of the debt-repayment sequence set out in [`docs/v0-1-status.md`](../docs/v0-1-status.md), and it leads with correctness rather than with features on purpose. Of everything owed, only this one is *actively wrong* rather than merely absent.

---

## Item 1: Streamed chains must fall back. **Shipped.**

**The defect.** `walkStreamChain` opens a provider's stream inside a `try` and treats a throw as the signal to walk to the next provider. Every adapter implements streaming as an async generator, and calling one returns a generator object **without executing any of its body**. The request that contacts the provider therefore does not happen until the consumer iterates, long after the walker returned.

So the walker saw a healthy open for a dead provider, recorded the attempt, marked the alias authenticated, and returned. The real failure surfaced during consumer iteration, with no chain left to walk.

**Consequence:** `streamText` and `streamStructured` have never fallen back, on any released version. A consumer who configured `runtimeFallback: "aggressive"` across three providers got no failover at all on the streamed methods, and no error, log line, or dropped-event counter said so.

**The fix.** Prime: pull the first event inside the walker's `try`, where a failure can still be acted on, and replay it to the consumer. `primeStream` and `replayPrimed` already existed, added for `streamChat` in alpha.32, which hit this on its very first fallback test.

**Verification.** Eight tests in `packages/core/tests/stream-fallback.test.ts`. **Four of them fail against the pre-fix implementation**, confirmed by stashing the fix and re-running rather than by reasoning about it.

That mattered, because the existing streaming tests all pass either way. They stub providers as arrays, or as generators that yield before failing, and neither shape reproduces the defect: both run the failing line only after the walker has already returned. A test suite that cannot fail on the bug is why this survived to alpha.32.

The suite also covers what a careless fix would break: the primed first chunk must be replayed rather than swallowed, an empty stream must not hang, a mid-stream failure after the first chunk must still reach the consumer, and a provider whose stream never opened must **not** be marked authenticated.

**Commit:** 22709ef.

---

## Item 2: `AttemptTimeoutError`. **Outstanding.**

**Origin.** Alpha.28 item 1, from ADW finding A and SalesCoach finding B. The migration guide that announced alpha.28 called it that release's "highest-leverage item". It was never built.

**Shape, as originally scoped (~50 LoC).** Introduce `AttemptTimeoutError extends ProviderUnavailableError` in `@llm-ports/core`. `withPerAttemptTimeout` catches the SDK-native abort at the wrapper boundary and re-throws as `AttemptTimeoutError`.

The subclassing is the whole trick: every consumer whose `shouldFallback` already catches `ProviderUnavailableError`, whether through the default classifier, the aggressive preset, or a custom one, gets deadline-triggered failover with **no code change**. Consumers who want to distinguish a timeout from an outage can still `instanceof` the subclass.

**Open design question 1 from discussion #64, now answerable.** The question was whether to subclass `ProviderUnavailableError` or wrap the abort as a generic one. The recommendation was a distinct subclass, and item 1's work supports it with evidence rather than preference: priming proved that consumers cannot currently distinguish "provider never opened" from "provider failed mid-stream", and a distinct class is what makes that distinction available at all. **Adopt the subclass.**

**What to watch.** The per-attempt timeout already exists (`perAttemptTimeoutMs`, shipped alpha.30, which is itself the delivered half of alpha.28 item 7 arriving two releases late). What is missing is only the typed error at the boundary, so this is genuinely small. The risk is not size but interaction: an abort raised by a caller's own `AbortSignal` must **not** be reclassified as a timeout, or a deliberate cancellation would trigger a pointless walk down the whole chain. That distinction needs a test.

---

## Item 3: `DocumentBlock`. **Outstanding.**

**Origin.** `TD-LLM-PORTS-NO-DOCUMENT-BLOCK`, raised by the HomeSignal consumer 2026-09-04 and verified at head the same day. Added to this release by the owner 2026-09-06.

**The defect.** `ContentBlock` is `TextBlock | ImageBlock | AudioBlock | ToolUseBlock | ToolResultBlock`, and `ImageSource.mediaType` admits four raster formats. **A PDF cannot be expressed on the port at all.**

**Consequence, which is worse than a missing feature.** Two call sites in that consumer's document pipeline import the OpenAI SDK directly because there is no port equivalent. Their settings panel therefore presents a provider choice that does not govern half the pipeline: the store says one vendor while every document analysis bills another. **The user-visible falsehood is the real cost**, not the architectural bypass.

**Shape.** A separate block, not a widened `ImageSource`:

```ts
export interface DocumentBlock {
  type: "document";
  source: DocumentSource;
  /** Filename hint. OpenAI surfaces it to the model; other providers ignore it. */
  filename?: string;
}

export type DocumentMediaType =
  | "application/pdf" | "text/plain" | "text/markdown" | "text/csv";

export type DocumentSource =
  | { kind: "base64"; mediaType: DocumentMediaType; data: string }
  | { kind: "url"; url: string; mediaType?: DocumentMediaType };
```

**Why a separate block.** A PDF is not an image, so widening `ImageSource` would make `ImageBlock`'s name false. Providers treat documents as a distinct input kind, so a merged union would be re-split inside every adapter anyway. Decisively, **this codebase already answered the identical question the same way**: `AudioBlock` exists as its own member rather than as a widened image source. Doing otherwise here would make the content model inconsistent with itself.

**Adapter mapping, verified against each SDK's shipped typings rather than against documentation.**

| Adapter | base64 | url |
|---|---|---|
| `adapter-openai` | `{ type: "file", file: { file_data, filename } }`, confirmed present in `openai@4.104.0` | **Throws.** The file content part has `file_data` and `file_id` and no URL variant. |
| `adapter-google` | `inlineData: { mimeType, data }` | `fileData: { mimeType, fileUri }` |
| `adapter-anthropic` | **Throws.** `@anthropic-ai/sdk@0.32.1`, the pinned version, has no document block in its typings at all. | **Throws.** |
| `adapter-ollama`, `adapter-vercel` | **Throws** unless verification shows otherwise during implementation. |

Every throw is `ContentBlockUnsupportedError`, which already exists at `packages/core/src/errors.ts:339` and is exactly how the OpenAI adapter already rejects URL-sourced audio.

**Why partial coverage is safe rather than a compromise.** A chain whose first provider cannot take a PDF walks to one that can, with no consumer configuration. Partial adapter coverage degrades into routing rather than into failure, which is the whole argument for having a port.

**This required a code change, and the first draft of this plan said it did not.** The claim was that `defaultShouldFallback` already walks on `ContentBlockUnsupportedError`, which is true of that exported function and irrelevant to what actually runs. **Two different things are called "default".** The Registry's behaviour when `runtimeFallback` is unset is a separate inline preset that walks only on `ProviderUnavailableError` plus conditional `AuthenticationError`; the exported `defaultShouldFallback` is the broader alpha.28 walk-table and is opt-in via `{ shouldFallback: defaultShouldFallback }`. The routing test failed on its first run and is the only reason this was caught before shipping. See `TD-LLMPORTS-TWO-THINGS-CALLED-DEFAULT-FALLBACK`.

**So alpha.33 also adds `ContentBlockUnsupportedError` to the unnamed default preset.** That is a behaviour change and it belongs on the pre-beta gate list. The justification is that this error class is categorically unlike the others in that preset: it is not a transient failure or a provider-health signal to be retried in hope, it is a **static capability mismatch**, so the selected provider will never serve the call however long it is given. Walking is not a gamble, it is the only route to an answer, and declining to walk guarantees the failure it appears to be avoiding. `runtimeFallback: "none"` still gives a consumer a hard stop.

**What to watch.** Adding a member to `ContentBlock` is additive for anyone constructing content and **breaking in the TypeScript-strict reading for anyone consuming it**: an exhaustive `switch` over the union that previously compiled will now fail on the unhandled case. That is precisely why this belongs before the beta freeze rather than after. It ships with a migration page and a release title marked `TS-BREAKING`, per the convention in the repo's release discipline.

---

## Out of scope, deliberately

The other nine unshipped alpha.28 items. They are queued for alpha.34 and are features rather than corrections; mixing them here would make a small verifiable release into an unreviewable one, which is the failure mode this whole sequence exists to avoid.

Also out of scope within item 3: uploading a document to a provider's Files API and referencing it by id. OpenAI's file content part accepts `file_id` alongside `file_data`, so the door is open, but an upload path means lifecycle, retention and cleanup questions that a content block does not have. Base64 and URL cover the consumer that asked.

---

## Changelog

- **2026-08-21.** Opened with two items. Item 1 shipped the same day, commit 22709ef.
- **2026-09-06.** Owner added item 3, `DocumentBlock`, to unblock a consumer that is bypassing the port with a vendor SDK today. Scope change is the owner's to make; recorded here rather than applied silently. The theme still holds: an unsupported document walks the chain by the same mechanism a timeout now does, so all three items are about the chain doing the right thing when one provider cannot serve a call.
