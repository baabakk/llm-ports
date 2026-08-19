# alpha.32 — streaming tool calls, and the first inbound integration

**Status:** Draft, not approved.
**Date:** 2026-08-19
**Motivating consumer:** a realtime voice agent built on LiveKit Agents that currently constructs a provider plugin directly, with no fallback chain, no cost ceiling, no rate limit, and no task routing. Verified at source; see section 2b.
**Numbering note:** labelled `alpha.32`. The queued `alpha.31.2` (evaluation-store persistence backends) is independent and mechanical; whichever ships first takes the lower number. The numbers are labels, not a dependency claim.

---

## 1. Why this, why now

Two independent lines of evidence, recorded in [`docs/v0-1-status.md`](../docs/v0-1-status.md) and the adoption research that fed it.

**The market split.** Provider abstraction is solved across every segment examined. Governance is not. Realtime voice frameworks ship unified APIs over 15+ providers and carry no fallback chains, no cost ceilings, no task routing. That is the exact layer this library is.

**A live consumer already failed on it.** In one day: a revoked provider key produced silent total failure with no fallback, and swapping providers to work around tool-call unreliability required a code change and a redeploy. Both are configuration concerns here and neither is under the framework's own plugin layer.

## 2. The blocker, verified in source

Read directly in `packages/core/src/ports/llm-port.ts`:

- `StreamTextOptions` (lines 424-463): no `tools` field.
- `StreamStructuredOptions` (lines 464-510): no `tools` field.
- `RunAgentOptions` (line 511 onward): the only interface carrying `tools`, at line 516.
- `runAgent` returns `Promise<AgentResult>` (line 647). Not a stream.
- No tool-call delta type exists anywhere in `packages/core/src`.

So today a caller can stream text without tools, or use tools without streaming. A realtime voice agent needs both at once: tokens streaming out for speech synthesis, and tool calls surfaced mid-stream.

## 2b. The consumer, verified at source

Read directly in the consumer repository rather than inferred from its tech-debt entry. Every claim below is a first-hand source read.

- **Framework and language.** `@livekit/agents` ^1.6.1, TypeScript, ESM, Node >= 20. The integration package therefore targets `@livekit/agents` ^1.6, and language fit is exact.
- **Tools are in use, and the consumer executes them.** `src/coach.ts` defines two tools through LiveKit's own `llm.tool({...})` helper: `select_framework` and `save_plan_draft`, both with zod parameter schemas and both carrying an `execute` handler implemented in the consumer's code. This settles the design question in section 3 with evidence rather than reasoning: the framework owns the loop and runs the handler, so the port must **surface** tool calls, never execute them.
- **Parameter schemas are zod**, which matches this library's existing `ToolDefinition` shape. No schema-dialect translation is needed on the consumer's side.
- **The swap really is one constructor.** `src/agent.ts:117-119` builds `new openai.LLM({ model: ... })` and hands it to `new voice.AgentSession({ vad, stt, llm, tts, turnDetection })` at line 136. Speech recognition, synthesis, voice-activity detection, turn detection, the crash guard, the session sync, and both tools are untouched by the change. The consumer is roughly 1,400 lines total across eight files, so blast radius is small and verifiable by reading.
- **The provider history matches the motivating story.** The repository depends on both `@livekit/agents-plugin-cerebras` and `@livekit/agents-plugin-openai`, and `src/agent.ts` carries a dated comment recording the move from Cerebras to OpenAI.

### Two findings the tech-debt entry did not capture

**A provider capability gap is being worked around in the audio path.** `src/sanitizing-tts.ts` wraps the text-to-speech component specifically to scrub leaked tool-call JSON and code fences out of the coach's text before synthesis. It exists because one provider emitted tool-call arguments as plain spoken text instead of using the tool channel. That is a **provider capability defect being compensated for downstream, in the audio layer, by a consumer that had no way to express "this task needs a provider whose tool-calling actually works."** It is the strongest concrete argument yet for the capability-declaration model that this plan defers, and it should be cited when that work is scoped: the alternative to declarative capability routing is a text scrubber in front of a speech synthesizer.

