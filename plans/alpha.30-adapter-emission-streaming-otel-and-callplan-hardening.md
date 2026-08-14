# @llm-ports alpha.30 — Adapter Emission + Streaming + OTel + Call-Plan Hardening

**Filed:** 2026-08-14T14:02:58 -07:00
**Author:** Babak Abbaschian
**Target ship date:** No hard deadline; correctness > speed. Original Plan 58 §5.3 target was 2026-09-02, but the scope has grown beyond §5.3 (see §1 Purpose) so the date moves with delivery.
**Release cadence:** Fifth of the observability contract's four-release plan, extended to absorb SalesCoach-surfaced production TDs that showed up during the alpha.29 window. Alpha.28 (2026-07-22) and alpha.29 (2026-08-11) shipped. Alpha.31 remains as originally planned (persistence + BEPA / ADW cutovers).
**Status:** Approved 2026-08-14 (this session).

---

## §1 Purpose

Alpha.30 delivers three grouped tracks plus the sub-tasks Plan 58 §5.3 originally scoped.

- **Auth-error resilience track.** Registry-tracked `hasEverAuthenticated` per-provider bit + policy update so a first-time-failed credential no longer aborts a whole fallback chain, while a mid-flight auth failure keeps its current abort behavior. Adds a new `FallbackCause` value and a caller-invocable `probeCredentials(chain)` for boot-time verification. Sourced from SalesCoach's `TD-LLM-AUTH-ERROR-KILLS-THE-WHOLE-CHAIN` (2026-08-14) after their staging chain sat silently misrouted for days because position 4 held a dead OpenAI key. Their TD is a well-argued upstream ask, not a demand — the answer is the third option they laid out (gate advancement on `hasEverAuthenticated`, emit distinctly, don't fork the classifier locally).

- **Timeout granularity track.** Adds a per-task default and a per-call override for `perAttemptTimeoutMs`. The current surface is a single readonly value at Registry construction, which starves any provider that legitimately needs more than the global cap. Sourced from SalesCoach's `TD-CALLPLAN-CHAIN-TIMEOUT-STARVATION` (2026-08-14): their COMPLEX_REASONING chain was starving positions 1-4 under a 15s global cap, silently landing every call on Cerebras (position 5) — a single point of failure disguised as a working fallback chain. The current shape genuinely doesn't express what the call plan needs.

- **Diagnostic track.** Adds `response_char_count` (always safe, always emitted) and gated `response_preview` (content, so `CapturePolicy.content` governs it) to `AttemptCompletedData`. Closes the "empty-object success under a permissive schema is undebuggable" gap that showed up as an unrelated observation on the auth TD.

- **Plan 58 §5.3 scope, unchanged.** Streaming instrumentation, OpenTelemetry semconv adapter, adapter-level emission (the alpha.29 Option A carve-out), agent step + tool events, provider cache normalization across in-process adapters.

Alpha.30 does NOT include the persistence backends (`@llm-ports/telemetry-sqlite`, `@llm-ports/telemetry-clickhouse`) or the BEPA + ADW cutovers — those remain in alpha.31 per Plan 58 §5.4.

## §2 Scope

Thirteen sub-tasks across four tracks. All land in one alpha.30 release. Some carry SalesCoach TD close-outs on bump; others resolve the alpha.29 carve-out TDs already filed in this repo.

### §2.1 — Auth-error resilience track (SalesCoach `TD-LLM-AUTH-ERROR-KILLS-THE-WHOLE-CHAIN`)

**§2.1.1 Registry-tracked `hasEverAuthenticated` bit.** New public method on `Registry`: `hasEverAuthenticated(providerAlias: string): boolean`. Internal state: a `Set<string>` of provider aliases that have completed at least one successful attempt in the current process. Set from `walkChain`'s `runAttempt` success path, right after `registry.budget.recordRequest(key)`. Never reset (a provider that authenticated at least once in this process is trusted for the rest of the process; process restart is what re-verifies). Reads: called from the new default-fallback policy below.

