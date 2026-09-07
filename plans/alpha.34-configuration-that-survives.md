# alpha.34: "Configuration that survives an incomplete deployment"

**Status:** Planned, not started. Written 2026-09-06, before any code, so that the plan and the result stay comparable afterwards.
**Journal row:** [`RELEASE-JOURNAL.md`](./RELEASE-JOURNAL.md). Not finished until that row is filled.
**Gate:** items 3 to 7, 10 and 11 of the beta gate in [`ROAD-TO-BETA.md`](./ROAD-TO-BETA.md).

## Why these seven together

They are one theme with one sentence: **a registry should admit what it can serve and say why it cannot serve the rest, instead of refusing everything.**

Today it does the opposite in three separate ways. One unregistered adapter throws away every other correctly configured provider. A model with no published price is unroutable even when nobody asked for cost enforcement. And the only way to configure any of it is environment-variable strings, whose names cannot express a real model id.

Every one of those has a consumer workaround in production right now, and two of them have the *same* workaround written twice by two different consumers a year apart.

This also repays three announced alpha.28 items (11, 12, 13) and closes three of the four findings from the RLM gateway review.

## Prior art searched

Checked before designing. `tolerantKeylessAliases` (SalesCoach, alpha.28 item 13) and `TD-LLMPORTS-CONFIG-VALIDATION-ALL-OR-NOTHING` (RLM, 2026-09-05) are **the same request**, filed independently thirteen months apart, and each asker then wrote roughly fifty lines of the same pre-filter. That duplication is the strongest evidence in this plan that the default is wrong rather than merely inconvenient.

No existing helper in the tree does either job. The warning channel does exist: `createWarningState` / `warnOnce` in `packages/core/src/utils/deprecation.ts`, reachable through `RegistryOptions.deprecationWarningHandler`. Item 3 reuses it rather than adding a second channel.

---

## The research changed the shape of this release

The pricing items looked like a one-line guard change. Reading the code says otherwise, and the plan is written against what is there.

**Finding 1: the pricing guard blocks admission over a value the Registry never reads.** `ModelSelection.pricing` is populated at all three selection sites and has **no consumers anywhere in `packages/core/src`**. Adapters compute cost from their own tables, reached through `pricingFor(ctx, modelId)`, not from the selection.

**Finding 2: every adapter throws a raw untyped `Error` when its table lacks the model.** `adapter-openai/src/adapter.ts:328`, `adapter-anthropic:151`, `adapter-google:141`, `adapter-vercel:128`. So simply relaxing the Registry guard would move a clean refusal into an untyped throw deep inside a call, which the fallback classifier cannot categorise and which violates this project's own rule that no untyped exception escapes an adapter.

**Consequence: item 4 is not a Registry change, it is a cost-model change**, and it forces the question the Registry has been avoiding. Cost is currently a required field on every result. If a model can be admitted without a price, some calls have no knowable cost, and the shape has to say so.

**Finding 3: the guard sits outside the P0 bypass.** `priority > 0` skips budget and cost gating entirely, but the pricing check runs regardless, so a P0 call is refused today for want of a price that nobody was going to enforce.

---

## The decision: three pricing states, not two

The whole release turns on this. Today pricing is present or absent, and absent means unroutable. That conflates two different things, and the conflation is why the workarounds exist.

| State | Meaning | `cost` on the result |
|---|---|---|
| **priced** | A rate is known | computed `CostUsage` |
| **free** | Genuinely costs nothing, declared deliberately | `CostUsage` of zeros |
| **unknown** | No rate available | **`undefined`** |

`undefined` rather than zeros, deliberately. **A zero is indistinguishable from a genuine zero-cost call**, and this project has already been bitten by exactly that shape twice: streamed calls reporting `gen_ai.usage.*` as `0` rather than omitting it, and the RLM gateway inventing a $1-per-million placeholder that will silently become a budget input the day it enables a cost gate. `undefined` cannot be mistaken for a measurement.

That makes `cost` optional on results, which is a TypeScript-strict break for every reader, which is exactly why this release sits before the beta freeze.

### The admission matrix

Every pricing state against every gating state, enumerated rather than left implicit.

| | no cost gate (`unlimited`, or request-count only) | cost-gated (`kind: "usd"`) |
|---|---|---|
| **priced** | admit; report cost | admit; gate on cost |
| **free** | admit; report zeros | admit; cost is always zero, gate never trips |
| **unknown** | **admit; `cost: undefined`** | `pricingPolicy` decides |

`pricingPolicy` therefore governs exactly one cell, which is the cell where a caller asked for money to be enforced and no rate exists:

- `"throw"` (default): refuse the alias, as today. Preserves current behaviour for anyone actually cost-gating.
- `"warn"`: admit, warn once per model, report `cost: undefined`.
- `"silent"`: admit, no warning.

