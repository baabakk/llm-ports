# `llm-ports` Tech Debt Log

Append-only record of known compromises, design tradeoffs, and deferred work. Each entry has a severity (High / Medium / Low), a status (Open / In Progress / Resolved / Blocked), the affected files, the problem statement, the impact, and a resolution path.

When resolving an item, mark **Status: Resolved** with the date and the commit SHA. Do not delete entries — the history is the value.

Format: timestamped headings (date + system + subsystem), severity + status fields, append-only.

---

# 2026-08-21T09:00 PDT

## llm-ports

### TD-LLMPORTS-FOUR-DISPLACED-RELEASE-THEMES: four consecutive announced release themes were replaced by the observability arc, and none of the displacements was recorded

- **Severity:** High
- **Status:** Open. Raised by an external consumer (ADW) on 2026-08-21 and verified against the published record the same day.
- **Files:** `docs/migration/alpha-26-to-alpha-27.md` (where the themes were announced), `docs/v0-1-status.md` (where they were absent from the queue), `CHANGELOG.md`
- **Problem:** `docs/migration/alpha-26-to-alpha-27.md`, a shipped artifact released 2026-07-17, named four themed releases with target dates. The same text appears in the alpha.27 changeset and in several per-package changelogs, so it went out with the packages rather than living only in a discussion thread.

  | Announced | Shipped instead |
  |---|---|
  | alpha.28 "Reliability + observability polish", sixteen items synthesized from four consumers | Observability contract foundation only; the driving plan committed to §5.1 alone |
  | alpha.29 "Capability factory ergonomics" | Runtime observability instrumentation |
  | alpha.30 "Persistent backends + caching" | Streaming instrumentation, adapter-side emission, OpenTelemetry bridge |
  | alpha.31 "Local runtime + orchestration" | A single-issue `operation_id` hotfix |

  The observability arc consumed four consecutive release slots that had been publicly themed for other work. Each displacement was individually defensible; none was recorded anywhere a consumer could see.
- **Impact:** A consumer planning against the published roadmap has been waiting four releases for work that was never re-queued and never withdrawn. The specific report: persistent budget backend and response caching, both under alpha.30's announced theme, are still absent at alpha.32, and five of that consumer's own findings scoped into alpha.28 did not ship either.

  This is the same defect already recorded once at smaller scale, when alpha.31's announced eval scope was displaced by a hotfix (see TD-LLMPORTS-ALPHA31-EVAL-BACKENDS-DEFERRED). The fix applied then was a "near-term alpha queue" in `docs/v0-1-status.md`, intended to make exactly this visible. **That queue did not catch this, because it was built from recent working context rather than from the published roadmap**, so it inherited the omission it was meant to prevent. A durable record populated from memory is not a durable record.
- **Resolution path:** Partially addressed 2026-08-21: the four displaced themes are restored to the queue in `docs/v0-1-status.md`, marked owed and named against the release that displaced them, and the queue's status line now records that its earlier "everything owed is discharged" claim was false.

  Remaining, in order:
  1. **Enumerate the unshipped remainder of alpha.28's sixteen-item slate.** Nobody has listed which of the sixteen shipped. Until that exists, no statement about what is owed to those four consumers can be trusted, including this entry's.
  2. Decide per displaced theme whether it is still wanted, then either re-queue it with a target or withdraw it explicitly in a release note. Silence is what caused this.
  3. Build the queue from the published roadmap rather than from working context, and reconcile it against shipped artifacts, not against recollection.
- **Note on the quoted status line.** The consumer's report quotes this project's own status doc: "The alpha.28-to-31 arc has so far produced no observable value in its motivating consumer." That was written 2026-08-19 and was accurate then. It is now stale: telemetry went live on the consumer's production host 2026-08-20, and spans reach storage. The arc did eventually deliver. That does not soften anything above, because the cost was four displaced themes and the delivery was a day after the sentence was written, not before.

# 2026-08-19T22:30 PDT

## llm-ports

### TD-LLMPORTS-STREAM-FALLBACK-NEEDS-PRIMING: `streamText` and `streamStructured` cannot fall back, because an async generator throws too late for the chain walker to see it

- **Severity:** High
- **Status:** Open. Found 2026-08-19 while building `streamChat`, which hit it immediately and works around it locally.
- **Files:** `packages/core/src/registry/registry.ts` (`walkStreamChain`, and the `streamText` / `streamStructured` call sites), `packages/adapter-*/src/adapter.ts` (every `async *streamText`)
- **Problem:** `walkStreamChain` opens a provider's stream inside a `try` and treats a throw as the signal to walk to the next provider. That works only if opening the stream can throw.

  Every adapter implements streaming as `async *streamText(...)`. Calling an async generator function returns a generator object **without executing a single line of its body**. The `await executeChatStream(...)` that actually contacts the provider does not run until the consumer calls `next()`, which happens long after the walker has returned.

  So the walker sees a successful open for a provider that is in fact unreachable, records the attempt as started, marks the alias authenticated, and returns. The real failure surfaces later, during consumer iteration, where there is no chain left to walk.
- **Impact:** **Runtime fallback silently does not work for the streamed methods.** A consumer with a three-provider chain who configured `runtimeFallback: "aggressive"` gets no failover on `streamText` at all: the first provider's failure reaches them directly. This is invisible in tests that stub streams as plain arrays or as generators that yield before failing, which is why it survived to now. It is exactly the class of defect the streaming path was supposed to be protected against.
- **Resolution path:** Prime the stream inside the walker, as `streamChat` now does. `walkStreamChain`'s `openStream` accepts `S | Promise<S>` and awaits it (already shipped in alpha.32), so the remaining work is to change the `streamText` and `streamStructured` call sites to pull their first event through `primeStream` and replay it through `replayPrimed`, both already present in `registry.ts`.

  The cost is one buffered event per stream, which is what `replayPrimed` exists to give back, and a slightly earlier first provider contact. Neither is observable to a consumer. Add a test for each method that fails a provider at first-iteration rather than at call time, since that is the shape the current tests do not produce.
