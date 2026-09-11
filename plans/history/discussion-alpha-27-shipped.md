# v0.1.0-alpha.27 shipped — legacy input removed (BREAKING)

The two-cycle deprecation window opened in [alpha.26](https://github.com/baabakk/llm-ports/discussions/63) is now closed. Legacy `instructions` and `prompt` are removed from all four generation-method options interfaces; `messages: LLMMessage[]` is now required.

## TL;DR

If you migrated to `messages` during the alpha.26 window, alpha.27 is a runtime no-op — bump and you're done. If you were still on `instructions`/`prompt`, upgrade requires the mechanical one-line change per call site. Full migration guide: [`docs/migration/alpha-26-to-alpha-27.md`](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-26-to-alpha-27.md).

## What changed

**Removed:**
- `instructions?` and `prompt?` from `GenerateTextOptions` / `GenerateStructuredOptions` / `StreamTextOptions` / `StreamStructuredOptions`.
- Registry dual-population (`populateLegacyFieldsFromMessages`) — the shim that let alpha.26 code keep working with the legacy shape is gone.
- The specific `warnDeprecatedLegacyInput` verb (replaced by the generalized `warnDeprecated`; see below).

**Required (was optional):**
- `messages: LLMMessage[]` on all four generation methods.

**Renamed public helper (domain-agnostic infrastructure preserved):**
- `warnDeprecatedLegacyInput(state, method)` → `warnDeprecated(state, details)` where `details: DeprecationDetails = { what, where, removalVersion?, migrationUrl? }`.
- Runtime behavior identical (per-`where` dedup, `suppressDeprecationWarnings`, `deprecationWarningHandler`). The rename makes the surface reusable for any future deprecation cycle.

**New error class:**
- `NonContiguousSystemError extends LLMPortError`. Adapter-anthropic and adapter-google throw this when a system-role message appears mid-conversation (after any user or assistant message). Both providers structurally reject non-leading system messages via their top-level `system` / `systemInstruction` fields; the adapter fails loudly at the boundary rather than silent flattening. Ollama, Vercel, OpenAI pass mid-conversation system messages through inline.

**Adapter native consumption:**
- Ollama, Vercel, Anthropic, Google all consume `options.messages` natively now (no legacy synthesis path).
- OpenAI already consumed messages natively in alpha.26; the legacy branch in `resolveMessagesFromCallOptions` is deleted.

## Consumer impact

**Wrapper types unchanged.** `@llm-ports/capabilities` wrapper input types (`DraftInput.instructions`, `ExtractInput.text`, etc.) are untouched. If you build on top of the capability factories rather than calling the port directly, alpha.27 is transparent — the internal port call shape changed, the consumer-facing API did not.

**Direct port calls:**
```ts
// alpha.25 and earlier (removed in alpha.27)
port.generateText({
  taskType: "triage",
  instructions: SYSTEM_PROMPT,
  prompt: userInput,
});

// alpha.27 (via shim — mechanical, one line per site)
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

## Packages published

All 7 publishable packages ship at 0.1.0-alpha.27:
- `@llm-ports/core`
- `@llm-ports/adapter-openai`
- `@llm-ports/adapter-anthropic`
- `@llm-ports/adapter-google`
- `@llm-ports/adapter-ollama`
- `@llm-ports/adapter-vercel`
- `@llm-ports/capabilities` (linked lockstep bump; alpha.26.1 hotfix content is included)

Install: `npm install @llm-ports/core@alpha @llm-ports/adapter-openai@alpha @llm-ports/capabilities@alpha` (adjust adapter list to your stack).

## Test coverage

886 tests pass workspace-wide across all publishable packages. Zero regressions from alpha.26.

## What's next

Planning discussions for the next four cycles are already published:
- alpha.28 target 2026-08-05 — contract-test polish, adapter parity fixes, cost/observability rigor, DX helpers (16 items). See [#alpha.28 planning](https://github.com/baabakk/llm-ports/discussions/64).
- alpha.29 target 2026-08-19 — runtime-fallback ergonomics, streaming primitives, tools-first drafts (11 items). See [#alpha.29 planning](https://github.com/baabakk/llm-ports/discussions/65).
- alpha.30 target 2026-09-02 — perf pass on hot paths, docs restructure (2 items). See [#alpha.30 planning](https://github.com/baabakk/llm-ports/discussions/66).
- alpha.31 — adapter-transformers-node, adapter-tesseractjs, pipeline primitive (3 items). See [#alpha.31 planning](https://github.com/baabakk/llm-ports/discussions/67).

Feedback on scoping welcome in each planning thread.

## Release links

- GitHub Release: https://github.com/baabakk/llm-ports/releases/tag/@llm-ports/core@0.1.0-alpha.27
- Migration guide: [`docs/migration/alpha-26-to-alpha-27.md`](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-26-to-alpha-27.md)
- Full CHANGELOG for `@llm-ports/core`: [`packages/core/CHANGELOG.md`](https://github.com/baabakk/llm-ports/blob/main/packages/core/CHANGELOG.md)