**The framework plugin constrains model choice at the type level.** A comment at `src/agent.ts:110-116` records that the desired model could not be selected because the plugin's `ChatModels` union does not include that tier, so a larger model was chosen instead. This library treats model identifiers as configuration strings, so that constraint disappears on adoption. Minor next to governance, but it is a real friction the consumer hit and wrote down, and it costs nothing to mention in the integration's documentation.

## 3. A naming correction that came from reading the target contract

An earlier sketch of this work called the new method `streamAgent`. Designing against LiveKit's actual interface shows that is wrong, and the distinction is load-bearing rather than cosmetic.

`runAgent` **executes** tools. It owns the tool-use loop, runs to `maxSteps`, and returns a finished result. LiveKit does not want that. LiveKit's `chat()` returns a stream of chunks including tool calls, and the framework's own agent executes them and feeds results back. It owns the loop.

What is needed is therefore **one streamed model turn with tool calls surfaced and not executed**. That is streaming chat with tool support, not a streaming agent. Naming it `streamAgent` would promise a loop this method must not run.

**Decision: `streamChat`.** It maps directly onto the framework method it will serve, and it leaves the name `streamAgent` free for a genuinely loop-executing streaming variant later, which is a real and separate future want.

## 4. Scope

### In

**4.1 `streamChat` on `LLMPort`.**

```ts
streamChat(options: StreamChatOptions): AsyncIterable<ChatStreamEvent>;
```

`StreamChatOptions` mirrors `StreamTextOptions` (taskType, priority, messages, maxOutputTokens, temperature, signal, perAttemptTimeoutMs, forceProviderAlias, reasoningEffort, providerExtras, cacheControl) and adds `tools?: Record<string, ToolDefinition>` plus an optional tool-choice hint. Reusing the existing `ToolDefinition` shape is deliberate: tool definitions must mean the same thing across `runAgent` and `streamChat`, or the schema-conversion guarantee in 4.4 cannot hold.

**4.2 The event union.** A discriminated union rather than a string, so the caller can distinguish speech from control flow:

- `text-delta` — a token or span of assistant text. This is the only event a naive consumer needs.
- `tool-call` — a completed tool call with id, name, and parsed arguments. Emitted when the call is fully assembled, not per-fragment. See 7.1.
- `step-finish` — one model turn ended, carrying the stop reason.
- `finish` — terminal. Carries `usage`, `cost`, `modelId`, and `providerAlias`, which is what preserves cost accounting in a streamed context.
- `error` — terminal, when the chain is exhausted.

**4.3 Registry participation.** `streamChat` goes through the same routing, fallback, budget gating, and instrumentation as every other port method. This is the entire point: the consumer gains governance it does not currently have. Streaming instrumentation already exists from alpha.30, including the manual `startOperation` / `completeOperation` hatches that streaming requires, so this reuses rather than invents.

**4.4 The tool-schema-across-failover guarantee, with a test.** Tool schemas must be converted **per attempt**, by the adapter serving that attempt, never once upstream and reused. This is believed true today by construction, but "believed true by construction" is not a claim that can be made publicly. A test must exist that fails if schema preparation is hoisted above the attempt boundary. A defect of exactly this shape is reported in another project, where a fallback model rejects the primary model's tool definitions, which makes this a differentiator worth naming rather than an internal detail.

**4.5 One adapter, not all of them.** `adapter-openai` only for this release. Confirmed sufficient by section 2b: the consumer's two providers are OpenAI and Cerebras, and Cerebras reaches through the same adapter via a `baseURL` override. Other adapters declare the capability absent and are unaffected.

**4.6 `@llm-ports/integration-livekit`.** A class implementing LiveKit's `LLM` abstract with `chat()` returning an `LLMStream`, adapting `ChatContext` inward and `ChatChunk` outward.

