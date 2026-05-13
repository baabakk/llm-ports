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

## Convention reminder

When resolving an entry, append a "Resolved YYYY-MM-DD: <commit-sha> — <one-line note>" to the entry. Do not delete it. The historical context is what makes this log useful.

When opening a new entry, give it the next sequential `TD-LLMP-NN` ID. Don't reuse numbers.