- **Note on scope:** deliberately not fixed in alpha.32. Changing the failure semantics of two shipped methods is a behaviour change that deserves its own release and its own notes, rather than riding along inside a new-feature release where nobody would look for it.

# 2026-08-19T17:30 PDT

## llm-ports

### TD-LLMPORTS-FINGERPRINT-CACHE-FLAKY-TEST: a flaky test in the workspace gate, and a fixed temp path behind it

- **Severity:** Medium
- **Status:** Open. Found 2026-08-19 during the alpha.31.2 release verification.
- **Files:** `packages/adapter-openai/src/fingerprint.ts` (`FileFingerprintCache.persist`, around line 180), `packages/adapter-openai/tests/quirks/fingerprint.test.ts`
- **Problem:** `FileFingerprintCache > delete removes entries` fails intermittently. Measured at one failure in four consecutive isolated runs on Windows; it passes in isolation most of the time and failed inside a full `pnpm -r test`. Two contributing defects, one in the test and one in the implementation.

  **In the implementation.** `persist()` writes through a temp file whose path is a fixed derivation, `${this.path}.tmp`, then renames it over the target. Two cache instances pointing at the same path therefore share one temp path and will clobber each other mid-write, and on Windows a rename over an existing target is not the atomic operation the comment claims it is; it can transiently fail under a filesystem or scanner lock. The comment says "Atomic write via temp + rename," which is true on POSIX and overstated on Windows.

  **In the test.** `afterEach` unlinks the cache path but never the `.tmp` sibling, so temp files accumulate in the system temp directory across runs. Test paths are derived from `Date.now()` plus `Math.random()`, which makes collision unlikely but not impossible, and nothing asserts isolation.
- **Impact:** Larger than the one test. The workspace suite is the release gate, and several release commits in this repository cite "full workspace green" as the verification. That claim is weaker than it reads while any test in the suite is non-deterministic, because a green run no longer distinguishes "nothing is broken" from "the flake did not fire this time." The failure is also a false alarm that costs whoever hits it an investigation.
- **Resolution path:** Give the temp file a unique suffix per write (process id plus a counter, or a random component) so concurrent instances cannot collide. On Windows, retry the rename briefly on `EPERM` and `EBUSY` rather than failing the write, or fall back to a write-then-replace that tolerates the locked case. Clean up the `.tmp` sibling in the test's `afterEach`. Then run the test in a loop, at least fifty iterations, and confirm it is genuinely deterministic rather than merely passing once.
- **Not fixed here** because it sits in a package outside the alpha.31.2 scope, and a Windows-specific filesystem flake deserves a focused diagnosis rather than a guess folded into a release commit.

# 2026-08-19T03:41 PDT

## llm-ports

> The four entries in this section were originally filed in a downstream consumer's tech-debt log while that consumer was adopting alpha.30 and alpha.31. They are upstream-owned, so they belong here. Identifiers are preserved verbatim so existing downstream cross-references keep resolving. Downstream now carries pointers rather than copies.

### TD-LLMPORTS-AUTH-STATE-NOT-PLUGGABLE: authentication state is the only cross-cutting Registry state without an injectable backend, so two Registry instances classify the same credential differently

- **Severity:** High
- **Status:** Resolved **in code only** 2026-08-19 in `0.1.0-alpha.31.1`, commit e5de656. `RegistryOptions.auth` accepts an `AuthBackend`; `InMemoryAuth` is the default and reproduces alpha.30 behavior exactly. 11 tests in `packages/core/tests/auth-backend.test.ts`. The alpha.30 additive-compatibility claim is corrected in the alpha.31.1 changelog entry.

  **Correction, 2026-08-19.** This entry was first marked simply "Resolved" while **two of the three items in its own resolution path were undelivered.** That was a hygiene failure: an entry may not be closed against a partially-executed resolution path without naming what was skipped. Both carve-outs are now tracked separately and this status is qualified rather than clean:
  - Resolution item (1) shipped, but only in its synchronous form, so the multi-process claim it made was not delivered. See TD-LLMPORTS-AUTH-STATE-CROSS-PROCESS.
  - Resolution item (3), the reference-documentation statement, was never written. See TD-LLMPORTS-REGISTRY-SHARING-UNDOCUMENTED.
  - Resolution item (2), the alpha.30 notes correction, is the only one delivered in full.
- **Files:** `packages/core/src/registry/registry.ts` (line 395 the field, 481 the reader, 491 the writer), `packages/core/src/errors.ts` (lines 716 and 859, the walk-versus-abort branch), `CHANGELOG.md` (the alpha.30 additive-compatibility claim), `docs/`
- **Problem:** Alpha.30 began tracking, per Registry instance, which provider aliases have ever authenticated successfully. That set decides whether an authentication failure means "this credential never worked, so walk to the next provider" or "this credential worked moments ago, so configuration changed underneath us, abort." The set is a private instance field at `registry.ts:395`, never reset per the comment at line 390, read via `hasEverAuthenticated(alias)` at line 481. The branch consuming it appears twice in `errors.ts`, at 716 and 859. An application holding two Registry instances therefore holds two independent copies, and the same credential failing on the same alias can be classified differently by each depending on which authenticated first.

  The precise defect is not that alpha.30 added state. It is that alpha.30 added a fourth kind of cross-cutting Registry state without the injectable-backend treatment the other three already have. `budgetBackend` and `costBackend` both exist so that state can live outside the instance and be shared. Authentication state got no equivalent, and it is the only private per-instance collection in the entire registry file.

  There is no single-registry contract to fall back on. The only relevant guidance anywhere is one line in the getting-started tutorial ("Once at app startup. Hold the returned port as a singleton"), which concerns not rebuilding per call. No reference page, type, or runtime warning states that multiple instances are unsupported.
