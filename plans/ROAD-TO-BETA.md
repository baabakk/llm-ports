# Road to beta

**Opened 2026-09-06.** The gate for entering beta, and the release sequence that clears it.

**The gate is this document's list, not a date.** Every announced date in this project's history has been missed, and the four displaced themes were each individually defensible at the time. Beta ships when the list below is empty. It grew from nine to eleven on 2026-09-06, both additions found by tests written for alpha.33, which is the list working as intended rather than scope creep. Adding a calendar to it would repeat the exact failure the release journal exists to record.

---

## What beta means here

No such definition existed before this document, which is why "go to beta" could not previously be verified or planned against. The definition adopted:

**Beta means the public surface stops moving under consumers. It does not mean the roadmap is finished.**

Concretely, after beta.1:

- No change to an existing type, signature, or documented behaviour without a major-version step and a migration page.
- Additive work continues freely as minor bumps, which consumers can take safely because the contract behind them holds.
- The `@alpha` dist-tag advice inverts: pinning exact versions stops being necessary, because a routine install can no longer jump a consumer across a breaking change.

This definition is what makes beta reachable soon. Of the outstanding items, **eleven change something that already exists**. Everything else is additive and is *better* shipped after the freeze, since a minor bump under a stable contract is safe to take and today every alpha is a coin flip.

## Which packages freeze

Not all seventeen. A tiered beta is honest and roughly halves what has to be true.

| Package | At beta.1 | Why |
|---|---|---|
| `core`, `capabilities`, `observability-contract` | **Beta** | The surface every consumer depends on. |
| `adapter-openai`, `adapter-anthropic`, `adapter-google` | **Beta** | Proven across multiple consumers and covered by the contract suite. |
| `adapter-vercel` | Stays alpha | Its `runAgent` is single-turn only, per this repo's own status page, and whether it carries a real consumer's full provider set is recorded as an assumption rather than a fact. |
| `adapter-ollama`, `adapter-aider`, `adapter-codex` | Stays alpha | Thinner usage and thinner coverage. |
| `eval`, `telemetry-otel`, `integration-livekit`, `migrate` | Stays alpha | Newest surfaces, least consumer contact. |

Staying alpha is not a demotion. It is a statement that those surfaces may still move, which is true.

---

## The gate: eleven items that must land before the freeze

Each changes a shape or a behaviour that exists today. None can land after beta without a major-version step.

| # | Item | What it changes | Origin | Release |
|---|---|---|---|---|
| 1 | `AttemptTimeoutError` | A per-attempt timeout starts triggering failover instead of propagating to the caller | alpha.28 item 1 (ADW A, SalesCoach B) | alpha.33 |
| 2 | `DocumentBlock` | Widening `ContentBlock` breaks exhaustive switches over the union | `TD-LLM-PORTS-NO-DOCUMENT-BLOCK` (HomeSignal) | alpha.33 |
| 3 | Drop-and-warn on an unregistered adapter | The constructor stops throwing where it throws today | alpha.28 item 13 (SalesCoach A) and `TD-LLMPORTS-CONFIG-VALIDATION-ALL-OR-NOTHING` (RLM) | alpha.34 |
| 4 | Pricing required only when the alias is cost-gated | Providers currently skipped become selectable | `TD-LLMPORTS-PRICING-REQUIRED-WITHOUT-COST-GATE` (RLM) | alpha.34 |
| 5 | `pricingPolicy: "throw" \| "warn" \| "silent"` | Changes what pricing admission does on a miss | alpha.28 item 11 (ADW F) | alpha.34 |
| 6 | `pricing: 'free'` sentinel | Changes the `AdapterRegistration` shape | alpha.28 item 12 (Dramma 2a) | alpha.34 |
| 7 | `config?: RegistryConfig` on `RegistryOptions` | The constructor contract; belongs with items 3 to 6 | `TD-LLMPORTS-NO-PROGRAMMATIC-REGISTRY-CONFIG` (RLM) | alpha.34 |
| 8 | `NonContiguousSystemError` demoted to warning-and-collapse | A hard throw stops being thrown, on two adapters | alpha.29 item 20 (SalesCoach H) | alpha.35 |
| 9 | `BudgetScopeRef` total ceiling, plus the Redis backend that sets the interface shape | Fixes the `BudgetBackend` interface before consumers implement against it | alpha.28 item 4 (ADW B) and alpha.30 item 22 (BEPA 9) | alpha.36 |
| 10 | `@llm-ports/core` moved to a peer dependency of every adapter | Published manifests change, and two copies of core silently disable the whole `instanceof` error taxonomy | `TD-LLMPORTS-CORE-IS-A-DEP-NOT-A-PEER-DEP` | alpha.34 |
| 11 | Rename one of the two things called "default" fallback | Public-surface rename; the exported `defaultShouldFallback` is not what `runtimeFallback: undefined` selects | `TD-LLMPORTS-TWO-THINGS-CALLED-DEFAULT-FALLBACK` | alpha.34 |

