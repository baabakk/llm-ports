# `llm-ports` Tech Debt Log

Append-only record of known compromises, design tradeoffs, and deferred work. Each entry has a severity (High / Medium / Low), a status (Open / In Progress / Resolved / Blocked), the affected files, the problem statement, the impact, and a resolution path.

When resolving an item, mark **Status: Resolved** with the date and the commit SHA. Do not delete entries — the history is the value.

Format: same convention as BEPA's `Development_TechDebt.md` (timestamp + system + subsystem heading).

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

### TD-LLMP-08 (BLOCKER): OpenAI API key deactivated — Phase 2/3 verification stalled

- **Severity:** High (blocks test phases)
- **Status:** Blocked (awaiting key rotation by Babak)
- **Files:** `.env` (BEPA root), `OPENAI_API_KEY` ending in `wrwA`
- **Problem:** Direct curl to `api.openai.com/v1/models` with the current key returns HTTP 401 "Incorrect API key". The key was working earlier in Phase 2 but has since been deactivated (rotated, revoked, or moved to a different project).
- **Impact:** TEST-PLAN.md Phase 2 (Live API integration) and Phase 3 (Capabilities live integration) cannot complete the OpenAI portions. Cerebras compat works (verified). Anthropic and Ollama tests are blocked by missing key/daemon (separate matter).
- **Resolution path:** Babak rotates the OpenAI API key, updates `.env`, reruns `pnpm test:live` (full suite). Then reruns the capabilities suite which falls back to OpenAI when ANTHROPIC_API_KEY is absent.

---

## Convention reminder

When resolving an entry, append a "Resolved YYYY-MM-DD: <commit-sha> — <one-line note>" to the entry. Do not delete it. The historical context is what makes this log useful.

When opening a new entry, give it the next sequential `TD-LLMP-NN` ID. Don't reuse numbers.
