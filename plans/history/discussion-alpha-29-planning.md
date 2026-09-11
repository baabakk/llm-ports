**Status:** Planning discussion. Target ship 2026-08-19 (two weeks after alpha.28). Extendable to 2026-09-02 if design questions surface.

**Theme:** Capability factory ergonomics. Eleven items adding hooks, schemas, and configuration flexibility to the five capability factories in `@llm-ports/capabilities`, plus one Registry-level diagnostic and one adapter policy adjustment.

**Prior release:** alpha.28 (planned 2026-08-05; reliability + observability polish; see planning discussion filed alongside this one).

---

## What ships in alpha.29

Eleven items across three sub-themes.

### Capability factory hooks + schemas (BEPA-heavy asks)

1. **Optional schema on `createSummarizer`** (BEPA 2). Add `schema?: z.ZodType<T>` to `CreateSummarizerConfig`. When present, factory returns `z.infer<T>` (structured summary); when absent, returns string (current behavior). Kills BEPA's misuse of `createExtractor` for structured summaries. ~40 LoC.
2. **`groundingValidator` hook on `createExtractor`** (BEPA 3). New optional config field: `groundingValidator?: (output: T, input: ExtractInput) => string[] | null`. Runs after schema validation succeeds; failures returned by the validator become the correction prompt for retry-with-feedback. Kills BEPA's 40-line outer retry loop. ~60 LoC.
3. **Optional schema on `createAnalyzer`** (BEPA 4). Symmetric with Item 1; returns string when schema absent, `z.infer<T>` when present. Kills BEPA's text-returning `llmAnalyze` escape hatch. ~40 LoC.
4. **`postValidationHook` on `createPlanner`** (BEPA 5). New optional config field: `postValidationHook?: (plan: T) => { valid: boolean; errors?: string[] }`. Runs after schema validation; failures feed the model as retry prompts. Lets BEPA plug DAG cycle detection + activity-name membership + scope validation into the factory's retry loop. ~50 LoC.
5. **Partial-accept-with-defaults in `generateStructured`** (SalesCoach D + Plan 30 A.4). Schema-level defaults fill omitted fields instead of throwing. Consumer supplies `partialAccept: { defaults: Partial<T> }` on the call. Deletes SalesCoach's 52-line `assembleCallPlan`. ~100 LoC.

### Diagnostic + type ergonomics

6. **`Registry.validateWithEnv()` diagnostic** (SalesCoach G). Returns structured report per alias: adapter registered? route has live links? alias references model in bundled catalog? Pricing entry present? Replaces SalesCoach's hand-rolled Phase 4.0 dry-run script. Related to Item 13 (`tolerantKeylessAliases`, alpha.28) but broader. ~150 LoC.
7. **`PartialResultLLMPort` / `CompatibleLLMPort` type export** (BEPA 1). Publishes a branded compat type where result-metadata fields (`cost`, `providerAlias`, `latencyMs`, `validationAttempts`, `stepsTaken`, `terminationReason`) are `Partial`. Removes BEPA's 5 `as unknown as PublishedLLMPort` casts. ~20 LoC (type-level).

### Sessions + vision

8. **Named sessions: `openNamedSession` / `getSession` / `sessions()` / `session.snapshot()`** (Dramma 3). Replaces `openCostSession` with a self-managing named session that supports TTL, snapshot, and cross-worker lookup by id. Kills Dramma's 168-line `session-store.ts`. ~200 LoC + tests.
9. **Vision `port.classify` triage helper** (Dramma 6). New capability factory `createVisionTriager` in `@llm-ports/capabilities`. Takes an image + a list of yes/no triage questions; internally uses the "low-detail" cost knob on vision models. Consumer's downstream `generateStructured` (high-detail) is gated by the triager's `true`/`false` return. ~100 LoC + provider verification for OpenAI vision + Gemini vision.

### Adapter policy

10. **`responseAdapter` hook on `adapter-openai`** (Dramma 2b). Configuration on `createOpenAIAdapter({ responseAdapter?: (raw: unknown) => LLMPortResponse })` for consumers who point adapter-openai at a compat provider whose response includes extra fields (`confidence`, `content_type`, `language`) or a non-standard payload shape. Kills Dramma's 130-line `handleSelfhostedRecognize` proxy. ~80 LoC.
11. **`NonContiguousSystemError` demoted to warning per-adapter** (SalesCoach H). Partially undoes the alpha.27 introduction (per Blocker 1 of alpha.27). Some adapters (Anthropic native multi-system content blocks; some OpenAI-compat providers) tolerate mid-conversation system messages. New adapter option: `nonContiguousSystemPolicy?: "throw" | "warn-and-collapse"` default `"throw"`. ~40 LoC per adapter.

---

## Open design questions

1. **`postValidationHook` vs `groundingValidator` unification.** Both are "run a validator after schema validation succeeds; feed errors back as retry prompts." Ship as ONE hook name shared across factories, or KEEP as two named hooks with subtly different semantics (planner-specific vs extractor-specific)? **Recommendation:** ship as one hook name (`postValidateHook<T>`) shared across all five capability factories; consumers implement whatever validation logic they need.
2. **Named session persistence.** Registry-level in-memory (simpler; per-Registry-instance) VERSUS backend-delegated (survives worker restart when a Redis/database backend is provided). **Recommendation:** Registry-level for alpha.29; backend hook in alpha.30 alongside `@llm-ports/budget-redis`.
3. **`createVisionTriager` fallback shape.** If no vision-capable provider is configured, throw at construction OR return a stub that always returns `true` (skip triage; go straight to expensive read)? **Recommendation:** throw at construction with a clear error naming which providers support the low-detail path.
4. **`responseAdapter` scope.** Adapter-openai only (Dramma's specific use case) OR shared across all adapters (any provider might need custom response parsing)? **Recommendation:** shared surface `AdapterRegistration.responseAdapter?: (raw: unknown) => LLMPortResponse` so it applies uniformly across adapter types.
5. **`nonContiguousSystemPolicy: "warn-and-collapse"` collapse strategy.** Concatenate all system-role content and prepend to the array (matches alpha.27 leading-contiguous behavior) OR drop non-leading system messages entirely? **Recommendation:** concatenate + prepend (preserves intent).

---

## Consumer credit

- **BEPA**: findings 1, 2, 3, 4, 5 (5 asks; capability factory work is BEPA-driven).
- **SalesCoach**: findings D, G, H (3 asks).
- **Dramma**: findings 3, 6, 2b (3 asks).
- **ADW**: no new asks in alpha.29; ADW's alpha.28 items completed the reliability line.

---

## Cross-references

- Alpha.28 planning (Items 1-16 in the reliability line): filed alongside this discussion.
- Alpha.30 planning (persistent backends + caching): filed alongside this discussion.
- Alpha.31 planning (local runtime + orchestration): filed alongside this discussion.
- Consumer inputs synthesized in the alpha.27 release plan §A.11 (published post-alpha.27 ship).

Post design-question answers below by 2026-08-12 for baseline scope.
