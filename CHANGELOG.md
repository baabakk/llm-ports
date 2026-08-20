# Changelog

`llm-ports` uses [Changesets](https://github.com/changesets/changesets) to manage releases. Each published package keeps its own per-version changelog beside the source:

| Package | Per-package changelog |
|---|---|
| `@llm-ports/core` | [`packages/core/CHANGELOG.md`](packages/core/CHANGELOG.md) |
| `@llm-ports/capabilities` | [`packages/capabilities/CHANGELOG.md`](packages/capabilities/CHANGELOG.md) |
| `@llm-ports/observability-contract` | [`packages/observability-contract/CHANGELOG.md`](packages/observability-contract/CHANGELOG.md) |
| `@llm-ports/eval` | [`packages/eval/CHANGELOG.md`](packages/eval/CHANGELOG.md) |
| `@llm-ports/adapter-anthropic` | [`packages/adapter-anthropic/CHANGELOG.md`](packages/adapter-anthropic/CHANGELOG.md) |
| `@llm-ports/adapter-openai` | [`packages/adapter-openai/CHANGELOG.md`](packages/adapter-openai/CHANGELOG.md) |
| `@llm-ports/adapter-google` | [`packages/adapter-google/CHANGELOG.md`](packages/adapter-google/CHANGELOG.md) |
| `@llm-ports/adapter-ollama` | [`packages/adapter-ollama/CHANGELOG.md`](packages/adapter-ollama/CHANGELOG.md) |
| `@llm-ports/adapter-vercel` | [`packages/adapter-vercel/CHANGELOG.md`](packages/adapter-vercel/CHANGELOG.md) |
| `@llm-ports/adapter-codex` | [`packages/adapter-codex/CHANGELOG.md`](packages/adapter-codex/CHANGELOG.md) |
| `@llm-ports/adapter-aider` | [`packages/adapter-aider/CHANGELOG.md`](packages/adapter-aider/CHANGELOG.md) |
| `@llm-ports/telemetry-otel` | [`packages/telemetry-otel/CHANGELOG.md`](packages/telemetry-otel/CHANGELOG.md) |

This root file aggregates the **release-level** notes — the user-facing summary of what changed across all packages in a given version, breaking changes, and migration guidance.

## v0.1.0-alpha.32 — 2026-08-19

Streaming with tool calls, and the first inbound integration.

### `streamChat` — one streamed turn, tool calls surfaced not executed

`streamText` streams tokens but cannot carry tools at all. `runAgent` takes tools but owns the loop and resolves once, so the caller sees nothing until it finishes. Realtime speech needs both halves simultaneously: tokens as they arrive so synthesis can start, and tool calls mid-stream so the caller can run them.

`streamChat` is that middle. It is **optional on `LLMPort`**; detect it with `typeof port.streamChat === "function"`.

```ts
for await (const event of port.streamChat({ taskType: "voice", messages, tools })) {
  if (event.type === "text-delta") speak(event.text);
  if (event.type === "tool-call") await runMyTool(event.toolName, event.args);
}
```

Events are a discriminated union: `text-delta`, `tool-call`, `step-finish`, `finish` (carrying usage and cost, which is what keeps cost accounting intact when a response arrives in pieces), and `error`.

**It is not called `streamAgent` on purpose.** That name would promise a loop this method must not run, and it leaves `streamAgent` free for a genuinely loop-executing streaming variant later.

Tool calls are buffered until fully assembled rather than forwarded as fragments. Providers stream arguments a few characters at a time in provider-specific shapes; passing that through would make every consumer reimplement reassembly. Buffering is additive to undo later, fragments are not.

Registry participation is full: routing, fallback chains, budget gating, and instrumentation. Adapters lacking the method are filtered out of the chain before it is walked rather than attempted and failed, and when nothing in a chain supports it the error names every alias and says what is missing.

Implemented on `@llm-ports/adapter-openai`, which also covers OpenAI-compatible endpoints through `baseURL`.

### `@llm-ports/integration-livekit` — a new package, and a new category

Routes a LiveKit Agents voice agent through an `LLMPort`. LiveKit already abstracts providers, so that is explicitly **not** what this adds. What its LLM layer does not carry is governance: no fallback chain, no cost ceiling, no per-provider budget, no task routing. Under a port all four are configuration.

**On the name.** Every `adapter-*` package points outward, from the port to a provider. This points inward, from a framework into the port. Reusing "adapter" would invert its meaning, so inbound packages take the `integration-` prefix. Expect siblings.

### The latency gate, measured rather than asserted

The plan gated this design on measuring time-to-first-token, because an unmeasured realtime claim is a slogan. Results in [`packages/core/bench/STREAM-CHAT-RESULTS.md`](packages/core/bench/STREAM-CHAT-RESULTS.md):

- Routing through the Registry: **0.036 ms** at p50.
- Each fallback hop: **0.33 ms** at p50.

Against a roughly 680 ms conversational budget those are 0.005 and 0.05 percent. The gate passes with room to spare.

It also moved a decision. The plan proposed `totalDeadlineMs` as the necessary realtime primitive; the measurement shows the risk it guards against does not come from this library. A dead provider in production costs whatever its failure takes, which is governed by `perAttemptTimeoutMs`, an existing setting. `totalDeadlineMs` stays on the roadmap as a convenience and is no longer gating anything.

### Found while building this: streamed fallback has never worked

`walkStreamChain` opens a provider stream inside a `try` and treats a throw as the signal to walk on. Every adapter implements streaming as an async generator, and calling one returns a generator object **without running any of its body**, so the call that contacts the provider does not happen until the consumer iterates, long after the walker returned.

`streamText` and `streamStructured` therefore do not fall back at all, on any released version. `streamChat` avoids it by priming: pulling the first event inside the walker's try, where a failure can still be acted on.

The fix for the other two methods is small and deliberately **not** in this release, because changing the failure semantics of two shipped methods is a behaviour change that deserves its own notes rather than a ride-along in a feature release. Tracked as `TD-LLMPORTS-STREAM-FALLBACK-NEEDS-PRIMING` at High.

### Verification

37 new tests: 12 in core covering Registry behaviour, 10 in `adapter-openai` covering fragment reassembly and per-attempt schema conversion, 15 in the integration covering the mapping in both directions. Core 609 of 609. Full workspace green.

## v0.1.0-alpha.31.2 — 2026-08-19

Pays the evaluation scope announced for alpha.31 and displaced by the hotfix that shipped under that number. `@llm-ports/eval` only; no other package changes.

### Postgres backend

`createPostgresEvaluationStore` implements `EvaluationStore` with semantics identical to the SQLite backend. `pg` is an optional peer. Dedup uses `ON CONFLICT DO NOTHING`, which returns the exact boolean the contract requires in one statement, removing SQLite's exception-as-control-flow and its read-then-write race.

**ClickHouse is withdrawn, not deferred.** Its deduplication happens only during background merges at unpredictable times, and ClickHouse's own documentation says the `FINAL` read modifier "offers eventual correctness only, it does not guarantee rows will be deduplicated, and you should not rely on it." `insert_deduplication_token` fits better but is window-bounded and still cannot produce `write()`'s exact boolean. The mismatch is structural rather than a matter of effort.

### The workflow layer

Verified while building it: **this package stores evaluations, not what was evaluated.** `EvaluationTarget` is a pointer, the sink bridge forwards only `evaluation.recorded`, and `request_fingerprint` is a hash. Regression detection is unaffected; judging, review, and comparison are not.

The answer is `OperationSource`, a read-only port implemented by the consumer over infrastructure they already run, rather than a second store here duplicating their log pipeline. Content on it is optional, because `CapturePolicy` defaults to strict, and absent content is reported rather than thrown.

New: `aggregateScores`, `detectRegression`, `sampleEvaluations`, `runBatchJudge`, `runComparison`, `createInMemoryOperationSource`.

### Three decisions worth reading before you use it

- **`detectRegression` never returns a verdict.** Deltas and counts only. Significance testing on the sample sizes typical here is a real statistical problem, and a confident answer from eleven samples is worse than a number beside the count.
- **A budget refusal stops a judge run.** It does not complete what it can afford. A partial evaluation that looks complete is worse than a refused one.
- **`runComparison` sends nothing by default.** It scores the recorded response. Live replay is opt-in, because the difference is a bill.

This package still does not call a model, and still does not depend on `@llm-ports/core`. Judges and replay functions are supplied by the caller, so evaluation inherits the caller's governance rather than reimplementing it.

### Verification

57 new tests. Eval package 94 of 94. Full workspace green across 13 packages, with one caveat recorded honestly: `TD-LLMPORTS-FINGERPRINT-CACHE-FLAKY-TEST` documents a non-deterministic test in `adapter-openai` found during this release's verification, which weakens "workspace green" as a signal until it is fixed.

## v0.1.0-alpha.31.1 — 2026-08-19

Correctness and type-compatibility fixes. No new features. Both items came from consumers reporting real friction, and both are additive.

### `RegistryOptions.auth` — authentication state is now injectable

Alpha.30 began tracking which provider aliases have ever authenticated successfully, because that decides whether an authentication failure should walk to the next provider (the alias never authenticated, so the key is simply dead) or abort (the alias authenticated earlier, so something changed underneath the process and quietly degrading would hide it).

That state was a private field on each Registry instance. An application holding two Registry instances therefore held two independent copies, and the same credential failing on the same alias could be classified differently by each, decided by whichever authenticated first. Nothing logged it and nothing failed loudly.

The store is now injectable, matching the treatment `BudgetBackend` and `CostBackend` already had:

```ts
import { createRegistryFromEnv, InMemoryAuth } from "@llm-ports/core";

const auth = new InMemoryAuth();
const fast = createRegistryFromEnv({ adapters, auth });
const heavy = createRegistryFromEnv({ adapters, auth });
// A successful auth seen by one is now seen by the other, so both classify
// a later failure on that alias identically.
```

New exports: the `AuthBackend` interface and the `InMemoryAuth` default implementation. `Registry.auth` is public so a consumer can inspect or seed it, and a deployment that already knows a key is good can call `markAuthenticated` without making a call first.

**Nothing changes if you do not pass the option.** Each Registry still gets its own fresh `InMemoryAuth`, which reproduces alpha.30 exactly.

**Scope limit, stated plainly.** `AuthBackend` is synchronous, unlike the budget and cost backends. `Registry.hasEverAuthenticated()` is a public sync method and the value is read inside error classification, which is a sync decision path; making it async would break that API and push `await` into error handling for a set-membership test. The practical consequence is that this closes the reported defect (several Registry instances in one process) and does not by itself perform blocking cross-process reads. An implementation can serve a locally-cached snapshot that some other mechanism refreshes, but that refresh is the implementation's concern. A genuinely async variant remains open work.

Reported as `TD-LLMPORTS-AUTH-STATE-NOT-PLUGGABLE`.

### `@llm-ports/telemetry-otel` — the `Tracer` interface now unifies with `@opentelemetry/api`

The package declares its own minimal `Tracer`, `SpanOptions`, and `Attributes` types so it can stay dependency-free. Two of those declarations did not unify with the real OpenTelemetry types, so every adopter had to add an `unknown` cast when passing a real tracer to `createOtelSink`:

- `Tracer.startSpan` was arity-2 while the real one is `startSpan(name, options?, context?)`. TypeScript will not widen a two-parameter function type to accept a three-parameter one. The third parameter is now declared and typed `unknown`, since the sink never passes it and declaring it this way avoids taking `@opentelemetry/api` as a peer dependency.
- `AttributeValue`'s array variants were `ReadonlyArray<...>` while the real ones are mutable `Array<...>`. TypeScript will not assign a readonly array to a mutable one. Now mutable.

Both were safe at runtime; the cost was compile-time only. Adopters carrying the cast can remove it. Reported as `TD-LLMPORTS-TELEMETRY-OTEL-TRACER-VARIANCE`.

### Correction to the alpha.30 release notes

The alpha.30 entry below states "fully additive; existing consumers see identical behavior when they don't opt into the new fields." **That was not true for consumers holding more than one Registry instance.** For them, alpha.30's per-instance authentication tracking changed error classification on code that was never touched and never opted in. The claim is corrected here rather than edited in place, so the original text and its correction both stay visible. The underlying defect is fixed above.

### Verification

11 new tests in `packages/core/tests/auth-backend.test.ts` cover the default isolation, shared-backend convergence, both registries agreeing on one credential, custom implementations, and `InMemoryAuth` in isolation. The existing 17-test authentication suite is unchanged and still passes. Core 597 of 597 (up from 586). Full workspace green across 13 packages.

---

## v0.1.0-alpha.31 — 2026-08-19

### Scope note

This release is a single-issue hotfix, not a feature release. The scope previously announced for alpha.31 (`@llm-ports/eval` persistence backends beyond SQLite, plus evaluation-workflow tooling) was displaced by the unblocker below. That work is queued in [docs/v0-1-status.md](docs/v0-1-status.md#near-term-alpha-queue) rather than silently reassigned to a later version number.

### What changed

Per-call `operation_id` precedence via `withObservabilityContext(port, ctx)`. Alpha.29 shipped `Instrumentation.context.operation_id` as a Registry-level (config-time) pinning slot, but the Registry still minted a fresh id per port method call regardless of what the caller wrapped the port with. Alpha.31 closes that gap: the Registry's five port methods (`generateText`, `generateStructured`, `runAgent`, `streamText`, `streamStructured`) now pass `getObservabilityContext(this)` into `withOperation` / `startOperation`, honoring a caller-supplied per-call context first. Fully additive; existing callers see identical behavior.

### New precedence chain

Any of the three levels may be present or absent — the Registry falls through in order:

1. `withObservabilityContext(port, { operation_id }).method(...)` — caller's id lands on every emitted lifecycle event for that call.
2. Registry-level `Instrumentation.context.operation_id` — the alpha.29 behavior, preserved.
3. Fresh mint via `newOperationId()` — the pre-alpha.29 behavior, still the default for uninstrumented consumers.

### API changes

- `startOperation(instrumentation, params, perCallContext?)` — new optional third parameter `perCallContext?: ObservabilityContext`.
- `withOperation(instrumentation, params, work, perCallContext?)` — new optional fourth parameter.

Both default to `undefined`; existing call sites see no change.

### Why it exists

BEPA's Plan 58 §5.4 slice 3b (quality-tracker re-key on `operation_id`) needed a way for capability wrappers to pre-mint an id and have it flow through every lifecycle event, enabling cross-store joins between quality-tracker Redis entries, incident-logger DB rows, and OpenTelemetry spans by shared `operation_id`. Alpha.31 unblocks that. Any consumer with the same shape (facade wrapping the port at a per-call boundary) benefits.

### Verification

9 new tests in `packages/core/tests/per-call-operation-id.test.ts` cover per-call/Registry-level/fresh-mint/both-set precedence on `generateText`, applied consistently to all five port methods, plus distinct-scoped-ports-for-distinct-calls. Core 586/586 (was 577 + 9 new). Full workspace green (13 packages, zero regressions).

### Migration notes

Bump `@llm-ports/core` (plus any adapter you depend on — every adapter and capabilities package bumped in lockstep because their workspace deps promote): `alpha.30` → `alpha.31`. No code changes required. Opting into per-call context is one line at the call site:

```ts
import { withObservabilityContext } from "@llm-ports/core";

const scopedPort = withObservabilityContext(registry.getPort(), {
  operation_id: myMintedId,
});
const result = await scopedPort.generateText({ ... });
// Every emitted event (llm.operation.started, llm.attempt.*, .completed, ...)
// carries operation_id = myMintedId.
```

## v0.1.0-alpha.30 — 2026-08-14

### What changed

Streaming instrumentation, adapter-side emission, provider-cache normalization, and an OpenTelemetry companion package. Closes both alpha.29 carve-outs (`TD-ALPHA29-ADAPTER-EMIT-DEFERRED`, `TD-ALPHA29-AGENT-STEP-EVENTS-DEFERRED`) and both SalesCoach TDs (`TD-LLM-AUTH-ERROR-KILLS-THE-WHOLE-CHAIN`, `TD-CALLPLAN-CHAIN-TIMEOUT-STARVATION`). Fully additive; existing consumers see identical behavior when they don't opt into the new fields.

### New

- **`@llm-ports/core` — streaming instrumentation.** `streamText` / `streamStructured` now emit the same operation + attempt lifecycle as non-streaming methods, plus `AttemptCompletedData.stream_stats`: `ttft_ms`, `total_stream_duration_ms`, `chunk_count`, `inter_chunk_latency_p50_ms` / `_p99_ms` (from real per-chunk timings), `termination: "complete" | "aborted" | "error"`. New `llm.stream.chunk` event fires per chunk when `CapturePolicy.stream_chunk_capture === "full"`; content on the chunk event is gated by the content policy. Four new manual operation hatches (`startOperation`, `completeOperation`, `failOperation`, `cancelOperation`) compose with the existing attempt hatches — streaming completion is spread across consumer iteration, so wrap-around doesn't fit.
- **`@llm-ports/core` — provider-cache normalization.** Native `TokenUsage.cacheReadTokens` / `.cacheWriteTokens` fold into `CacheStats.provider_cache` on `llm.attempt.completed` at the Registry boundary. Same shape for OpenAI, Anthropic, Google, and the streaming path.
- **`@llm-ports/core` — adapter-emission scaffold.** `resurrectOperationContext(port)` retrieves the running `OperationContext` when the Registry (or a direct-caller `withObservabilityContext`) plumbed one down via an opaque `operation_handle` on `ObservabilityContext`. Four new agent-event emit helpers (`emitAgentStepStarted`, `emitAgentStepCompleted`, `emitAgentToolCalled`, `emitAgentToolReturned`). `sha256Hex` + `hmacSha256Hex` re-exported from `@llm-ports/observability-contract` so adapters compute digests without needing to add the contract package as a direct dep.
- **`@llm-ports/observability-contract` — streaming contract.** New `StreamStats` + `StreamChunkData` types, `llm.stream.chunk` lifecycle event, `AttemptCompletedData.stream_stats` optional field, and new `FallbackCause.provider_authentication_never_established`.
- **`@llm-ports/adapter-openai` / `-anthropic` / `-google` — agent-loop events.** All three now call `resurrectOperationContext(this)` at the top of `runAgent` and emit `agent.step.started` + `.completed` per LLM turn, `agent.tool.called` + `.returned` per tool call (with sha256 digests of arguments + results).
- **`@llm-ports/adapter-codex` / `-aider` — shared-service refactor.** Both subprocess adapters now compose `withOperation` + `withAttempt` instead of duplicating `sink.emit(buildEvent(...))` blocks. Spawn errors wrap as `AdapterInternalError` inside the withAttempt work so emitted events keep `cause_category: "port_internal"`.
- **`@llm-ports/telemetry-otel@0.1.0`** — new publishable package. `createOtelSink({ tracer, meter? })` bridges every contract event to OTel gen_ai spans + metrics per the [gen_ai semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Zero runtime dependencies; the package declares a minimal `Tracer` / `Meter` subset of `@opentelemetry/api` v1 and consumers pass their real OTel instances (structural match). Metrics optional — pass `meter` for histograms, omit for tracing-only mode. Toggles: `emitStreamChunkEvents` / `emitAgentEvents` (default true).

### Fixed

- **`@llm-ports/core` — auth-error walk-vs-abort (SalesCoach `TD-LLM-AUTH-ERROR-KILLS-THE-WHOLE-CHAIN`).** `defaultShouldFallback` now takes an optional `ShouldFallbackContext` (`providerAlias`, `hasEverAuthenticated`) and walks on `AuthenticationError` only when the provider has never authenticated in the current process. A dead position-4 key at chain-open falls forward; a mid-flight auth failure on a previously-authenticated provider aborts. `probeCredentials(chain?, options?)` gains an opt-in two-tier `probeWithGenerationFallback` mode for adapters where `listModels` is authoritative but not exhaustive.
- **`@llm-ports/core` — per-attempt timeout precedence (SalesCoach `TD-CALLPLAN-CHAIN-TIMEOUT-STARVATION`).** `resolvePerAttemptTimeoutMs(taskType, callOverride)` implements a 4-step precedence chain: call override → task-declared default → Registry default → undefined. Single global 15s cap no longer starves later chain positions on long-tail tasks.
- **`@llm-ports/core` — diagnostic fields on every completed attempt.** `AttemptCompletedData.response_char_count` always emits verbatim; `.response_preview` emits only when `CapturePolicy.content` is `"full"` or `"redacted"` AND `.responsePreviewMaxChars > 0` (default 0 in strict, 200 in permissive).
- **`@llm-ports/core` — observability-context proxy bind.** `withObservabilityContext` now binds methods to the wrapped proxy (receiver) instead of the underlying target. That's what makes `resurrectOperationContext(this)` inside `runAgent` walk back to the outer op — the proxy is the instance the context is registered against. Destructured calls still work (receiver at bind time is the proxy).

### Changed

- Nothing breaking at the public API surface. Every new field is additive; existing callers see identical behavior when they don't opt in.

### Migration notes

Bump every `@llm-ports/*` peer dep in your `package.json` from `alpha.29` to `alpha.30`. No code changes required. Wiring the new streaming, cache, and OTel surfaces is opt-in. Add `@llm-ports/telemetry-otel` as a new dependency if you want OTel semconv bridging.

Consumers currently on the `default` shouldFallback preset who want the alpha.30 walk-vs-abort auth policy should switch to `{ shouldFallback: defaultShouldFallback }` from `@llm-ports/core` explicitly — the unnamed default preset (`undefined`) keeps the alpha.28+ compat behavior with the ctx-aware `AuthenticationError` walk added on top.

## v0.1.0-alpha.29 — 2026-08-11

### What changed

Runtime observability instrumentation. The Registry now emits the full alpha.28 observability contract lifecycle when instrumentation is configured. Fully additive; existing consumers see identical behavior when they don't opt into the new fields.

### New

- **`@llm-ports/core`**: shared instrumentation service at `src/instrumentation.ts` — `withOperation`, `withAttempt`, `emitRetryScheduled`, `emitFallbackSelected`, `startAttempt` / `completeAttempt` / `failAttempt` (manual escape hatch), `maybeComputeFingerprint`. New `RegistryOptions.instrumentation?: Instrumentation` — when supplied, `generateText` / `generateStructured` / `runAgent` emit `llm.operation.started` → per-attempt `.started` / `.completed` / `.failed` → `llm.fallback.selected` on chain advancement → `llm.operation.completed` / `.failed` / `.cancelled`. Prompt fingerprint at `attempt.completed` via `Instrumentation.fingerprint?: FingerprintPolicy` (opt-in, off by default per the contract's `CapturePolicy` default).
- **`@llm-ports/core`**: new `warnOnce(state, key, message)` primitive alongside `warnDeprecated` in `utils/deprecation.ts`. Same dedup + suppression + handler infrastructure.
- **`@llm-ports/core`**: new `normalizeTaskType(s)` helper. Applied at the env-parser and both Registry lookup sites so `"STRUCTURED_OUTPUT"`, `"Structured_Output"`, `"structured-output"` all resolve to the same route.
- **`@llm-ports/observability-contract`**: new optional `AttemptCompletedData.request_fingerprint` field (plus Zod schema update) — closes the gap between the alpha.28 `computeRequestFingerprint` helper and its emission surface.
- **`@llm-ports/eval@0.1.0`** — new publishable package. Durable storage for post-hoc evaluations (LLM-judge scores, human annotations, rule-based verdicts) keyed on the alpha.28 `EvaluationRef` shape. In-memory store (default, no deps) + SQLite backend (opt-in peer-dep on `better-sqlite3`). Both implement the same `EvaluationStore` interface. `toObservabilitySink(store)` bridges the store to the contract's `ObservabilitySink` — forwards only `evaluation.recorded` events.

### Fixed

- **`@llm-ports/core`**: Registry now warns once (through the shared `WarningState`) when a caller's `taskType` doesn't match any configured route and the fallback to `"general"` fires. Previously silent — closed the SalesCoach-reported `TD-LLM-TASKTYPE-CASE-MISMATCH-SILENT-GENERAL-FALLBACK` bug where consumers passing SCREAMING_SNAKE task types were silently misrouted to `general` regardless of their `.env` config.

### Changed

- Nothing breaking. Every new surface is additive: `RegistryOptions.instrumentation`, `AttemptCompletedData.request_fingerprint`, `Instrumentation.fingerprint`. Existing callers who don't opt in see identical behavior.

### Migration notes

See [`docs/migration/alpha-28-to-alpha-29.md`](./docs/migration/alpha-28-to-alpha-29.md). Bump every `@llm-ports/*` peer dep in your `package.json` from `alpha.28` to `alpha.29`. No code changes required. Wiring the new observability surface is opt-in.

### Deferred to alpha.30 (per `plans/alpha.29-runtime-instrumentation.md` §7 scope-adjustment)

- Adapter-level operation/attempt emission (`TD-ALPHA29-ADAPTER-EMIT-DEFERRED`)
- Agent step + tool events inside `runAgent` (`TD-ALPHA29-AGENT-STEP-EVENTS-DEFERRED`)
- Provider cache normalization inside in-process adapters (`CacheStats.provider_cache`)
- Streaming instrumentation (`streamText`, `streamStructured`)
- OpenTelemetry semconv adapter (`@llm-ports/telemetry-otel`)

### Known limitations

Consumers who bypass the Registry and import a raw in-process adapter directly see no contract events yet. Direct-adapter observability lands in alpha.30 alongside streaming instrumentation.

## v0.1.0-alpha.28 — 2026-07-22

### What changed

Observability contract foundation. New standalone `@llm-ports/observability-contract` package ships the data model consumers construct and emit conformant events with — no dependency on `@llm-ports/core`. Two subprocess-driven agent adapters (`adapter-codex`, `adapter-aider`) join the family.

### New

- **`@llm-ports/observability-contract@0.1.0`** — new publishable package. Event envelope (`ObservabilityEvent<TType, TData>`); correlation model (`CorrelationContext`, `ObservabilityContext`); sink interface (`ObservabilitySink`, `noopSink`, `createCollectingSink`); W3C Trace Context + Baggage (≤64 members, ≤8192 bytes); nanoid IDs (`newEventId`, `newOperationId`, `newAttemptId`, `newEvaluationId`); 9 lifecycle event types + 4 agent-step event types; `ErrorInfo` + 8-value `CauseCategory` rollup; nested `CacheStats`; `RequestFingerprint` canonicalization rules v1 + SHA-256 / HMAC-SHA-256 primitives + `computeRequestFingerprint` helper + golden vectors; `EvaluationRef` + 7-kind `EvaluationTarget` union + 4-shape `EvaluationScore` union; `CapturePolicy` with strict and permissive presets; full Zod schema catalog; `buildEvent` / `emitLifecycleEvent` / `emitEvaluation` emitter helpers.
- **`@llm-ports/core`**: `withObservabilityContext(port, context)` scoped-port wrapper. Merges caller-supplied `CorrelationContext` + `TraceContext` + `Baggage` into a port-scoped context that adapters can retrieve via `getObservabilityContext(port)`.
- **`@llm-ports/core`**: three new typed error classes — `CreditExhaustionError` (walk-worthy 402), `ProviderMalformed400Error extends BadRequestError` (walk-worthy 400 due to provider request-schema drift), `AdapterInternalError` (abort-worthy adapter-internal JS runtime error).
- **`@llm-ports/core`**: `defaultShouldFallback(err)` walk-table policy function — canonical `shouldFallback` semantics.
- **`@llm-ports/adapter-codex@0.1.0`** — new publishable package. Subprocess-driven adapter for OpenAI Codex CLI (`codex exec --json`). Shape A passthrough governance.
- **`@llm-ports/adapter-aider@0.1.0`** — new publishable package. Subprocess-driven adapter for Aider CLI (`aider --no-stream --yes-always --message`). Shape A passthrough governance.

### Fixed

- **`TD-LLMP-16`**: `wrapProviderError` now propagates `modelId` into `ContextWindowExceededError` and `ContentPolicyViolationError`.
- **`TD-LLMP-17`**: `runAgent` gets a defensive `tools: {}` default; `wrapProviderError` isolates local JS runtime errors as `AdapterInternalError`.
- **`TD-LLMP-18`**: `attemptValidationRepair` normalizes Unicode confusables (hyphens U+2010..U+2015, curly quotes, Unicode spaces) on `invalid_enum_value` retries.

### Changed

Nothing breaking. Everything additive.

## Unreleased

Tracked changesets that haven't shipped yet live under [`.changeset/`](.changeset/). Run `pnpm changeset` to add a new one.

## Format

Each release entry follows this shape:

```markdown
## v0.1.0 — YYYY-MM-DD

### What changed
<!-- 1-2 sentence summary of the release theme -->

### New
<!-- bullet list of new packages, capabilities, adapters, public API surface -->

### Changed
<!-- breaking changes, behavior changes; link to migration notes -->

### Fixed
<!-- bug fixes notable enough for release notes -->

### Migration notes
<!-- how to upgrade from the previous version, if anything is breaking -->

### Known limitations
<!-- carry-overs from the README's "Known Limitations" section that this release didn't fix -->

### Thanks
<!-- contributor handles, including non-PR feedback contributors -->
```

## Versioning

Pre-release: `0.1.0-alpha.0`, `0.1.0-alpha.1`, ... published under the `alpha` npm tag.

Stable: `0.1.0`, `0.1.1`, ... published under the `latest` npm tag once gate B from PUBLISHING is met.

Internal-only packages (`@llm-ports/adapter-contract-tests`, `@llm-ports/benchmarks`) are not published to npm; their changes are not version-bumped here.