**§2.1.2 `AuthenticationError` becomes conditionally walk-worthy.** Both `defaultShouldFallback` and `aggressiveShouldFallback` in `packages/core/src/errors.ts` get a new second-parameter form: `shouldFallback(err, ctx?: { providerAlias: string; hasEverAuthenticated: boolean })`. When `ctx.hasEverAuthenticated === false` and `err instanceof AuthenticationError`, both policies return `true`. When `ctx.hasEverAuthenticated === true`, both return `false` (the current abort behavior — a mid-flight auth failure is treated as "something changed, stop"). Callers who don't pass `ctx` see the current abort-on-auth behavior unchanged. `walkChain` in the Registry passes `ctx` automatically so consumers on the Registry surface get the new behavior for free.

**§2.1.3 New `FallbackCause` value.** Add `"provider_authentication_never_established"` to `FallbackCause` in `packages/observability-contract/src/lifecycle.ts` (and its Zod schema in `schemas.ts`). Emitted on `llm.fallback.selected` when the chain walks past a never-authenticated provider whose attempt failed with `AuthenticationError`. The existing `"provider_unavailable"` fires for the ordinary walk-past-a-failed-attempt case; the new value distinguishes dead-credential from transient failure, so sinks can alert specifically on stale credentials.

**§2.1.4 New Registry method: `probeCredentials(chain?)`.** Signature: `async probeCredentials(chain?: string[]): Promise<CredentialProbeReport>`. Cheapest available round-trip per provider — for OpenAI-shaped adapters, `LLMPort.listModels()` when the adapter implements it; otherwise a minimal `generateText` with `maxOutputTokens: 1`. Returns `{ ok: string[], failed: Array<{ alias, error }>, skipped: Array<{ alias, reason }> }`. When `chain` is omitted, probes every configured provider. When passed, probes only those aliases. Caller-invocable — the Registry does NOT auto-probe at construction (opt-in for two reasons: startup cost and side-effects on rate limits). Consumers wire this into their startup / health-check surface. Solves SalesCoach's "no boot-time signal" complaint without imposing a mandatory cost on every consumer.

### §2.2 — Timeout granularity track (SalesCoach `TD-CALLPLAN-CHAIN-TIMEOUT-STARVATION`)

**§2.2.1 Per-task `TaskConfig.defaultPerAttemptTimeoutMs`.** New optional field on `TaskConfig` in `packages/core/src/registry/tasks.ts`. Consumers declaring tasks via `declareTasks({ ... })` can set per-task defaults. The Registry looks up the caller's `taskType` against the declared registry — if a match with `defaultPerAttemptTimeoutMs` set, uses it. Fully backwards compatible: unset means the Registry-level `perAttemptTimeoutMs` still applies.

