# `llm-ports` Tech Debt Log

Append-only record of known compromises, design tradeoffs, and deferred work. Each entry has a severity (High / Medium / Low), a status (Open / In Progress / Resolved / Blocked), the affected files, the problem statement, the impact, and a resolution path.

When resolving an item, mark **Status: Resolved** with the date and the commit SHA. Do not delete entries — the history is the value.

Format: timestamped headings (date + system + subsystem), severity + status fields, append-only.

---

# 2026-05-04T21:30 PST

## llm-ports

### TD-LLMP-01: `pretest:live*` rebuild hook is a workaround, not a fix

- **Severity:** Low
- **Status:** Open
- **Files:** all `packages/adapter-*/package.json`, `packages/core/package.json`, `packages/capabilities/package.json`, `packages/benchmarks/package.json`
- **Problem:** Workspace package `exports` field points at compiled `dist/`. Edits to `packages/*/src/` are silently ignored at runtime by sibling workspace packages until you remember `pnpm build`. We lost an hour during Phase 2 to stale-dist symptoms before adding the `pretest:live*` rebuild hook.
- **Impact:** Each live-test invocation now pays a 3-5s rebuild cost. Local development still requires manual `pnpm build` between src edits and any tsx-based script that imports a sibling package.
- **Resolution path:** Either (a) conditional `exports` with `"development": "./src/index.ts"` so tools that respect conditions resolve to source in dev, or (b) a top-level `pnpm dev` that runs `tsup --watch` across all packages so dist stays current. Option (a) is cleaner but requires verifying tsx, vitest, and node all honor the condition correctly.

### TD-LLMP-02: Cerebras/Groq compat coverage is one test deep

- **Severity:** Medium
- **Status:** Open
- **Files:** `packages/benchmarks/src/live/openai.test.ts:317-347`
- **Problem:** Native OpenAI gets 14 live tests (text, structured, stream, agent, vision, embeddings). Compat providers (Cerebras, Groq) get 1 — basic `generateText`. The reasoning-field detection that we added for `gpt-oss-120b` (Commit 2eba11f) is now load-bearing for compat correctness but only one test guards it.
- **Impact:** A future regression in compat handling (e.g. parser stops recognizing `message.reasoning` after a refactor) wouldn't be caught until a downstream user hits it.
- **Resolution path:** Extend the compat describe blocks with the same matrix as native OpenAI: structured output, streaming, agent loop, embeddings (where supported). Estimated 6-8 additional tests per compat provider.

### TD-LLMP-03: Reasoning-model detection costs one wasted call per (model × process)