- **Impact:** Silent, data-dependent divergence in error handling. Nothing logs it, nothing fails loudly, and the verdict depends on instance ordering. The first known consumer held two registries only to express a per-route timeout, which `taskDefaults` now makes unnecessary, so that instance is being deleted. The defect survives it. Per-tenant API key isolation is an ordinary reason to hold one Registry per tenant with shared aliases and distinct keys, and under the current design a successful authentication in tenant A changes how tenant B's dead key is classified. A credential fault in one tenant alters failure semantics in another, which nothing in the public API would lead a reader to predict.

  Compounding this: the alpha.30 release notes state "fully additive; existing consumers see identical behavior when they don't opt into the new fields." That is false for any consumer holding more than one Registry, and it is the sentence a reader would rely on when deciding whether the upgrade warranted review.
- **Resolution path:** (1) Add an `authBackend` option to `RegistryOptions` following the established shape of `budgetBackend` and `costBackend`, defaulting to the current in-memory per-instance behavior so no existing consumer changes. This additionally gives multi-process deployments a shared authentication view, which the present design cannot express at all. (2) Correct the alpha.30 release notes to name the multi-registry exception to the additive claim. (3) Add one explicit statement to the reference documentation covering what is and is not shared across Registry instances, which a reader currently cannot answer short of reading `registry.ts`.

### TD-LLMPORTS-AUTH-STATE-CROSS-PROCESS: the shipped `AuthBackend` is synchronous, so it cannot share authentication state across processes

- **Severity:** Low
- **Status:** Open. Split out of TD-LLMPORTS-AUTH-STATE-NOT-PLUGGABLE on 2026-08-19 when that item shipped without this part.
- **Files:** `packages/core/src/auth/types.ts`, `packages/core/src/registry/registry.ts`
- **Problem:** The `AuthBackend` interface shipped in alpha.31.1 is synchronous, because `Registry.hasEverAuthenticated()` is a public synchronous method and the value is read inside `shouldFallback`, a synchronous error-classification path. Making the interface async would have been a breaking API change and would have pushed `await` into error handling for a set-membership test. The consequence is that a backend cannot perform a blocking read against a shared external store.
- **Impact:** Several Registry instances in ONE process can now share a view, which was the reported defect and is closed. Several processes cannot, so a horizontally-scaled deployment still has each process learning independently which credentials work. The practical effect is bounded: each process converges after its own first successful call per alias, and the failure mode it guards against (mid-flight credential revocation) is still detected per process rather than missed. An implementation can serve a locally-cached snapshot refreshed by some other mechanism, but that refresh is outside this interface.
- **Resolution path:** Either add an async sibling interface consulted at a point where awaiting is already acceptable (before the chain opens, rather than inside classification), or define an explicit refresh contract alongside the sync read so an implementation can state when its snapshot is stale. Deferring until a consumer reports actually wanting it, rather than designing it speculatively.

### TD-LLMPORTS-REGISTRY-SHARING-UNDOCUMENTED: `AuthBackend` shipped as public API with no documentation, and the promised registry-sharing statement was never written

- **Severity:** Medium
- **Status:** **Resolved 2026-08-19**, commit e17ad1e. `docs/concepts/registry-state.md` answers what two Registry instances share and what they do not, with a table covering all six kinds of Registry state and which three are injectable. It documents `AuthBackend` and `InMemoryAuth`, the walk-versus-abort decision that motivates the option, the synchronous-by-design rationale and its cross-process limit, and points readers at `taskDefaults` before they build a second Registry. Registered in the docs sidebar.
- **Files:** `docs/` (no page currently covers it), `packages/core/src/auth/types.ts`
- **Problem:** Two related gaps. First, `AuthBackend` and `InMemoryAuth` shipped in alpha.31.1 as exported public API, and appear nowhere in `docs/` except one row of the roadmap table. A consumer cannot discover the option, learn when to share a backend, or find the synchronous-by-design rationale without reading the changelog or the source. Second, resolution item (3) of the parent entry promised "one explicit statement covering what is and is not shared across Registry instances," and it was never written. That statement is what makes the whole class of defect discoverable rather than something each consumer rediscovers.
- **Impact:** The fix for a High-severity correctness defect is effectively invisible. A consumer holding two Registry instances still has no documented way to learn they need to share a backend, which is the exact situation the parent entry existed to prevent. Shipping a fix nobody can find is close to not shipping it.
- **Resolution path:** A short concepts page covering the `auth` option, when sharing matters (several registries in one process, per-tenant isolation), the synchronous-by-design rationale and its cross-process limit, and a worked example. Alongside it, a table in the reference documentation listing each kind of cross-cutting Registry state (configuration, budget, cost, authentication) and stating for each whether it is per-instance by default and whether it is injectable.

### TD-LLMPORTS-ALPHA31-EVAL-BACKENDS-DEFERRED: the announced alpha.31 scope was displaced by an unrelated hotfix and moved a version without being recorded

- **Severity:** Medium
- **Status:** **Resolved 2026-08-19** in `0.1.0-alpha.31.2`, commit 4c2b715. Both announced halves shipped: the Postgres backend, and the evaluation-workflow tooling (`OperationSource`, `aggregateScores`, `detectRegression`, `sampleEvaluations`, `runBatchJudge`, `runComparison`). ClickHouse was withdrawn rather than deferred, on the verified grounds in the design finding below. 57 tests.
- **Files:** `README.md`, `docs/v0-1-status.md`, `CHANGELOG.md`, `packages/eval/`
- **Problem:** Before alpha.31 shipped, the README stated: "Coming next: `alpha.31` — persistence backends beyond SQLite (Postgres, ClickHouse), and evaluation-workflow tooling." What shipped under that number was per-call `operation_id` precedence, a single unrelated change cut to unblock a downstream consumer. The forward-looking README line was then rewritten to point at alpha.32, moving a stated deliverable a version with no record of the deferral anywhere.
- **Impact:** No runtime effect. The cost is that `@llm-ports/eval` shipped at alpha.28 with in-memory and SQLite stores only, and the Postgres and ClickHouse backends have now carried a "coming next" label across two version boundaries. Anyone tracking the project sees a stated deliverable move with no explanation, and nothing in the log would cause the work to be picked back up. Secondary observation: alpha.31 was a hotfix carrying a README badge and a full aggregate changelog entry proportionate to a much larger release. Its notes were accurate about what it contained; the mismatch was between its framing and its size.
- **Resolution path:** Partially addressed in commit 34e332a, which added a "Near-term alpha queue" to `docs/v0-1-status.md` as the durable record, added a scope note to the alpha.31 changelog entry naming what it displaced, and repointed the README's forward-looking line at the queue instead of a version number. Remaining: actually ship the displaced work. Convention now recorded: when a release ships contents other than what was queued, the displacement is recorded in that release's changelog entry rather than by editing the forward-looking line.

