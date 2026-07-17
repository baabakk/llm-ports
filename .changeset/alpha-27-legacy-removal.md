---
"@llm-ports/core": patch
"@llm-ports/adapter-openai": patch
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-google": patch
"@llm-ports/adapter-ollama": patch
"@llm-ports/adapter-vercel": patch
---

Alpha.27 — Legacy fields removed. **BREAKING (removal).** The two-cycle deprecation window opened in alpha.26 is now closed.

**Removed:**
- `GenerateTextOptions.instructions?: string`
- `GenerateTextOptions.prompt?: MessageContent`
- Same three fields (`instructions?`, `prompt?`) from `GenerateStructuredOptions`, `StreamTextOptions`, `StreamStructuredOptions`.
- Registry-side dual-population (`populateLegacyFieldsFromMessages`) that synthesized legacy fields from `messages` for alpha.26 backwards-compat.
- The specific `warnDeprecatedLegacyInput` verb (replaced by generalized `warnDeprecated`; see below).

**Required (was optional in alpha.26):**
- `messages: LLMMessage[]` on all four generation methods.

**Renamed (public helper):**
- `warnDeprecatedLegacyInput(state, method)` → `warnDeprecated(state, details)`. New signature accepts a `DeprecationDetails` object (`{ what, where, removalVersion?, migrationUrl? }`). The runtime behavior is identical (method-only dedup, `suppressDeprecationWarnings`, `deprecationWarningHandler` routing); the new signature is domain-agnostic and reusable for any future deprecation cycle. `WarningState` + `createWarningState` unchanged.

**New (error class):**
- `NonContiguousSystemError extends LLMPortError`. Adapter-anthropic and adapter-google throw this when a system-role message appears mid-conversation (after any user or assistant message). Both providers structurally reject non-leading system messages via their top-level `system` / `systemInstruction` fields; the adapter fails loudly at the boundary rather than silent flattening. Ollama, Vercel, OpenAI pass mid-conversation system messages through inline (their providers tolerate them).

**Adapter migration (Blocker 1 of the release):**

All four legacy adapters (Ollama, Vercel, Anthropic, Google) now consume `options.messages` natively:

- **Ollama** — pass-through via `toOllamaMessages(options.messages)`.
- **Vercel** — `resolveMessagesForVercel` folds leading system into the SDK's top-level `system` field; per-message multimodal preserved.
- **Anthropic** — `resolveMessagesForAnthropic` folds leading system into the top-level `system` field; throws `NonContiguousSystemError` on non-leading system.
- **Google** — `resolveMessagesForGoogle` folds leading system into `systemInstruction`; throws `NonContiguousSystemError` on non-leading system.

Adapter-openai already consumed `messages` natively as of alpha.26; the alpha.27 changes simplify its `resolveMessagesFromCallOptions` (no more legacy-shape fallback branch).

**Migration for consumers who missed the alpha.26 window:**

TypeScript now errors:
```
error TS2353: Object literal may only specify known properties, and 'prompt' does not exist in type 'GenerateTextOptions'.
```

Follow the [alpha.25 → alpha.26 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-25-to-alpha-26.md) for the migration paths, then bump to alpha.27:

- Mechanical: `messages: toMessages(instructions, prompt)`.
- Idiomatic: `messages: [sys(instructions), usr(prompt)]`.
- Native multi-turn: `messages: conversationHistory`.

Also see [alpha.26 → alpha.27 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-26-to-alpha-27.md).

**Package versions:**

Six publishable packages bumped to `0.1.0-alpha.27`. `@llm-ports/capabilities` stays at `0.1.0-alpha.26.1` (unchanged; migrated internally in the alpha.26.1 hotfix).

**Test coverage:**

886 tests pass across the workspace (was 888 at alpha.26.1; net delta from removing the 5 alpha.26 dual-shape tests + adding 4 new alpha.27 `warnDeprecated` tests). Zero regressions.

**Timeline:**
- alpha.26 (deprecation announced): 2026-07-02
- alpha.26.1 (capabilities internal migration hotfix): 2026-07-03
- alpha.27 (fields removed): 2026-07-22

**Coming next:**

- **Alpha.28** "Reliability + observability polish" — [Planning #64](https://github.com/baabakk/llm-ports/discussions/64) — target 2026-08-05
- **Alpha.29** "Capability factory ergonomics" — [Planning #65](https://github.com/baabakk/llm-ports/discussions/65)
- **Alpha.30** "Persistent backends + caching" — [Planning #66](https://github.com/baabakk/llm-ports/discussions/66)
- **Alpha.31** "Local runtime + orchestration" — [Planning #67](https://github.com/baabakk/llm-ports/discussions/67)