**Nothing else is gating.** Every remaining owed item is additive: the `onComplete` hook, `recentRetries`, opaque-400 detection, JSON truncation repair, per-call `maxAttempts`, cost attributes on OpenTelemetry spans, the response cache, and ten of alpha.29's eleven capability-factory options.

---

## The sequence

### alpha.33: "Failover that fires, and documents that route" (in flight)

Items 1 and 2, plus the already-shipped streamed-fallback priming. See [`alpha.33-failover-that-fires.md`](./alpha.33-failover-that-fires.md).

`DocumentBlock` was added here by the owner on 2026-09-06 to unblock a consumer shipping a user-visible falsehood today. The theme survives the addition: an unsupported document walks the chain by the same mechanism a timed-out attempt now does.

### alpha.34: "Configuration that survives an incomplete deployment"

Items 3 through 7. **The strongest release in the sequence**, and the one to run if only one gets run. It is a single coherent theme, registry admission and pricing; it repays three announced items; it closes three of the four findings from the RLM gateway; and it serves ADW, Dramma, SalesCoach and RLM at once.

It also closes a duplicate nobody had noticed: `tolerantKeylessAliases` (SalesCoach, announced 2026-07-17) and the RLM validation finding (2026-09-05) **are the same item**, raised independently by two consumers, each of whom then wrote roughly fifty lines of the same workaround.

### alpha.35: "Contract corrections, and the missing chat method"

Item 8, plus alpha.28 item 15, the contract test asserting every adapter surfaces `ValidationError` with `ZodIssue[]`. A test that pins cross-adapter behaviour belongs immediately before a freeze, not after it.

Plus two items added 2026-09-09 after a consumer question exposed them. **Neither is freeze-gating**, since both are additive; they are here on value, not on deadline.

**`generateChat`: tools surfaced and not executed, without streaming.** Tools appear on `StreamChatOptions` and `RunAgentOptions` and nowhere else, so `stream: false` with `tools` has no implementation path at all. That is the default shape for most agent frameworks and for the OpenAI SDK's own tool loop, which makes it the most common request an OpenAI-compatible server receives, and it blocks the whole pattern of putting an OpenAI-shaped surface in front of this library. Cheap, because `streamChat` already built the tool-call reassembly that a whole-response call needs less of. Its `stopReason` also closes a consumer's hardcoded `finish_reason`. See `TD-LLMPORTS-NO-NONSTREAMING-CHAT-WITH-TOOLS`.

**Structured output from a JSON Schema.** `generateStructured` takes Zod only, and adapters convert it to JSON Schema anyway, so a consumer holding a wire-delivered schema converts backwards for us to convert forwards again. Add it as a separate optional field rather than widening `schema`, which keeps it additive and leaves `T` inference undisturbed. See `TD-LLMPORTS-STRUCTURED-OUTPUT-IS-ZOD-ONLY`.

### alpha.36: "Budget that persists"

Item 9. The per-scope ceiling and the Redis backend ship together because the ceiling's open design question, whether a scope budget accumulates at the Registry or delegates to the backend, **is** the backend's interface question. Answering it once is the reason these are not two releases.

Closes ADW from **0 of 5 to 5 of 5**.

### beta.1: the freeze

Surface frozen for the six packages named above.

**Blocker found 2026-09-06:** leaving pre-release mode is `changeset pre exit` then `changeset version`, and that operation currently yields **`1.0.0`**, not a 0.x beta, because a changeset from alpha.19 declares a `major` bump and pre mode has been accumulating it ever since. Every release since has quietly hand-edited versions instead. Resolve `TD-LLMPORTS-CHANGESET-VERSION-PRODUCES-1-0-0` and verify the exit on a scratch branch before cutting beta.

Requires, in addition to the eleven items:

1. **Every withdrawal made explicit**, in a release note, where the item was announced. Currently owed: `@llm-ports/express` (one asker, no second), the local-runtime items 31 and 32, and confirmation that Dramma's items 28, 29 and 30 are still wanted. Item 23, session state, is already recorded as permanently out of scope.
2. **A migration page** covering the strict-mode breaks, chiefly the `ContentBlock` widening.
3. **The "you can already do this" note** about `RegistryOptions.budget` and `.cost`. Two consumers have recorded the belief that the injectable seam is missing when it is public API in the version they have installed. That is a documentation failure and it costs one paragraph.

---

## After the freeze

Additive, as beta minors, in rough value order: the observability closeout (`onComplete`, `recentRetries`, cost on spans, opaque-400), then alpha.29's remaining ten capability-factory options, then the response cache. Then local runtime and the pipeline primitive, if the consumer confirms the ask is still live.

---

## Mechanism

Each release fills its row in [`RELEASE-JOURNAL.md`](./RELEASE-JOURNAL.md) before the next one opens, and each has a plan document in this directory before it ships. Both rules exist because their absence is what produced the four displaced themes. This document is the third: **the beta gate is a list in the repository, so that entering beta is a checkable claim rather than an announcement.**