**§2.2.2 Per-call `perAttemptTimeoutMs` override.** New optional field on `GenerateTextOptions` / `GenerateStructuredOptions` / `StreamTextOptions` / `StreamStructuredOptions` / `RunAgentOptions`. Overrides both the task-level default and the Registry-level global for that specific call. Highest precedence. Enables the "one specific call needs 60s" case (SalesCoach's call plan) without changing the Registry-level cap that protects everything else.

**Precedence, all four sources considered:** call-level (§2.2.2) → task-level (§2.2.1) → Registry-level (existing `RegistryOptions.perAttemptTimeoutMs`) → undefined (no timeout). First non-undefined wins. Documented in the migration page.

### §2.3 — Diagnostic track (SalesCoach auth TD's "unrelated observation")

**§2.3.1 `AttemptCompletedData.response_char_count`.** New optional numeric field on the contract's `AttemptCompletedData` (plus Zod schema update). Always safe to emit; not gated by `CapturePolicy.content` because it's a count, not content. Adapters populate it from the final response text length (or a sensible equivalent for structured / tool-call responses). Solves "the model returned near-empty output but the call reports success" — the count distinguishes "returned 2 characters" from "returned 800 characters."

**§2.3.2 `AttemptCompletedData.response_preview`.** New optional string field. Bounded by a `CapturePolicy.responsePreviewMaxChars` new field (default 200 when policy is `PERMISSIVE_CAPTURE_POLICY`, 0 when `DEFAULT_CAPTURE_POLICY` — i.e. off in strict mode). Content, so gated by `CapturePolicy.content === true`. When both `content` is enabled AND `responsePreviewMaxChars > 0`, adapters emit a first-N-chars slice of the response text.

### §2.4 — Adapter-level emission (resolves `TD-ALPHA29-ADAPTER-EMIT-DEFERRED`)

Design chosen per the two candidates named in the TD: **candidate (a)** — extend `ObservabilityContext` in `@llm-ports/observability-contract` to carry an opaque `operation_handle?: string`. The Registry mints one per operation (nanoid), stashes an internal `OperationContext` under that handle in a WeakMap in the shared instrumentation service, and passes the handle down to adapters via `withObservabilityContext(port, { operation_id, operation_handle })`. Adapters call a new helper `resurrectOperationContext(port): OperationContext | undefined`. When present, adapters wrap their provider calls in `withAttempt(resurrected, ...)`. When absent (direct adapter call), adapters open their own `withOperation`.

Candidate (b) (`_opCtx?` on options) was rejected because it leaks the shared service's shape into the public API surface of every generation method, plus muddles the discoverability of the options interface.

This unlocks the codex + aider inline-emission refactor (they'll route through the same shared service instead of their alpha.28 hand-rolled emit code).

### §2.5 — Agent step + tool events (resolves `TD-ALPHA29-AGENT-STEP-EVENTS-DEFERRED`)

New event types on the contract (already reserved as slots in Plan 58 §4.7 — this ships the implementations):

- `agent.step.started` — one step of a `runAgent` loop begins. Carries `step_number`, `step_kind: "llm_turn" | "tool_call"`.
- `agent.step.completed` — step ended. Carries `step_number`, `duration_ms`, optional `usage` for LLM turns.
- `agent.step.failed` — step errored. Carries `step_number`, `error: ErrorInfo`.
- `agent.tool.called` — a tool was invoked inside a step. Carries `step_number`, `tool_name`, `tool_call_id`.
- `agent.tool.succeeded` / `agent.tool.failed` — tool result. Carries `step_number`, `tool_name`, `tool_call_id`, optional `duration_ms`, optional `error`.

Adapters that own the tool-use loop emit these via the shared service (using the resurrected `OperationContext` from §2.4). The codex + aider adapters already emit lifecycle events inline; those adapters extend the pattern for agent-step events under the same refactor.

### §2.6 — Provider cache normalization

The five in-process adapters (`openai`, `anthropic`, `google`, `ollama`, `vercel`) map their native cache fields into the contract's nested `CacheStats.provider_cache` shape on `AttemptCompletedData.cache_stats`. The mapping table:

- **OpenAI:** `usage.prompt_tokens_details.cached_tokens` → `cache_stats.provider_cache.read_tokens`.
- **Anthropic:** `usage.cache_read_input_tokens` → `.read_tokens`; `usage.cache_creation_input_tokens` → `.write_tokens`. Report cache-ephemeral tier via `.tier: "ephemeral" | "1h"`.
- **Google:** `usageMetadata.cachedContentTokenCount` → `.read_tokens`.
- **Ollama, Vercel:** no cache surface today; `cache_stats.provider_cache` is omitted (correct empty state).

Semantic cache remains unimplemented for now; the `cache_stats.semantic_cache` shape stays available for consumers who layer their own semantic cache in front of the port.

### §2.7 — Streaming instrumentation (Plan 58 §5.3 original)

`streamText` and `streamStructured` gain contract lifecycle emission alongside the three non-streaming methods. The wrap-around form doesn't fit streaming (the stream returns quickly, consumption happens later); use the manual escape hatch `startAttempt` / `completeAttempt` / `failAttempt` that shipped in alpha.29, wired into the stream lifecycle:

- `llm.operation.started` — fires when the caller invokes `streamText` / `streamStructured` (before the stream returns).
- `llm.attempt.started` — fires when the adapter opens the underlying provider stream.
- New streaming-specific event `llm.stream.chunk` — optional per-chunk telemetry (chunk index, byte count, delta latency). Gated by a new `CapturePolicy.streamChunks` boolean, default `false` (aggregate-only). When aggregate-only, the chunk stats accumulate on `AttemptCompletedData`.
- `llm.attempt.completed` — fires on natural stream completion. New optional `AttemptCompletedData.stream_stats` field: `{ ttft_ms, total_duration_ms, chunk_count, inter_chunk_latency_p50_ms, inter_chunk_latency_p99_ms, termination: "complete" | "aborted" | "error" }`.
- `llm.attempt.failed` — fires on mid-stream error.

TTFT (time-to-first-token) is the load-bearing new metric — consumers can chart provider tail latency, which is currently invisible in the non-streaming lifecycle.

### §2.8 — OpenTelemetry semconv adapter (Plan 58 §5.3 original)

New publishable package `@llm-ports/telemetry-otel@0.1.0`. Consumer wraps their `ObservabilitySink` with `createOtelSink({ tracer, meter })` and every contract event flows into OTel spans + metrics per the [`gen_ai.*` semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Mapping table:

- `llm.operation.started` → span open, attribute `gen_ai.operation.name`.
- `llm.attempt.completed` → span attributes `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`; metrics `gen_ai.client.token.usage` histogram, `gen_ai.client.operation.duration` histogram.
- `llm.attempt.completed.cache_stats.provider_cache.read_tokens` → metric `gen_ai.client.cache.read_tokens`.
- `llm.stream.chunk` (if capture policy enables per-chunk) → span event.
- `llm.attempt.failed` / `llm.operation.failed` → span `RecordException` + status.

The current OTel semconv for gen_ai is stable enough to target; PR #197's cache-dimension debate is resolved from the contract side by shipping `cache_stats` in the contract shape and letting the adapter map it — no consumer-side translation code needed for the cache dimensions.

Not baked into `@llm-ports/core`. Companion package pattern, opt-in.

## §3 Acceptance criteria

- **Auth track.** SalesCoach's `TD-LLM-AUTH-ERROR-KILLS-THE-WHOLE-CHAIN` closes on bump. Their staging chain with a dead position-4 key now advances to position 5 with `cause: "provider_authentication_never_established"` on the fallback event. A subsequent process-restart with the same dead key emits the same signal. A dead key on a provider that had authenticated earlier in the process still aborts (mid-flight auth failure treated as configuration change).
- **Timeout track.** SalesCoach's `TD-CALLPLAN-CHAIN-TIMEOUT-STARVATION` closes on bump when they either (a) declare their call-plan task with `defaultPerAttemptTimeoutMs: 60000`, or (b) pass `perAttemptTimeoutMs: 60000` at the call site. Their COMPLEX_REASONING chain no longer starves positions 1-4 under the 15s global cap.
- **Diagnostic track.** `response_char_count` shows up on every `llm.attempt.completed` from a Registry call. `response_preview` shows up only when the caller sets `CapturePolicy.content: true` AND `responsePreviewMaxChars > 0`.
- **Adapter track.** Direct-adapter calls (bypassing the Registry) emit the same contract lifecycle events the Registry produces. Both alpha.29 carve-out TDs close: `TD-ALPHA29-ADAPTER-EMIT-DEFERRED` and `TD-ALPHA29-AGENT-STEP-EVENTS-DEFERRED`. Codex + aider adapters route their inline emission through the shared service (no more hand-rolled `sink.emit` blocks in those adapters).
- **Cache track.** `CacheStats.provider_cache.read_tokens` appears on every attempt.completed from OpenAI, Anthropic, Google adapters when the provider reports cache stats. Ollama and Vercel remain absent as expected.
- **Streaming track.** `streamText` and `streamStructured` calls on the Registry emit `operation.started`, `attempt.started`, and `attempt.completed` with `stream_stats` including `ttft_ms`. Per-chunk emission gated by `CapturePolicy.streamChunks`.
- **OTel track.** `@llm-ports/telemetry-otel@0.1.0` publishes. A consumer wraps their sink with `createOtelSink({ tracer })` and every contract event surfaces as `gen_ai.*` spans + metrics. Contract-events-to-semconv mapping matrix documented in the package README.
- **Non-breaking.** All 13 sub-tasks are additive at the public API surface. Existing callers see identical behavior when they don't opt into the new fields or wire the new sinks. The `AuthenticationError`-becomes-conditionally-walk-worthy change is a behavior change under the covers, but only for consumers on Registry + fallback chain + dead credential at chain position >0 — the exact scenario SalesCoach hit and the exact scenario the change is designed to fix.

## §4 Test coverage plan

Roughly 120-150 new vitest cases across the workspace. Approximate targets, not hard floors.

- **Auth track:** ~15 cases. Registry `hasEverAuthenticated` state machine (never-set → set on success → stays set across errors); `defaultShouldFallback` conditional-on-context behavior; `aggressiveShouldFallback` same; `fallback.selected` event with the new cause; `probeCredentials` happy path + partial-failure + skipped-adapter cases.
- **Timeout track:** ~10 cases. Precedence chain (call → task → Registry → undefined); `declareTasks` with `defaultPerAttemptTimeoutMs`; per-call override wins; no-timeout when all four are unset.
- **Diagnostic track:** ~8 cases. `response_char_count` always emitted; `response_preview` gated by `CapturePolicy.content`; `responsePreviewMaxChars: 0` disables even when content is on; permissive-policy default of 200 chars.
- **Adapter emission track:** ~25 cases. `resurrectOperationContext` returns the plumbed context when set / undefined when not; direct-adapter call opens its own operation; through-Registry adapter uses the resurrected context; codex + aider refactored to the service produce the same event shape as before.
- **Agent step + tool events:** ~15 cases. Every event type emits; step numbering; tool_call_id correlates across `called` / `succeeded` / `failed`; nested tool calls within a single step.
- **Cache normalization:** ~15 cases. Per-adapter mapping table (OpenAI cached_tokens → read_tokens; Anthropic cache_read/create → read/write; Google cachedContent → read; Ollama/Vercel omitted).
- **Streaming:** ~20 cases. Lifecycle emission around stream open/close/error; `stream_stats` fields present and reasonable; per-chunk events gated by policy; TTFT within a sane range for a mock stream.
- **OTel:** ~15 cases. Event → span mapping per row of the compatibility matrix; span attributes carry the right `gen_ai.*` names; metric emission for token usage and duration.

## §5 Non-goals

- Persistence backends (`@llm-ports/telemetry-sqlite`, `@llm-ports/telemetry-clickhouse`) — alpha.31 per Plan 58 §5.4.
- BEPA + ADW cutovers — alpha.31 per Plan 58 §5.4.
- Semantic cache implementation — the `CacheStats.semantic_cache` shape stays available for consumer-layered semantic caches; nothing implements it in-tree.
- Any change to how errors are wrapped — `AuthenticationError` still maps from 401/403 in `wrapProviderError`. The change is what the Registry does with it, not what the taxonomy calls it.
- OTel logs (only spans + metrics land in the `@llm-ports/telemetry-otel` adapter). Logs are a consumer-side concern.

## §6 Delivery mechanics

Same release plumbing as alpha.29:

- Linked bump under `@llm-ports/*` (`migrate` stays excluded).
- Pre-release mode continues; `alpha` dist-tag re-rolled forward via `scripts/retag-alpha.mjs`.
- New publishable package `@llm-ports/telemetry-otel@0.1.0` — publishes with explicit `--tag alpha` per the alpha.28 lesson (new scoped packages under prerelease-version need the explicit tag).
- Changeset entry at `.changeset/alpha-30-adapter-emission-streaming-otel-and-callplan-hardening.md`. Lists every `@llm-ports/*` publishable package at `patch`. Migrate stays out via the `.changeset/config.json` ignore list.
- Plan doc, TD carve-outs, and any pre-release TD entries all live in this repo (`plans/`, `TECH-DEBT.md`).

## §7 Release completion checklist

Copy or reference `plans/alpha.29-runtime-instrumentation.md#7-release-completion-checklist`. That checklist is the durable artifact — verification (`pnpm test` / `typecheck` / `lint`), ship-the-code (changeset flow, staging discipline, publish + retag), docs (README banner / CHANGELOG / MIGRATION / concept + migration pages / VitePress sidebar), GitHub Release, downstream signals, plan-doc close-out.

**Alpha.30-specific additions** (folded into the running checklist at close-out):

- **§2.4 adapter-emission behavior change verified end-to-end.** Direct-adapter smoke test emitting a full operation lifecycle without going through the Registry. Every existing adapter's test suite adds one "called direct, events emitted" case.
- **§2.1.2 conditional-fallback behavior change documented in the migration page.** The migration is fully additive at the API surface, but the "never-authenticated auth error now walks the chain" is a runtime behavior change worth flagging explicitly for consumers who might have configured a chain with intentionally-invalid keys (rare, but non-zero).
- **§2.7 streaming test with a real provider under `RUN_LIVE_TESTS=1`.** Aggregate `stream_stats` sanity check against Anthropic's streaming endpoint. Not a blocker for the tarball ship; a follow-up verification.

## §8 Changelog

- **2026-08-14T14:02:58 -07:00** — Filed as approved plan. Scope frozen: the thirteen §2 sub-tasks across four tracks. Approvals from this session on the auth track (four items), the timeout track (two items), and the diagnostic track (two items) fold into the six §5.3-originally-scoped items already committed.
