# v0.1.0-alpha.27 — Legacy input removed (BREAKING)

The two-cycle deprecation window opened in alpha.26 is now closed. `instructions` and `prompt` are removed from all four generation-method options interfaces; `messages: LLMMessage[]` is now required.

## Removed

- `GenerateTextOptions.instructions?: string`
- `GenerateTextOptions.prompt?: MessageContent`
- Same two fields on `GenerateStructuredOptions`, `StreamTextOptions`, `StreamStructuredOptions`.
- Registry-side dual-population (`populateLegacyFieldsFromMessages`) that synthesized legacy fields from `messages` for alpha.26 backwards-compat.
- The specific `warnDeprecatedLegacyInput` verb (replaced by the generalized `warnDeprecated`; see below).

## Required (was optional in alpha.26)

- `messages: LLMMessage[]` on all four generation methods.

## Renamed public helper

- `warnDeprecatedLegacyInput(state, method)` → `warnDeprecated(state, details)`.
- New signature accepts a `DeprecationDetails` object: `{ what, where, removalVersion?, migrationUrl? }`.
- Runtime behavior identical (method-only dedup, `suppressDeprecationWarnings`, `deprecationWarningHandler` routing). `WarningState` + `createWarningState` unchanged.
- The new signature is domain-agnostic and reusable for any future deprecation cycle.

## New error class

- `NonContiguousSystemError extends LLMPortError`. Adapter-anthropic and adapter-google throw this when a system-role message appears mid-conversation (after any user or assistant message). Both providers structurally reject non-leading system messages via their top-level `system` / `systemInstruction` fields; the adapter fails loudly at the boundary rather than silent flattening. Ollama, Vercel, OpenAI pass mid-conversation system messages through inline (their providers tolerate them).

## Adapter migration (Blocker 1 of the release)

All four legacy adapters (Ollama, Vercel, Anthropic, Google) now consume `options.messages` natively:

- **Ollama** — pass-through via `toOllamaMessages(options.messages)`.
- **Vercel** — `resolveMessagesForVercel` folds leading system into the SDK's top-level `system` field; per-message multimodal preserved.
- **Anthropic** — `resolveMessagesForAnthropic` folds leading system into the top-level `system` field; throws `NonContiguousSystemError` on non-leading system.
- **Google** — `resolveMessagesForGoogle` folds leading system into `systemInstruction`; throws `NonContiguousSystemError` on non-leading system.

## `@llm-ports/capabilities`

Linked lockstep bump to 0.1.0-alpha.27. The alpha.26.1 hotfix content is included: all 7 factory implementations (`createExtractor`, `createClassifier`, `createScorer`, `createSummarizer`, `createDrafter`, `createAnalyzer`, `createPlanner`) build `messages: LLMMessage[]` internally via `toMessages(system, userPrompt)`, unblocking the alpha.27 upgrade path. Regression-guard test suite `tests/legacy-shape-guard.test.ts` prevents reintroduction of the legacy shape in an internal port call.

## Consumer surface preserved

The wrapper input types on `@llm-ports/capabilities` (`DraftInput.instructions`, `ExtractInput.text`, etc.) are unchanged. Only the internal port-call shape moved to `messages`. Downstream consumers of the factories see zero API changes.

## Migration

Full guide: [`docs/migration/alpha-26-to-alpha-27.md`](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-26-to-alpha-27.md).

**One-line migration (alpha.26 code):**

```ts
// Before (alpha.25 and earlier — removed in alpha.27)
port.generateText({
  taskType: "triage",
  instructions: SYSTEM_PROMPT,
  prompt: userInput,
});

// After (mechanical, via shim)
import { toMessages } from "@llm-ports/core";
port.generateText({
  taskType: "triage",
  messages: toMessages(SYSTEM_PROMPT, userInput),
});

// Or idiomatic (via helpers)
import { sys, usr } from "@llm-ports/core";
port.generateText({
  taskType: "triage",
  messages: [sys(SYSTEM_PROMPT), usr(userInput)],
});
```

If you already migrated during the alpha.26 window with `messages`, alpha.27 is a no-op runtime change: your call sites already use the canonical shape. You lose the deprecation-warning noise on the legacy code path (which you no longer had).

## Test coverage

886 tests pass workspace-wide across all publishable packages:
- @llm-ports/core: 355
- @llm-ports/adapter-contract-tests: 9
- @llm-ports/capabilities: 72
- @llm-ports/adapter-anthropic: 76
- @llm-ports/adapter-google: 63
- @llm-ports/adapter-ollama: 40
- @llm-ports/adapter-openai: 247
- @llm-ports/adapter-vercel: 24

Zero regressions.

## What's next

Planning discussions for the next four cycles are already published:
- alpha.28 (target 2026-08-05) — 16 items across contract-test polish, adapter parity fixes, cost/observability rigor, DX helpers.
- alpha.29 (target 2026-08-19) — 11 items focused on runtime-fallback ergonomics, streaming primitives, tools-first drafts.
- alpha.30 (target 2026-09-02) — 2 items (perf pass on hot paths, docs restructure).
- alpha.31 — 3 items (adapter-transformers-node, adapter-tesseractjs, pipeline primitive).

See the pinned planning discussions in [Announcements](https://github.com/baabakk/llm-ports/discussions/categories/announcements).

## Packages published

- `@llm-ports/core@0.1.0-alpha.27`
- `@llm-ports/adapter-openai@0.1.0-alpha.27`
- `@llm-ports/adapter-anthropic@0.1.0-alpha.27`
- `@llm-ports/adapter-google@0.1.0-alpha.27`
- `@llm-ports/adapter-ollama@0.1.0-alpha.27`
- `@llm-ports/adapter-vercel@0.1.0-alpha.27`
- `@llm-ports/capabilities@0.1.0-alpha.27`

Install: `npm install @llm-ports/core@alpha @llm-ports/adapter-openai@alpha @llm-ports/capabilities@alpha` (or your adapters of choice).