- **Design finding, 2026-08-19 (ClickHouse does not fit the store contract).** Verified against ClickHouse's own documentation before writing any code. The `EvaluationStore` contract is append-only with **exact** idempotent-write semantics: `write()` returns `true` on a new row and `false` on a dedup hit, and `get` / `find` / `count` must reflect one row per `evaluation_id`. Postgres honors that natively via `INSERT ... ON CONFLICT DO NOTHING` with an exact `rowCount`. ClickHouse does not:

  - `ReplacingMergeTree` deduplicates by the `ORDER BY` key, and **only during background merges at unpredictable times** ("Merging occurs in the background at an unknown time, so you can't plan for it").
  - The `FINAL` modifier does **not** rescue this. ClickHouse's documentation states it "offers eventual correctness only, it does not guarantee rows will be deduplicated, and you should not rely on it." An earlier internal suggestion that `ReplacingMergeTree` plus `FINAL` would make reads exact was wrong and is retracted here.
  - `insert_deduplication_token` is the mechanism that actually fits, and it works on non-replicated tables once `non_replicated_deduplication_window` is set. Supplying `evaluation_id` (or `idempotency_key`) as the token makes a repeat insert a genuine no-op, so no duplicate row lands and reads stay exact without `FINAL`. Its limit is that the dedup window is bounded to the N most recent blocks, so a duplicate arriving after the window has rolled past will land.

  Consequence: a ClickHouse backend can be *row-correct* via the insert token, but `write()`'s boolean return still cannot be determined without a separate read, and correctness is bounded by the dedup window rather than unconditional. Three honest options: ship it with those two caveats documented on the backend itself; ship ClickHouse as a write-only sink outside `EvaluationStore` and let reads go to Postgres; or defer ClickHouse and ship Postgres alone. Postgres is unaffected by any of this and remains close to a mechanical port of the SQLite backend.

- **Priority finding, 2026-08-19.** The August competitive analysis rates this work strategically minor: no buyer selects an LLM abstraction library for its evaluation storage. It is nonetheless *owed*, having been announced and displaced once. Recommendation recorded there is to ship the Postgres backend to honor the commitment and to reshape or defer ClickHouse, while the streaming tool-call surface takes priority as the strategic item.

### TD-LLMPORTS-TELEMETRY-OTEL-TRACER-VARIANCE: the `telemetry-otel` `Tracer` interface is not TypeScript-compatible with the real `@opentelemetry/api` `Tracer`

- **Severity:** Low
- **Status:** Resolved 2026-08-19 in `0.1.0-alpha.31.1`, commit e5de656. `startSpan` widened to arity-3 with the third parameter typed `unknown`; `AttributeValue` array variants changed from `ReadonlyArray` to mutable `Array`. Verified end-to-end by removing the cast in a real consumer that passes an `@opentelemetry/api` tracer and confirming a clean typecheck.
- **Files:** `packages/telemetry-otel/src/` (the `Tracer` / `SpanOptions` / `Attributes` interface declarations)
- **Problem:** The package declares its own minimal `Tracer`, `SpanOptions`, and `Attributes` interfaces, intended as a dependency-free structural subset of `@opentelemetry/api`. The subset picked two variances that do not unify with the real type. First, `Tracer.startSpan(name, options?)` is arity-2 while the real `Tracer.startSpan(name, options?, context?)` is arity-3, and TypeScript refuses to widen a two-parameter function type to accept a three-parameter one. Second, the `AttributeValue` array variants are declared `readonly Array<...>` while the real ones are mutable `Array<...>`, and TypeScript refuses to assign a readonly array to a mutable index signature.
- **Impact:** Both variances are safe at runtime. A real Tracer's optional third argument satisfies a two-argument call site via arity contravariance, and readonly arrays are assignable at emit time. The cost is compile-time only: every consumer passing a real `@opentelemetry/api` tracer to `createOtelSink({ tracer })` must add an `unknown` cast at the call site, costing one line of code plus a tech-debt entry per adopter. At least one downstream consumer already carries that cast.
- **Resolution path:** Widen `Tracer.startSpan` to `(name: string, options?: SpanOptions, context?: unknown) => Span`, since the context parameter is opaque to the sink and declaring it `unknown` matches the real arity without taking `@opentelemetry/api` as a peer dependency. Change the `AttributeValue` array variants from `readonly Array<...>` to `Array<...>` so the real type unifies structurally. Zero runtime change, type-only. Consumers can then drop the cast.

### TD-LLMPORTS-REGISTRY-PER-CALL-CONTEXT: the Registry minted its own `operation_id` at every port method call, ignoring a caller-supplied `withObservabilityContext(port, ctx)`

- **Severity:** Medium
- **Status:** Resolved 2026-08-19 in `0.1.0-alpha.31`, commit 93e6cb6
- **Files:** `packages/core/src/instrumentation.ts`, `packages/core/src/registry/registry.ts`, `packages/core/tests/per-call-operation-id.test.ts`
- **Problem:** Alpha.29 shipped `Instrumentation.context.operation_id` as a Registry-level, configuration-time pinning slot. There was no per-call mechanism. `withObservabilityContext(port, { operation_id })` stored context on the wrapped port instance via a WeakMap, and adapters could retrieve it through `resurrectOperationContext(port)`, but the Registry's own `withOperation` read only `instrumentation.context?.operation_id` and otherwise minted fresh. A caller wrapping the port for one call still saw a Registry-minted id on every emitted event.
- **Impact:** Consumers could not pre-mint an id and use it as a correlation key across stores, because the id they supplied was ignored and the id actually used never came back on the port result. Cross-store joins between an application's own quality records, its incident rows, and OpenTelemetry spans were only possible on an id the application could not see.
- **Resolution path:** Shipped. `startOperation` and `withOperation` each gained an optional final `perCallContext?: ObservabilityContext` parameter, and all five Registry port methods now pass `getObservabilityContext(this)` through. Precedence resolves per-call context first, then Registry-level context, then a fresh mint. Purely additive. Nine tests cover all four precedence conditions across all five methods.