Nothing else consults it. An alias with no cost gate is never refused for want of a price again.

---

## Items

### Item 1: drop-and-warn instead of throwing the whole registry away

*alpha.28 item 13 (SalesCoach A) and `TD-LLMPORTS-CONFIG-VALIDATION-ALL-OR-NOTHING` (RLM).*

`validateConfig` throws `ConfigError` in the constructor on the first provider whose adapter is unregistered, then on the first task chain referencing an unconfigured alias. Nine configured vendors and eight keys yields zero providers.

Change: an alias whose adapter is absent is dropped, and dropped from every chain referencing it. A chain left empty is dropped. Each drop is reported once through the existing warning channel. **Throw only if the result is an empty registry**, which is the genuinely unusable outcome.

Add `strictConfig?: boolean` for anyone wanting today's behaviour, default `false`. Default-false is the point: the common case is a deployment holding a subset of keys, not a typo.

### Item 2: pricing required only when it will be enforced

*`TD-LLMPORTS-PRICING-REQUIRED-WITHOUT-COST-GATE` (RLM).*

Implements the matrix above at the three selection sites. `entry.costLimit.kind === "unlimited"` is already in scope, so the Registry side is small; the work is the cost model.

### Item 3: `pricingPolicy: "throw" | "warn" | "silent"`

*alpha.28 item 11 (ADW F).* Governs the one cell named above. `RegistryOptions`, defaulting to `"throw"`.

### Item 4: `pricing: 'free'` on `AdapterRegistration`

*alpha.28 item 12 (Dramma 2a).* Widens `pricing` to `Record<string, ModelPricing> | "free"`.

Not redundant with a zero-rate table entry, for a reason the ask did not spell out and the code makes obvious: **an adapter with an open-ended model set cannot enumerate its models at all.** A local Ollama server serves whatever the operator pulled. Today every one of those models is unroutable unless someone hand-writes a pricing entry per model name. `"free"` is the honest declaration for a runtime that does not bill.

### Item 5: `config?: RegistryConfig` on `RegistryOptions`

*`TD-LLMPORTS-NO-PROGRAMMATIC-REGISTRY-CONFIG` (RLM).*

Purely additive, taking precedence over `env` when both are given. `RegistryConfig` and `parseRegistryConfig` are already exported; the constructor simply will not accept the parsed result.

The env path stays the default and stays correct for the twelve-route case. It should not be the only door: a provider alias is derived from the environment variable's own name, so a model id containing `/`, `.` or capitals cannot be named, which is why one consumer maintains a 392-entry catalogue, roughly 784 synthesized env vars and opaque `m0001` route ids.

### Item 6: `@llm-ports/core` becomes a peer dependency of every adapter

*`TD-LLMPORTS-CORE-IS-A-DEP-NOT-A-PEER-DEP`, severity High.*

Two copies of core make every `instanceof` in the fallback classifier return false, and failover stops with no error and no log line.

Also brand the error classes with a `Symbol.for("llm-ports.error")` marker checked alongside `instanceof`, so the taxonomy survives duplicate copies instead of merely discouraging them. Packaging discipline prevents the common case; the brand prevents the silent one.

### Item 7: rename one of the two things called "default" fallback

*`TD-LLMPORTS-TWO-THINGS-CALLED-DEFAULT-FALLBACK`.*

Export the Registry's actual default preset as a named `conservativeShouldFallback` and have `resolveRuntimeFallback` return it by name, rather than an anonymous closure. Document both walk-tables side by side and state which one `runtimeFallback: undefined` selects.

Preferred over renaming `defaultShouldFallback`, because it turns the real default into a thing that can be named, documented and tested, rather than only relabelling the confusing half.

---

## Acceptance

- The admission matrix is covered cell by cell, including the P0 path, which currently bypasses gating and is refused for pricing anyway.
- A registry configured with nine providers and eight keys serves eight, warns once about the ninth, and does not throw.
- A cost-gated alias with no price still refuses under the default policy, so nobody currently enforcing a budget silently stops.
- An unpriced model reports `cost: undefined`, never zero. Asserted directly, because the failure mode being avoided is a plausible-looking number.
- No adapter throws an untyped `Error` for missing pricing on any path.
- A test proves the error brand survives two copies of the taxonomy, by constructing an error from a duplicated module and classifying it.

## Out of scope

The remaining alpha.28 items, and the alpha.29 capability-factory slate. They are additive and ship after the freeze, where a minor bump is safe to take.

The `deprecationWarningHandler` name is a poor fit for config warnings, which this release adds to it. Noted rather than renamed: a second public rename in one release is scope creep, and item 7 already spends the rename budget.

## Changelog

- **2026-09-06.** Written before implementation. Research revised the release from "relax a guard" to "give cost three states", after finding that the guarded value has no consumers in core and that all four adapters throw untyped errors when pricing is missing.