**Category note, decided deliberately because it sets precedent.** Every existing adapter points *outward*, from this library to a provider. This points *inward*, from a framework into this library. Calling it `adapter-livekit` would collide with the established meaning of "adapter" in this codebase and mislead every reader. The `integration-*` prefix names the inbound direction. The adoption research implies a family of these, so the convention is documented in this plan rather than settled incidentally by whichever package ships first.

### Out

- **The capability-declaration model.** The right long-term home for "what can this adapter do," serving both routing and streaming detection. Deferred deliberately: a runtime optional-method check unblocks this release, and the general model can subsume it later without a break. Shipping the narrow mechanism first is the smaller risk. Filed as debt so the temporary duplication is visible.
- **`totalDeadlineMs`.** The correct realtime primitive (spend a total budget across attempts however you like, rather than capping each attempt independently), but gated on the measurement in section 6. `taskDefaults` from alpha.30 already expresses a per-task attempt timeout, which is enough to configure a realtime profile for this release.
- **Other adapters, `streamAgent` proper, and Pipecat.** Later, on demand.

## 5. Phasing

Each phase is independently shippable and leaves the tree green.

1. **Types and contract.** `StreamChatOptions`, `ChatStreamEvent`, the optional `LLMPort` method. No implementation. Consumer-type-check package proves the surface compiles for a consumer.
2. **`adapter-openai` implementation**, plus the per-attempt schema-conversion test from 4.4.
3. **Registry participation:** routing, fallback, budget, instrumentation, capability check with an honest error when an adapter lacks support.
4. **`@llm-ports/integration-livekit`**, with a contract test against LiveKit's expected shapes.
5. **Consumer swap**, which is one constructor change on the consumer side, then real-call verification.

## 6. The measurement that gates the realtime story

Published production telemetry for voice agents runs roughly 680ms median and 1,180ms at the 95th percentile **end to end**, including speech recognition and synthesis. The model call is one segment of that.

Before phase 4, measure: time to first `text-delta` through the Registry versus a direct adapter call, and the same when the first provider fails and the chain walks.

This is a genuine risk to the premise, and it should be treated as one. If a chain walk cannot fit inside a conversational budget, then the honest realtime answer is fail-fast with a degradation hook rather than fallback, and section 4.3's value proposition for this consumer narrows to cost ceilings and routing. Better to learn that from a measurement than from a production call.

## 7. Open questions

**7.1 Tool-call granularity.** The plan emits `tool-call` only when a call is fully assembled. Providers stream tool arguments incrementally, and LiveKit's chunk type can carry partial calls. Buffering is simpler and safe; passing fragments through would let a consumer start work earlier but exposes provider-specific fragmentation. **Recommendation: buffer for this release**, and revisit only if a consumer demonstrates it matters. Emitting fragments is additive later; retracting them is not.

**7.2 Interleaving.** Whether text deltas and tool calls can interleave within one step is provider-specific. The union permits it; adapters must not reorder.

**7.3 Cancellation mid-tool-call.** `signal` already threads through, which barge-in needs. What is undefined is whether a tool call already surfaced but not yet executed should be reported as cancelled. Needs a decision before phase 3.

## 8. What "done" means

`streamChat` ships on `LLMPort` and `adapter-openai`, routed and gated through the Registry with instrumentation. The per-attempt schema-conversion guarantee has a test that fails on the hoisted-preparation behavior. `@llm-ports/integration-livekit` exists with a contract test. The motivating consumer runs on it through a real call, and a deliberately revoked primary key results in a working conversation on the fallback provider rather than silence.

That last sentence is the actual acceptance test. Everything above it is scaffolding.

Concretely, on the consumer side, done means `src/agent.ts:117` constructs the integration's LLM instead of `openai.LLM`, nothing else in those eight files changes, both existing tools still fire, and `src/sanitizing-tts.ts` can stay exactly where it is. Removing that scrubber is not in scope here; it becomes possible only once capability-aware routing can guarantee a provider whose tool channel works, and that is deliberately deferred.