---

# 2026-08-11 PST

## llm-ports

### TD-BENCHMARKS-LEGACY-INPUT-FIELDS: `packages/benchmarks/` still uses alpha.27-removed `prompt` / `instructions` fields

- **Severity:** Low
- **Status:** **Resolved 2026-08-19.** Migrated to the `messages` shape across six files using the canonical `sys()` / `usr()` helpers. `pnpm -r typecheck` now passes workspace-wide, which it had not done since alpha.27.

  Worth recording, because a naive rewrite got it wrong first: `runAgent` still **requires** `instructions` as its own field, and the capability factories take their own input shapes entirely. A blanket `instructions` to system-message conversion therefore broke both. The migration only rewrites `generateText`, `generateStructured`, `streamText`, and `streamStructured` call sites, and `usr()` accepts `MessageContent`, so content-block array prompts carry over unchanged.
- **Files:** `packages/benchmarks/src/latency.bench.ts`, `packages/benchmarks/src/live/anthropic.test.ts`, `packages/benchmarks/src/live/capabilities.test.ts`, `packages/benchmarks/src/live/ollama.test.ts`, `packages/benchmarks/src/live/openai.test.ts`, `packages/benchmarks/src/live/vercel.test.ts`, `packages/benchmarks/src/memory.bench.ts`
- **Problem:** Alpha.27 removed the legacy `{ instructions, prompt }` input shape from every generation-method options interface (see the alpha.27 changeset). The `benchmarks` package was not migrated at the time; ~30-50 call sites across the files listed above still pass `prompt: "..."` and `instructions: "..."` and TypeScript refuses them under `tsc --noEmit`. Discovered during the alpha.29 release-verification pass when `pnpm typecheck` was run for the first time in a while.
- **Impact:** `pnpm typecheck` fails workspace-wide on `packages/benchmarks/`. `benchmarks` is `private: true` (not published), and every failing file is under `src/live/*.test.ts` or a `.bench.ts` — both offline test discovery and the offline `pnpm test` suite skip these, so nothing at runtime is broken. The impact is one broken typecheck gate + a small blocker for anyone wanting to run the benchmarks with `RUN_LIVE_TESTS=1`.
- **Resolution path:** Mechanical migration to the `messages: LLMMessage[]` shape. Roughly: `prompt: "text"` → `messages: [{ role: "user", content: "text" }]`; `instructions: "text"` alongside a `prompt` → prepend a `{ role: "system", content: "text" }` message. A ~30-minute pass. Sibling packages already migrated: `consumer-type-check/src/budget-scope.ts` (fixed 2026-08-11 during this same verification pass; see `packages/consumer-type-check/src/budget-scope.ts`).

### TD-ALPHA29-ADAPTER-EMIT-DEFERRED: adapter-level contract event emission deferred to alpha.30

- **Severity:** Medium
- **Status:** **Resolved in `0.1.0-alpha.30`; status corrected 2026-08-19.** The work shipped but this entry was never updated, so the log said Open while the release notes said closed. Verified by reading source rather than trusting either: `emitAgentStepStarted` / `emitAgentToolCalled` are called from `packages/adapter-anthropic`, `-google`, and `-openai` adapters. Recorded as a bookkeeping gap rather than a delivery gap.
- **Files:** `packages/adapter-{openai,anthropic,google,ollama,vercel,codex,aider}/src/adapter.ts`, `packages/core/src/registry/registry.ts` (Registry wraps every attempt itself), `plans/alpha.29-runtime-instrumentation.md` (§7 scope-adjustment entry)
- **Problem:** The original plan §2.1 model was "Registry wraps operations, adapters wrap attempts, `OperationContext` flows through as a first-class argument." Implementing that cleanly requires a channel to pass the mutable `OperationContext` object from the Registry into the adapter. `withObservabilityContext(port, ctx)` only carries the correlation IDs (from the observability-contract package), not the counter state the shared service tracks. Adding an `_opCtx?` field to every `LLMPort` method's options would be a public API surface change and a leaky abstraction (adapters would have to know about `OperationContext`'s shape). Rather than force one of those, alpha.29 ships Registry-only instrumentation: the Registry's `walkChain` wraps each attempt with `withAttempt` itself, and adapters emit nothing at the operation or attempt level via the shared service.
- **Impact:** Consumers who bypass the Registry and import a raw in-process adapter (`createOpenAIAdapter().createLLMPort()` and call it directly) see zero contract events for their calls. Consumers using the Registry — the vast majority — get full observability. The gap is real but small; direct-adapter callers today are typically in tests or in edge cases where the Registry is intentionally sidestepped. The codex + aider subprocess adapters shipped inline emission in alpha.28 and continue to emit their own attempt events when called directly, but that emission is duplicated with what the Registry emits if wired through the Registry — a second-order redundancy that also lands here.
- **Resolution path:** Two candidate designs for alpha.30 to pick between: (a) Extend the observability-contract's `ObservabilityContext` to carry an opaque "operation handle" that adapters treat as pass-through, plus a small helper on the shared service that resurrects an `OperationContext` from a handle. Adapters call `withAttempt(reconstructOpCtx(handle), ...)` when a handle is present, and open their own `withOperation` otherwise. (b) Add an `_opCtx?: OperationContext` field to every `LLMPort` method's options interface, marked internal. Uglier but no shape changes to the contract package. Alpha.30 also lands streaming instrumentation, which needs the same "adapter emits its own events" plumbing; the two are naturally paired.

### TD-ALPHA29-AGENT-STEP-EVENTS-DEFERRED: agent step + tool events deferred to alpha.30