- **Severity:** Low
- **Status:** Open
- **Files:** `packages/adapter-openai/src/adapter.ts` (`learnFromResponse`, `reasoningStarvedResponse`)
- **Problem:** Detection only fires AFTER seeing reasoning tokens or a populated `message.reasoning` field. The first call against an unknown reasoning model with a small `maxOutputTokens` always returns starved, triggers the auto-retry, and only then learns the constraint. The first call's tokens are wasted.
- **Impact:** A long-running process touching N reasoning models pays N wasted first-call costs. Real cost is small ($0.0001 each) but the latency hit (one extra round-trip per model) is real.
- **Resolution path:** Either (a) opt-in seed list users can supply via `pricingOverrides[modelId].capabilities.reasoningModel = true`, or (b) a one-time `/v1/models` probe at adapter creation time (most providers don't expose capability metadata, so this is best-effort). Documenting (a) in the OpenAI adapter README is probably enough for now.

### TD-LLMP-04: `learnedConstraints` Map is unbounded and global

- **Severity:** Low
- **Status:** Open
- **Files:** `packages/adapter-openai/src/capabilities.ts:27`
- **Problem:** Process-wide singleton Map keyed by modelId. (1) Long-running processes touching many models accumulate forever (no eviction). (2) Two `createOpenAIAdapter` instances share the Map — possibly desired (key rotation shouldn't lose learning) but undocumented. (3) `hasSucceeded` is per-AdapterContext, so two adapters with the same key learn independently — opposite of (2).
- **Impact:** Edge cases. Memory growth probably never matters in practice (constraints are tiny objects, hundreds of models max). The hasSucceeded inconsistency is more interesting: an attacker who can create new adapter instances could probe burst protection without using the existing instance's "proven good" flag.
- **Resolution path:** (1) Add a configurable LRU cap (default 256 models). (2) Document the global-Map decision explicitly. (3) Decide whether `hasSucceeded` should also be process-global keyed by `apiKey`-prefix-hash; resolve the inconsistency one way or the other.

### TD-LLMP-05: `zodToParameters` is a stub

- **Severity:** Medium
- **Status:** Open
- **Files:** `packages/adapter-openai/src/adapter.ts:919` (and `packages/adapter-anthropic/src/adapter.ts` equivalent)
- **Problem:** Both adapters convert Zod tool schemas to `{type:"object", properties:{}}` — losing all field types. Tools are effectively typeless to the model; it must guess parameter names from the description string.
- **Impact:** Any user calling `runAgent` with non-trivial tools gets degraded model performance. The model has to invent parameter names instead of reading them from a schema. Fail-rate goes up; latency goes up (more retries).
- **Resolution path:** Wire in `zod-to-json-schema` (the canonical converter, ~5KB). Add a `zodConverter` option to adapter constructors so users can swap in `@anatine/zod-openapi` or other variants.

### TD-LLMP-06: No observability into adapter retries

- **Severity:** Medium
- **Status:** Open
- **Files:** `packages/adapter-openai/src/adapter.ts` (executeChatRequest, executeChatStream, withTransientAuthRetry)
- **Problem:** Three retry kinds happen silently: capability-rejection retry, transient-401 retry, reasoning-starved retry. A production user has no signal that "Cerebras just retried 2x with backoff before this 800ms response."
- **Impact:** When users debug latency spikes or unexpected costs, they can't see the retry behavior. Hard to diagnose "why is this call slow" without instrumenting the OpenAI SDK directly.
- **Resolution path:** Add an `onRetry` hook to `OpenAIAdapterOptions`: `onRetry?: (event: RetryEvent) => void` where `RetryEvent` carries `{kind: "capability" | "transient_auth" | "reasoning_starved", attempt: number, modelId: string, alias: string}`. Same pattern as capability `onResult`.

### TD-LLMP-07: Cost precision change (10-decimal) not unit-tested

- **Severity:** Low
- **Status:** Open
- **Files:** `packages/core/src/budget/cost.ts`
- **Problem:** Recently bumped from 6-decimal to 10-decimal precision so embeddings (`5 tokens × $0.02/1M = $1e-7`) don't round to 0. The change is correct but no unit test pins it. A future "round to 6 decimals for serialization" PR could silently regress.
- **Impact:** Cost-gated workloads with very small per-call costs would silently bypass the gate.
- **Resolution path:** Add `packages/core/tests/cost.test.ts` with a case asserting `computeEmbeddingCost(5, {embeddingPer1M: 0.02})` returns a positive value (not zero).

### TD-LLMP-09: Registry has no runtime-error fallback — only budget-gating fallback

- **Severity:** Medium
- **Status:** Open
- **Files:** `packages/core/src/registry/registry.ts:225-275` (RegistryPort.generateText / generateStructured / streamText / streamStructured / runAgent)
- **Problem:** The fallback chain in `selectModel()` is consulted ONLY at provider-selection time. If the selected provider returns a `ProviderUnavailableError` at runtime (network 503, transient outage, hit-the-rate-limit-mid-call), the error propagates straight to the caller. There is no try/catch around `sel.port.generateText(options)` that walks to the next chain entry. Discovered while writing Group J tests during Phase 1.5 (2026-05-04).
- **Impact:** Multi-provider setups don't get the resilience that the chain syntax implies. `LLM_TASK_ROUTE_TRIAGE: "fast,backup"` reads as "if fast fails, use backup" — but only "fails" in the budget sense, not the runtime sense. This is a documentation-vs-implementation gap.
- **Resolution path:** Wrap the `sel.port.X(options)` call inside RegistryPort's methods in a try/catch that, on `ProviderUnavailableError`, walks to the next chain entry and accumulates per-alias reasons. On exhaustion, throw `NoProvidersAvailableError`. Care needed for streaming methods (can only fall back at stream-creation time, not mid-stream) and for cost recording (don't record cost for failed attempts).
- **Test pinning current behavior:** [`packages/core/tests/registry-edges.test.ts`](packages/core/tests/registry-edges.test.ts) "documents current behavior: runtime ProviderUnavailableError propagates — does NOT trigger fallback". Update that test when this lands.

### TD-LLMP-10: `transientAuthBackoffMs` is exposed solely for tests — no production use case yet

- **Severity:** Low
- **Status:** Open
- **Files:** `packages/adapter-openai/src/adapter.ts` (OpenAIAdapterOptions)
- **Problem:** Added during Phase 1.5 to make Group C tests fast (inject `() => 0` instead of waiting 500ms+1500ms per test). Exposed in the public adapter options because that was the cleanest way to make it test-injectable without test-only conditionals in production code. Production users have no current reason to override the default.
- **Impact:** Public API surface area carrying a feature with no documented production use case. If we publish v0.1 as-is, the field is part of the SemVer contract.
- **Resolution path:** Either (a) document a production use case (compat providers may need different backoff cadences), (b) rename to `_transientAuthBackoffMs` (underscore-prefix convention for advanced/test-only) before v0.1, or (c) accept it as-is and document in the OpenAI adapter README.

### TD-LLMP-08: OpenAI API key deactivated — Phase 2/3 verification stalled

- **Severity:** High (blocked test phases)
- **Status:** Resolved 2026-05-04 — Babak rotated the key (now ends `cxmt`); both `/v1/models` and full Phase 2 suite reach the API. 22 of 26 live tests pass; remaining failures are model-output flakiness, not key issues.
- **Files:** local `.env`, `OPENAI_API_KEY`
- **Problem:** Direct curl to `api.openai.com/v1/models` with the previous key (`...wrwA`) returned HTTP 401 "Incorrect API key" after working earlier in the test pass.
- **Impact:** Live API integration and live capability integration phases couldn't complete the OpenAI portions. Cerebras compat worked throughout.
- **Resolution:** Key rotated 2026-05-04. New key length 56 chars (standard service-key shape, not `sk-proj-*`). All OpenAI live test paths reachable.

### TD-LLMP-11: Vercel adapter does not handle reasoning models (no headroom multiplier)

- **Severity:** Medium
- **Status:** Open
- **Files:** `packages/adapter-vercel/src/adapter.ts`
- **Problem:** The OpenAI adapter applies a 10x reasoning-headroom multiplier when it learns a model is a reasoning model (so a request for 20 visible tokens gets max=200 sent to the API, leaving room for CoT). The Vercel adapter has none of this — calling `vercel.generateText({ maxOutputTokens: 20 })` against `gpt-5-nano` reliably starves the model and returns empty text. Discovered while triaging Phase 2 vercel failures.
- **Impact:** Vercel-adapter users with reasoning models hit silent empty-output failures unless they manually budget 10x more than they want visible. Inconsistent with the OpenAI adapter's transparent handling.
- **Resolution path:** Port the reasoning-detection + auto-retry + headroom multiplier logic from `adapter-openai/src/adapter.ts` (executeChatRequest, learnFromResponse, reasoningStarvedResponse) to the Vercel adapter. Or extract the logic to a shared helper in `@llm-ports/core` so both adapters consume it. The shared-helper path is cleaner long-term but bigger scope.

### TD-LLMP-12: Vercel adapter throws SyntaxError "Unexpected end of JSON input" on empty structured response

- **Severity:** Medium
- **Status:** Open
- **Files:** `packages/adapter-vercel/src/adapter.ts` (generateStructured path)
- **Problem:** Observed Phase 2 (intermittent): `vercel.generateStructured` against `gpt-5-nano` sometimes returns an empty completion, after which the JSON parser throws `SyntaxError: Unexpected end of JSON input`. The error wraps as `ProviderUnavailableError` — but the underlying cause is the same reasoning-starvation pattern as TD-LLMP-11.
- **Impact:** Vercel adapter users see a confusing SDK-internal SyntaxError instead of either auto-recovery (a la OpenAI adapter) or a clearer "model produced no output" error.
- **Resolution path:** Same as TD-LLMP-11 (reasoning-aware retry). Plus: when JSON parse fails on an empty string, throw a more specific error class (e.g. `EmptyResponseError`) to make the failure mode obvious to users rather than masquerading as a generic provider failure.

### TD-LLMP-14: zod peer-dep range too narrow — Vercel adapter requires zod ≥3.24

- **Severity:** Medium
- **Status:** Resolved 2026-05-05 (commit pending)
- **Files:** all 6 published `packages/*/package.json`
- **Problem:** Discovered during Phase 4 tarball install. `@ai-sdk/openai-compatible` (transitive of `ai@4.x`) depends on `zod-to-json-schema@^3.24.1`, which imports from `zod/v3`. The `zod/v3` subpath is only present in zod ≥3.24. Our packages declared zod `^3.23.0`, so a clean install could resolve to zod 3.23 and crash at runtime with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- **Resolution:** Converted `zod` from `dependencies` (or `devDependencies` for adapters) to `peerDependencies` with range `">=3.24.0 <5"` in all six published packages. Added zod `^3.25.76` to each package's `devDependencies` so the workspace continues to type-check and test against a known-good version. Consumers now control the zod version they install; npm/pnpm satisfies the peer constraint.
- **Verified after fix (2026-05-05):**
  - `pnpm install` (workspace re-install) clean
  - `pnpm -r typecheck` clean across all 8 packages
  - `pnpm -r test` 211 tests pass (45 + 34 + 7 + 27 + 23 + 75)
  - Re-packed all 6 tarballs; inspected `package.json` inside `llm-ports-core-0.0.0.tgz` — `peerDependencies.zod = ">=3.24.0 <5"` is published
  - Fresh `e:\tmp\llm-ports-consumer` install with `zod@3.25.76` + ESM smoke: 12 named exports resolve, registry constructs cleanly
- **Follow-up (deferred):** add a peer-dep CI check to the release workflow so future PRs that change peer ranges get gated. Document the zod requirement in `getting-started.md` and per-adapter README during Phase 6 polish (TD-LLMP-15).

- **Severity:** Low
- **Status:** Open (accepted limitation for v0.1 launch)
- **Files:** `packages/benchmarks/src/live/openai.test.ts` (`generateStructured.retry` test); `packages/benchmarks/src/live/capabilities.test.ts` (`createPlanner.decomposes a goal` against Cerebras occasionally)
- **Problem:** A subset of live tests rely on the model self-correcting after one validation feedback round. With `gpt-5-nano` (reasoning model, cheapest in OpenAI's catalog), the model's structured output is non-deterministic at the schema-conformance level: it sometimes returns `urgent: "yes"` instead of `urgent: true`, omits required fields, or fabricates enum values. Even after retry-with-feedback, the same drift recurs. The architecture works (the retry fires; the validator detects the issue; the second response is consumed); the model just isn't good enough at JSON.
- **Impact:** Phase 2 live runs see 1-3 intermittent failures per ~26-test run depending on which way the model rolls. Architectural assertions unaffected.
- **Resolution path:** Either (a) accept and document as known LLM-flakiness; (b) switch the brittle tests to a more reliable model (gpt-4o-mini or claude-haiku-4-5 when available); (c) add a retry-the-test framework hook that re-runs failing tests up to N times before marking failed. Option (b) is cleanest — currently blocked by ANTHROPIC_API_KEY availability.

---

# 2026-07-21T15:07:40 -07:00

## llm-ports

Batch of 4 TDs opened from a cross-consumer review pass. Consumer reports came from BEPA (`BabakPersonalAssistant`, LLM triage / office agents / capability wrappers) and ADW (`agentic-dev-orchestrator`, AI-to-AI review sessions via `runAgent`). Each entry names its consumer-side origin TD so the ecosystem trail is walkable. Findings verified against `@llm-ports/core@0.1.0-alpha.27` source at commit `bac6ecb`. Target for shipping fixes: alpha.28 pre-work window.

### TD-LLMP-16: `adapter-openai` ContextWindowExceededError reports `model "(unknown)"` even when the model name is at request-construction time

- **Severity:** Medium (operator-visibility gap on the second most common error class for LLM operators).
- **Status:** Open.
- **Files:** `packages/adapter-openai/src/adapter.ts` (`executeChatRequest`, around the current `dist/index.mjs:1323` line in the shipped bundle); `packages/core/src/errors.ts` (`wrapProviderError`, current `dist/index.mjs:1755`).
- **Problem:** BEPA sent 563,962 bytes to `getLLMPort().generateStructured({ taskType: 'selector-compile', ... })`. The registry chained to `deepseek-4flash-deepinfra` (OpenAI-compatible adapter with DeepInfra baseURL, model `deepseek-ai/DeepSeek-V4-Flash`). Provider correctly returned context-window-exceeded. The adapter classified it into a `ContextWindowExceededError` but the error's `model` field is `"(unknown)"` even though the model name was in the env config `LLM_PROVIDER_DEEPSEEK_4FLASH_DEEPINFRA=deepinfra|deepseek-ai/DeepSeek-V4-Flash|cost:5/day,req:2000/hour` and available to the adapter at request-construction time.
- **Verbatim error observed (BEPA production, 2026-07-21T09:35 UTC):**
  ```
  Provider "deepseek-4flash-deepinfra": context window exceeded for model "(unknown)"
      at wrapProviderError (file:///app/node_modules/@llm-ports/core/dist/index.mjs:1755:14)
      at executeChatRequest (file:///app/node_modules/@llm-ports/adapter-openai/dist/index.mjs:1323:13)
      at async Object.generateStructured (file:///app/node_modules/@llm-ports/adapter-openai/dist/index.mjs:687:30)
      at async walkChain (file:///app/node_modules/@llm-ports/core/dist/index.mjs:1185:22)
      at async RegistryPort.generateStructured (file:///app/node_modules/@llm-ports/core/dist/index.mjs:1346:20)
  ```
- **Impact:** When an operator triages a context-window incident, they need to know WHICH model overflowed to decide the fix (route to a bigger model, split the payload, etc.). `(unknown)` sends them digging through env config to figure out what the provider alias maps to. This is the second most common error class for LLM operators; the error should carry the model identifier as configured.
- **Suspected fix.** The error-classification path in `wrapProviderError` looks for `providerResponse.model` (which providers may not echo back on error) instead of `request.model` (which the adapter always has). Fix: fall back to `request.model` when `response.model` is absent; propagate as `error.modelId`. The request context is threaded through `executeChatRequest`; adding `modelId` to `wrapProviderError`'s input contract is a small change.
- **Consumer-side origin:** BEPA `TD-LLMPORTS-DEEPINFRA-CONTEXT-EXCEEDED-MODEL-UNKNOWN-AND-SILENT-HANG-ON-RETRY` (Bug 1), filed 2026-07-21T03:06:38.
- **Related to (feature-shaped follow-up).** This bug becomes impossible under the Plan 58 v0.4 §5 `ErrorInfo` shape from the outsider critique: adding required `model_id: string` (plus `provider_alias`, `task_type`, `request_id`) at the taxonomy level makes the "(unknown)" state a typecheck failure at error-construction time, not a runtime surprise. Consider whether this fix should be a point patch now or bundled with the ErrorInfo taxonomy work.
- **Provenance.** Cross-consumer review pass 2026-07-21 (BEPA + ADW consumers reporting).

### TD-LLMP-17: `runAgent` throws raw TypeError when `tools` omitted; local TypeErrors then get misclassified as ServiceUnavailableError, triggering futile chain-wide failover

- **Severity:** Medium (defect 1 is ergonomic; defect 2 is high-impact because it burns the failover chain on client-side bugs and misdirects operator diagnostic to provider status pages).
- **Status:** Open.
- **Files:** `packages/core/src/registry/registry.ts` (`RegistryPort.runAgent`), `packages/adapter-openai/src/adapter.ts` (and every adapter with the same wrapping pattern); `packages/core/src/errors.ts` (add a new class).
- **Problem — two distinct defects.**
  1. **Missing guard.** Calling `runAgent` without a `tools` field produces a raw `TypeError: Cannot convert undefined or null to object`. An `Object.*` operation runs on `tools` with no default. Absent tools should mean "no tools" (identical to `tools: {}` which already works) or reject with a typed validation error that names the field.
  2. **Error misclassification (the load-bearing half).** The local synchronous `TypeError` from defect 1 gets wrapped by the error-classification path as `ServiceUnavailableError`. The registry then dutifully fails over across the whole provider chain, re-throwing the identical local error at each hop, while the operator reads "service unavailable" and inspects the provider status page. Same misdirection pattern that made the 2026-06-06 Anthropic credit-exhaustion incident look like a provider outage for 24 hours.
- **Reproduction (from ADW, live container, 2026-07-21).** Same call, only the `tools` field differs:
  - `runAgent({ ...base, tools: {} })` => OK (normal completion).
  - `runAgent({ ...base })` (tools omitted) => FAIL: `Provider "gptoss-cerebras" service unavailable: Cannot convert undefined or null to object`.
- **Impact.** Defect 1 alone: consumers work around by always passing `tools: {}` (ADW has TD-LLM-21 tracking this workaround). Defect 2: a client-side bug triggers N provider API calls (N = fallback chain length), each failing identically, plus operator misdirection.
- **Suspected fix (two parts).**
  1. Default `tools` to `{}` at the `runAgent` entry point. Matches type-signature-suggests-optional reading and the observed `tools: {}` behavior.
  2. Adapter code wraps ONLY the provider-call block (the network call and its immediate response handling) in the error-classification try/catch. Local synchronous throws BEFORE the network call propagate as-is. Add a new typed class `AdapterInternalError extends LLMPortError` for local throws; the walk-table treats it as `fallback_worthy: false` (does not trigger cross-provider failover). Error message distinguishes port-internal from provider-returned so operators see which side of the boundary the failure came from.
- **Consumer-side origin:** ADW `TD-LLM-21` (`E:\Codes\adw\Development_TechDebt.md:1125-1141`); BEPA `TD-LLMPORTS-TYPEERROR-MISCLASSIFIED-AS-SERVICE-UNAVAILABLE` (BEPA is latently exposed via any local TypeError in adapter/registry code that gets misclassified and walked; BEPA's `AgentConfig.tools` type is required so the specific `runAgent` shape does not surface, but the general misclassification does).
- **Related to (feature-shaped follow-up).** The `AdapterInternalError` class ties directly into the Plan 58 v0.4 §5 `ErrorInfo.fallback_worthy: boolean` field from the outsider critique, and into TD-LLMP-19 below (canonical walk-table publication).
- **Provenance.** Cross-consumer review pass 2026-07-21 (BEPA + ADW consumers reporting).

### TD-LLMP-18: `attemptValidationRepair` should normalize Unicode confusables (dashes, quotes, spaces) on `invalid_enum_value` Zod errors before retry

- **Severity:** Medium. Silent-failure class: when a model emits a Unicode confusable of an ASCII delimiter used in an enum literal, Zod rejects with `invalid_enum_value` and the revision round is discarded with no operator-visible signal about the underlying cause.
- **Status:** Open.
- **Files:** `packages/core/src/utils/repair-validation.ts` (`attemptValidationRepair`, exported via `packages/core/src/index.ts:213`).
- **Problem.** Models occasionally emit Unicode confusables of ASCII delimiter characters used in enum literals. The observed variant (ADW production, 2026-07-21): model emitted `interfaces[5].type = "shared‑lib"` using U+2011 (non-breaking hyphen) instead of ASCII U+002D hyphen-minus. The Zod enum `["api","event","shared-lib","database"]` rejected it (`invalid_enum_value ... received 'shared‑lib'`), the revision round was discarded, and 6,925 output tokens were wasted. The bug class is broader than hyphens: any Unicode confusable of a delimiter character used in an enum literal is exposed.
- **Verified affected classes:**
  - Hyphens: U+2010, U+2011, U+2012, U+2013, U+2014, U+2015, U+2212 vs U+002D ASCII hyphen-minus.
  - Quotes: U+2018, U+2019, U+201C, U+201D vs U+0022, U+0027 ASCII quotes.
  - Spaces: U+00A0, U+2007, U+2008, U+2009 vs U+0020 ASCII space.
  - Fullwidth (rare but real; some Chinese-tuned models): U+FF0D fullwidth hyphen-minus, etc.
- **Impact.** Silent failure across every `@llm-ports` consumer whose Zod schemas include enum values containing any of the ASCII delimiters listed above. Consumers reinvent (or fail to reinvent) their own normalization; those without it silently discard revision rounds and appear to fail convergence for reasons unrelated to content quality.
- **Suspected fix.** Extend `attemptValidationRepair` with a schema-aware normalization step. On `invalid_enum_value` errors, walk `error.issues`, and for each issue where the received value is a string, compute the Unicode-normalized form. If the normalized value matches one of the expected options in `issue.options`, replace the received value in a cloned data object and retry `schema.safeParse(cloned)`. If no normalization would fix any issue, propagate the original error unchanged.
- **Rationale for the design (why not other options).**
  1. Per-call-site `.transform()` on each affected enum: N call sites per consumer, easy to miss on new enums, no ecosystem leverage. Ruled out.
  2. Consumer-side `normalizedEnum()` helper: same one-consumer scope problem. Ruled out.
  3. Blind Unicode normalization at `extractJSON` layer: corrupts free-text content (an em dash in a quoted user message becomes a hyphen). No schema awareness to distinguish enum-valued fields from free-text fields. Ruled out.
  4. Prompt-side "use ASCII hyphens only" instruction: reduces frequency but does not close exposure; model drift is unreliable.
  5. **Schema-aware repair in `attemptValidationRepair`: recommended.** Fires only on enum-validation failures for string-typed values. Never touches free-text content in `z.string()` fields. Automatic (zero-config for consumers). Bounded scope (small subset of validation errors already handled). Idempotent (ASCII stays ASCII).
- **Implementation sketch.**
  ```typescript
  const UNICODE_CONFUSABLE_MAP: Array<[RegExp, string]> = [
    [/[‐-―−－]/g, '-'],   // hyphens/dashes -> ASCII
    [/[‘’]/g, "'"],                // curly single quotes -> ASCII apostrophe
    [/[“”]/g, '"'],                // curly double quotes -> ASCII quote
    [/[    ]/g, ' '],    // non-breaking / thin spaces -> ASCII space
  ];
  function normalizeConfusables(s: string): string {
    return UNICODE_CONFUSABLE_MAP.reduce(
      (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
      s
    );
  }
  // Inside attemptValidationRepair: on invalid_enum_value issues, try replacing
  // the received string with its normalized form if the normalized form is in
  // issue.options. If any issue is repaired, retry safeParse and return the
  // result. If none repaired, propagate original error.
  ```
- **Consumer-side origin:** ADW `TD-LLM-20` (`E:\Codes\adw\Development_TechDebt.md:1112`); BEPA `TD-LLMPORTS-EXTRACTJSON-UNICODE-CONFUSABLE-NORMALIZATION` (BEPA verified exposed at three hyphenated enums: `src/ai/schemas.ts:68`, `src/ai/schemas.ts:84`, `src/temporal/activities/call-triage.ts:32`).
- **Provenance.** Cross-consumer review pass 2026-07-21 (BEPA + ADW consumers reporting).

### TD-LLMP-19: publish canonical walk-table + typed `CreditExhaustionError` / `ProviderMalformed400Error` classes so consumers stop hand-coding wrong failover policies

- **Severity:** Medium-High. Every `@llm-ports` consumer that operates in a multi-provider fallback chain writes a custom `runtimeFallback.shouldFallback` predicate. Two known consumers (BEPA, ADW) have walk-table misalignments today: walking on error classes that should abort (client-side bugs, true wrong-key auth) and aborting on classes that should walk (context window exceeded, content policy violation). The root cause is that `@llm-ports` does not publish a canonical walk-table policy; each consumer reinvents (and mis-invents) it. Two specific provider conditions (Anthropic credit exhaustion, Cerebras 400-no-body on complex schema) have no typed class, so consumers walk on `AuthenticationError` and generic `BadRequestError` respectively as a workaround, over-walking on true wrong-key and true malformed-request cases.
- **Status:** Open.
- **Files:**
  - `packages/core/src/errors.ts` (add two new typed classes).
  - `packages/core/src/registry/registry.ts` (canonical walk-table policy).
  - `packages/core/src/index.ts` (export the new classes and, if introduced, a `defaultShouldFallback` predicate).
  - Documentation: expand the runtime-fallback section of the README or a new `docs/failover-policy.md`.
- **The canonical walk-table (proposed).**
  - **Walk (transient / provider-varying):** `RateLimitError`, `ServiceUnavailableError`, `ProviderUnavailableError`, `ContextWindowExceededError`, `ContentPolicyViolationError`, `ImageTooLargeError`, `ContentBlockUnsupportedError`, `CreditExhaustionError` (new; see below), `ProviderMalformed400Error` (new; see below).
  - **Do not walk (deterministic / same across providers):** `AuthenticationError` (true wrong-key), generic `BadRequestError` (unclassified 400), `MessagesRequiredError`, `EmptyMessagesError`, `MessagesConflictError`, `PromptRequiredError`, `NonContiguousSystemError`, `InvalidImageUrlError`, `AdapterInternalError` (see TD-LLMP-17), unknown error classes.
- **Rationale for each edge.**
  - `ContextWindowExceededError` walks: providers have different context windows (Cerebras 128k, GPT-5 400k, Claude Opus 200k, Gemini 3.5 Pro 2M). A 150k request rejected by Cerebras can succeed on GPT-5.
  - `ContentPolicyViolationError` walks: providers apply different content policies. Anthropic refuses some things OpenAI accepts and vice versa.
  - `AuthenticationError` does not walk: wrong key won't fix on the next provider (each provider has its own key). Walking wastes calls AND leaks the failure pattern across vendors.
  - Generic `BadRequestError` does not walk: unclassified 400 is most likely identical across providers (missing field, invalid JSON, malformed message role).
- **The two new typed classes (needed to remove the current workarounds).**
  - `CreditExhaustionError extends LLMPortError`: surface for provider-billing-exhausted conditions. Today BEPA and ADW walk on `AuthenticationError` as a workaround for Anthropic credit exhaustion (which surfaces as HTTP 401 with a credit-exhaustion body). Once `CreditExhaustionError` exists, the classifier walks on it (recovers via a different vendor's fresh billing state) while true wrong-key `AuthenticationError` aborts. Classification hook: the existing `AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS` array in `packages/core/src/errors.ts` already carries the message-body patterns; converting it into a typed-error classification is straightforward.
  - `ProviderMalformed400Error extends LLMPortError`: surface for the "provider returned 400 with empty or malformed body" condition (Cerebras exhibits this on complex-schema structured-output requests). Today BEPA walks on generic `BadRequestError` as a workaround. Once `ProviderMalformed400Error` exists, the classifier walks on it while true generic 400 (client-side bugs) aborts. Classification: detect empty response body or unparseable JSON error body with 400 status code.
- **Impact.** Multi-provider consumers stop hand-coding walk policies. BEPA's classifier at `src/ai/llm.ts:357-379` becomes the exported `defaultShouldFallback` (or is replaced by it). ADW's classifier at `registry.ts:170` same. The four-way misalignment BEPA has today (walks on Auth + generic 400; aborts on Context + ContentPolicy) is corrected in one release. ADW's TD-LLM-18 walk-on-BadRequestError is also corrected.
- **Suspected fix.** Add the two new classes to `errors.ts` with their classification patterns. Add `defaultShouldFallback` to `registry.ts` exports. Document the walk-table policy explicitly (e.g. add a section to the getting-started guide or a new `docs/failover-policy.md`). Update the two example consumers (BEPA and ADW have already opened parallel BEPA-side / ADW-side TDs to adopt the new API once shipped).
- **Consumer-side origin:**
  - BEPA `TD-LLMPORTS-CLASSIFIER-WALK-TABLE-4-WAY-MISALIGNMENT` (BEPA-side classifier defects and adoption plan).
  - ADW `TD-LLM-18` (audit finding — Severity High "likely bug": ADW's `shouldFallback` walks on `BadRequestError` deliberately).
  - ADW `TD-LLM-21` "related policy question" section (failover-on-400 explicitly).
- **Ties into Plan 58 v0.4 §4.10 (walk-table publication as part of the observability contract).** This TD is the concrete implementation deliverable. The Plan 58 §4.10 contract specifies the walk-table shape; TD-LLMP-19 lands the two new typed classes and the `defaultShouldFallback` export in `@llm-ports/core`.
- **Provenance.** Cross-consumer review pass 2026-07-21 (BEPA + ADW consumers reporting).

---

## Convention reminder

When resolving an entry, append a "Resolved YYYY-MM-DD: <commit-sha> — <one-line note>" to the entry. Do not delete it. The historical context is what makes this log useful.

When opening a new entry, give it the next sequential `TD-LLMP-NN` ID. Don't reuse numbers.