- **Severity:** Low
- **Status:** **Resolved in `0.1.0-alpha.30`; status corrected 2026-08-19.** Same bookkeeping gap as the entry above, and verified the same way: all three in-process adapters emit the agent step and tool events.
- **Files:** `packages/core/src/registry/registry.ts` (`RegistryPort.runAgent`), `packages/adapter-*/src/adapter.ts` (their internal tool-use loops)
- **Problem:** Plan §2.5 named `agent.step.*` and `agent.tool.*` events for the runAgent tool-use loop. Those events fire from INSIDE the adapter's tool-use loop, not at the Registry boundary — the Registry sees one `runAgent(options) → AgentResult` call regardless of how many internal steps the adapter took. Under the Option A scope adjustment (see TD-ALPHA29-ADAPTER-EMIT-DEFERRED), adapters don't emit contract events, so agent step/tool events cannot land in alpha.29.
- **Impact:** Consumers observing a `runAgent` call see `operation.started`, one `attempt.started`, one `attempt.completed`/`failed`, `operation.completed`/`failed` — no per-step or per-tool-call granularity. For long-horizon agent runs (the primary ADW use case), this is a real loss of visibility: a 20-step run looks the same as a 1-step run at the observability layer.
- **Resolution path:** Lands with adapter-level emission in alpha.30. When adapters gain access to an `OperationContext` (or its handle equivalent), the runAgent tool-use loop can emit `agent.step.started`/`completed` per iteration and `agent.tool.called`/`succeeded`/`failed` per tool invocation using the shared service's helpers.

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
- **Status:** **Resolved; status corrected 2026-08-19.** The entry says detection only fires after a starved response, wasting the first call. `packages/adapter-openai/src/capabilities.ts:143` now exports `KNOWN_REASONING_MODELS`, and line 168 seeds the learner from that catalogue at construction, so a known reasoning model is never discovered by burning a call. Post-hoc learning remains the path for models absent from the catalogue, which is correct residual behaviour rather than a defect.
- **Files:** `packages/adapter-openai/src/adapter.ts` (`learnFromResponse`, `reasoningStarvedResponse`)
- **Problem:** Detection only fires AFTER seeing reasoning tokens or a populated `message.reasoning` field. The first call against an unknown reasoning model with a small `maxOutputTokens` always returns starved, triggers the auto-retry, and only then learns the constraint. The first call's tokens are wasted.
- **Impact:** A long-running process touching N reasoning models pays N wasted first-call costs. Real cost is small ($0.0001 each) but the latency hit (one extra round-trip per model) is real.
- **Resolution path:** Either (a) opt-in seed list users can supply via `pricingOverrides[modelId].capabilities.reasoningModel = true`, or (b) a one-time `/v1/models` probe at adapter creation time (most providers don't expose capability metadata, so this is best-effort). Documenting (a) in the OpenAI adapter README is probably enough for now.

### TD-LLMP-04: `learnedConstraints` Map is unbounded and global

- **Severity:** Low
- **Status:** **Open, but narrowed 2026-08-19.** Re-verified against source. The entry made three sub-claims; only the first still holds.

  (1) **Still true.** `createCapabilityLearner` holds a plain `Map` with no eviction and only a `_reset()` for tests, so a long-running process touching many models accumulates entries forever.

  (2) **No longer true.** The process-wide singleton is gone. `createCapabilityLearner()` is a factory returning a fresh map per learner, so two adapter instances no longer share state implicitly.

  (3) Superseded by the same restructuring.

  Remaining work is therefore bounded eviction alone, not the ownership question.
- **Files:** `packages/adapter-openai/src/capabilities.ts:27`
- **Problem:** Process-wide singleton Map keyed by modelId. (1) Long-running processes touching many models accumulate forever (no eviction). (2) Two `createOpenAIAdapter` instances share the Map — possibly desired (key rotation shouldn't lose learning) but undocumented. (3) `hasSucceeded` is per-AdapterContext, so two adapters with the same key learn independently — opposite of (2).
- **Impact:** Edge cases. Memory growth probably never matters in practice (constraints are tiny objects, hundreds of models max). The hasSucceeded inconsistency is more interesting: an attacker who can create new adapter instances could probe burst protection without using the existing instance's "proven good" flag.
- **Resolution path:** (1) Add a configurable LRU cap (default 256 models). (2) Document the global-Map decision explicitly. (3) Decide whether `hasSucceeded` should also be process-global keyed by `apiKey`-prefix-hash; resolve the inconsistency one way or the other.

### TD-LLMP-05: `zodToParameters` is a stub

- **Severity:** Medium
- **Status:** **Resolved; status corrected 2026-08-19.** The entry says both adapters emit an empty `properties` object, losing all field types. Verified false: `adapter.ts:2118-2122` passes through the real `properties` and `required` produced by `zodToJsonSchema` with the OpenAI target, and `adapter-anthropic` uses the same converter. Tools carry their full schema.
- **Files:** `packages/adapter-openai/src/adapter.ts:919` (and `packages/adapter-anthropic/src/adapter.ts` equivalent)
- **Problem:** Both adapters convert Zod tool schemas to `{type:"object", properties:{}}` — losing all field types. Tools are effectively typeless to the model; it must guess parameter names from the description string.
- **Impact:** Any user calling `runAgent` with non-trivial tools gets degraded model performance. The model has to invent parameter names instead of reading them from a schema. Fail-rate goes up; latency goes up (more retries).
- **Resolution path:** Wire in `zod-to-json-schema` (the canonical converter, ~5KB). Add a `zodConverter` option to adapter constructors so users can swap in `@anatine/zod-openapi` or other variants.

### TD-LLMP-06: No observability into adapter retries

- **Severity:** Medium
- **Status:** **Resolved; status corrected 2026-08-19.** The entry says three retry kinds happen silently. `adapter-openai` now has six `onRetry` / `emitRetryEvent` call sites, and `OnRetry`, `RetryEvent`, `RetryReason`, and `emitRetryEvent` are part of core's public surface.
- **Files:** `packages/adapter-openai/src/adapter.ts` (executeChatRequest, executeChatStream, withTransientAuthRetry)
- **Problem:** Three retry kinds happen silently: capability-rejection retry, transient-401 retry, reasoning-starved retry. A production user has no signal that "Cerebras just retried 2x with backoff before this 800ms response."
- **Impact:** When users debug latency spikes or unexpected costs, they can't see the retry behavior. Hard to diagnose "why is this call slow" without instrumenting the OpenAI SDK directly.
- **Resolution path:** Add an `onRetry` hook to `OpenAIAdapterOptions`: `onRetry?: (event: RetryEvent) => void` where `RetryEvent` carries `{kind: "capability" | "transient_auth" | "reasoning_starved", attempt: number, modelId: string, alias: string}`. Same pattern as capability `onResult`.

### TD-LLMP-07: Cost precision change (10-decimal) not unit-tested

- **Severity:** Low
- **Status:** **Resolved; status corrected 2026-08-19.** The entry asks for a test pinning 10-decimal precision so a future rounding change cannot silently regress it. `packages/core/tests/cost-edges.test.ts` states that guarantee in its own header and asserts `toBeCloseTo(0.00002, 10)`.
- **Files:** `packages/core/src/budget/cost.ts`
- **Problem:** Recently bumped from 6-decimal to 10-decimal precision so embeddings (`5 tokens × $0.02/1M = $1e-7`) don't round to 0. The change is correct but no unit test pins it. A future "round to 6 decimals for serialization" PR could silently regress.
- **Impact:** Cost-gated workloads with very small per-call costs would silently bypass the gate.
- **Resolution path:** Add `packages/core/tests/cost.test.ts` with a case asserting `computeEmbeddingCost(5, {embeddingPer1M: 0.02})` returns a positive value (not zero).

### TD-LLMP-09: Registry has no runtime-error fallback — only budget-gating fallback

- **Severity:** Medium
- **Status:** **Resolved; status corrected 2026-08-19.** The entry says the chain is consulted only at selection time, with no try/catch around the port call. `walkChain` in `registry.ts` now wraps every attempt and walks on a fallback-worthy error; `runtimeFallback` is listed as stable in `docs/v0-1-status.md` since alpha.7.

  **Caveat, and a real one:** this holds for the non-streaming methods only. The streamed methods still cannot fall back, for a different reason found on this same date. See TD-LLMPORTS-STREAM-FALLBACK-NEEDS-PRIMING.
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
- **Status:** **Resolved; status corrected 2026-08-19.** The entry says the Vercel adapter has no reasoning headroom multiplier. `adapter-vercel/src/adapter.ts:63` defines exactly that, with starvation detection at line 195 and an `onRetry` emission carrying reason `reasoning-starvation`.
- **Files:** `packages/adapter-vercel/src/adapter.ts`
- **Problem:** The OpenAI adapter applies a 10x reasoning-headroom multiplier when it learns a model is a reasoning model (so a request for 20 visible tokens gets max=200 sent to the API, leaving room for CoT). The Vercel adapter has none of this — calling `vercel.generateText({ maxOutputTokens: 20 })` against `gpt-5-nano` reliably starves the model and returns empty text. Discovered while triaging Phase 2 vercel failures.
- **Impact:** Vercel-adapter users with reasoning models hit silent empty-output failures unless they manually budget 10x more than they want visible. Inconsistent with the OpenAI adapter's transparent handling.
- **Resolution path:** Port the reasoning-detection + auto-retry + headroom multiplier logic from `adapter-openai/src/adapter.ts` (executeChatRequest, learnFromResponse, reasoningStarvedResponse) to the Vercel adapter. Or extract the logic to a shared helper in `@llm-ports/core` so both adapters consume it. The shared-helper path is cleaner long-term but bigger scope.

### TD-LLMP-12: Vercel adapter throws SyntaxError "Unexpected end of JSON input" on empty structured response

- **Severity:** Medium
- **Status:** **Resolved; status corrected 2026-08-19.** The entry says an empty structured completion surfaces as a raw `SyntaxError` from `JSON.parse`. `adapter-vercel/src/adapter.ts:402-405` now throws a typed `EmptyResponseError`, with a comment naming that exact failure.
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
- **Status:** **Resolved; status corrected 2026-08-19.** The mechanism shipped in alpha.28 pre-work and cites this entry by name: `wrapProviderError(alias, err, modelId?)` threads the model into `ContextWindowExceededError`. Verified the adapter actually passes it, at four of five call sites (1138, 1210, 1239, 1774). The fifth, line 1169, is `listModels`, outside any per-call path, so it correctly omits the model and the legacy placeholder now appears only where no model is in play.
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
- **Status:** **Resolved; status corrected 2026-08-19.** `toOpenAITools` opens with a guard returning an empty array for absent tools, and its comment cites this entry as the reason. The raw `TypeError` that was being misclassified as `ServiceUnavailableError` and triggering futile chain-wide failover can no longer occur.
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
- **Status:** **Resolved; status corrected 2026-08-19.** `packages/core/src/utils/repair-validation.ts` normalizes Unicode confusables in the repair pass, so an `invalid_enum_value` caused by a look-alike dash, quote, or space is repaired before retrying rather than costing a round trip.
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
- **Status:** **Resolved; status corrected 2026-08-19.** Both typed classes ship from core's public surface, `CreditExhaustionError` and `ProviderMalformed400Error`, alongside `aggressiveShouldFallback` and `AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS`, which is the canonical walk-table this entry asked to publish. BEPA has since replaced its hand-rolled classifier with the preset.
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

### TD-LLMP-20: Registry needs a capability-based router: declarative task requirements + declarative provider capabilities + boot-time chain resolution (replaces the current manual-chain LLM_TASK_ROUTE_* model)

- **Severity:** Medium-High. Every multi-provider consumer today writes provider-alias chains by hand for every task type and hopes they picked providers with adequate context window / structured-output support / cost tier. Adding a task type is silent: no compile-time signal that a route is missing; the registry falls through to whatever default chain resolution picks. Adding a provider is silent: it does not automatically become a candidate for tasks whose requirements it satisfies. Removing a provider leaves dangling chain refs. Payload-that-exceeds-fleet-capability catches at runtime (after N wasted API calls across the whole chain) instead of at boot.
- **Status:** Open.
- **Files:** Would live in the standalone `@llm-ports/observability-contract` package (per Plan 58 v0.4 §4.10 architectural decision) with runtime integration in `packages/core/src/registry/`. New exports: `TaskRequirements`, `ProviderCapabilities`, `resolveChain`, plus a `capabilityChain` option on `createRegistryFromEnv`.
- **Problem — the current manual-chain model in detail.** BEPA hit the trap on 2026-07-21T09:35 UTC (Plan 55 Phase 1 smoke test). The `selector-compile` task type had no `LLM_TASK_ROUTE_SELECTOR_COMPILE` set, so the registry fell through to a default chain that included `deepseek-4flash-deepinfra` (32K context window) at a position where a 564KB payload would land. The provider correctly returned context-window-exceeded, the registry walked to the next provider, that provider also returned context-window-exceeded, and the whole chain exhausted before the operator saw anything but "provider failed" errors. A boot-time capability match against a declared `minContextTokens: 32_000` requirement would have caught this before the first API call.
- **Consumer report — the shape of the proposal (BEPA-authored 2026-07-21).**
  - Task types declare what they need:
    ```typescript
    export const TASK_REQUIREMENTS = {
      "selector-compile": {
        minContextTokens: 32_000,
        needsStructuredOutput: true,
        needsStrictJson: true,
        costTier: "medium",
        latencyTolerance: "patient",
      },
      "triage": {
        minContextTokens: 4_000,
        needsStructuredOutput: true,
        costTier: "cheap",
        latencyTolerance: "fast",
      },
      // ~13 task types in BEPA today
    };
    ```
  - Providers declare what they can do:
    ```typescript
    export const PROVIDER_CAPABILITIES = {
      "claude-sonnet":   { contextTokens: 200_000, structuredOutput: true, strictJson: true,  costPerMOutTokens: 15,  latencyP50Ms: 2000, reliability: 0.99 },
      "gpt5":            { contextTokens: 128_000, structuredOutput: true, strictJson: true,  costPerMOutTokens: 10,  latencyP50Ms: 1500, reliability: 0.98 },
      "deepseek-4flash": { contextTokens:  32_000, structuredOutput: true, strictJson: false, costPerMOutTokens:  0.4, latencyP50Ms: 1000, reliability: 0.85 },
      // ...
    };
    ```
  - Router matches at boot:
    ```typescript
    function resolveChain(taskType, providers) {
      const reqs = TASK_REQUIREMENTS[taskType];
      return providers
        .filter(p => p.contextTokens >= reqs.minContextTokens)
        .filter(p => !reqs.needsStructuredOutput || p.structuredOutput)
        .filter(p => !reqs.needsStrictJson || p.strictJson)
        .filter(p => costMatchesTier(p, reqs.costTier))
        .sort(byReliabilityThenCost);
    }
    ```
- **What this buys.**
  - Adding a task type: declare requirements → router auto-picks matching providers. No env edit.
  - Adding a provider: declare capabilities → router auto-includes it for matching tasks. No per-task-type env edit.
  - Removing a provider: no dangling chain refs to prune.
  - Misconfigured payload catches early: task type's `minContextTokens` fires an error BEFORE any provider is invoked. "This task needs 32K but the largest available in your fleet is 8K." Today's failure mode (call provider, get context-exceeded back, walk chain, get context-exceeded again, exhaust chain, error) becomes a startup-time signal.
  - Operator visibility at boot: `task=selector-compile matched 3 providers: [claude-sonnet, gpt5, mimo-parasail]`. Every task type's chain is deterministic and visible.
  - `LLM_TASK_ROUTE_*` env vars become an OVERRIDE mechanism, set only when a specific chain is needed (A/B testing, kill switches, cost experiments). Default is capability-matched.
- **Suspected fix (implementation shape).**
  1. Add `TaskRequirements` and `ProviderCapabilities` types to `@llm-ports/observability-contract` (or to a `capability-routing` sub-module).
  2. Add `resolveChain(taskType, providers, taskRequirements)` as a pure function.
  3. Add a `capabilityChain?: { requirements: Record<TaskType, TaskRequirements> }` option on `createRegistryFromEnv`. When present, the registry resolves each task type's chain via `resolveChain` at boot; existing `LLM_TASK_ROUTE_*` env vars override the resolved chain per-task-type.
  4. Emit boot-time log lines: `task=<taskType> matched N providers: [<alias1>, <alias2>, ...]` for every task type, so operators see the resolution.
  5. Fail-fast if any task type has zero matching providers. Error message names the task type, its requirements, and the closest-matching providers with the reasons they failed the match.
- **Alternate placement (rejected, documented for the record).** BEPA-side layer above the registry that does the matching and feeds the resolved chain to the registry via `LLM_TASK_ROUTE_*` env vars. Rejected because `@llm-ports` IS the routing library; capability-based matching belongs there. Every downstream consumer would otherwise reinvent the same logic. See consumer origin below for the full BEPA-side analysis.
- **Consumer-side origin.** BEPA Firefox-side proposal 2026-07-21 (BEPA `Development_Logs.md` entry same date). BEPA's short-term stopgap: `LLM_TASK_ROUTE_SELECTOR_COMPILE` set manually on 2026-07-21 as an env-var patch. Long-term migration path is capability-based routing once this TD lands upstream.
- **Related to (feature-shaped follow-up).** Plan 58 v0.4 §4.12 (capability-based routing spec) documents the contract from the consumer side; this TD is the upstream implementation deliverable. Ties into §4.10 (walk-table publication) because both live in `@llm-ports/observability-contract` as declarative substrates.
- **Provenance.** Cross-consumer review pass 2026-07-21 (BEPA firefox proposal reporting).

---

## Convention reminder

When resolving an entry, append a "Resolved YYYY-MM-DD: <commit-sha> — <one-line note>" to the entry. Do not delete it. The historical context is what makes this log useful.

When opening a new entry, give it the next sequential `TD-LLMP-NN` ID. Don't reuse numbers.
