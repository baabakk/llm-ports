---
"@llm-ports/core": patch
"@llm-ports/adapter-openai": patch
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-google": patch
"@llm-ports/adapter-ollama": patch
"@llm-ports/adapter-vercel": patch
"@llm-ports/capabilities": patch
---

Alpha.26 — API unification (canonical `messages` input). **BREAKING in alpha.27** — this release adds the canonical shape alongside the deprecated fields; alpha.27 removes the deprecated fields.

**The change.** The four generation methods (`generateText` / `generateStructured` / `streamText` / `streamStructured`) now accept a canonical `messages: LLMMessage[]` input, aligning with `runAgent`'s existing shape and every provider's native protocol. The legacy `{ instructions, prompt }` shape is `@deprecated` and will be removed in alpha.27.

```ts
// Before (alpha.25 and earlier)
port.generateText({
  taskType: "triage",
  instructions: SYSTEM_PROMPT,
  prompt: userInput,
});

// After (alpha.26 mechanical, via shim — one-line change per site)
import { toMessages } from "@llm-ports/core";
port.generateText({
  taskType: "triage",
  messages: toMessages(SYSTEM_PROMPT, userInput),
});

// After (alpha.26 idiomatic, via helpers)
import { sys, usr } from "@llm-ports/core";
port.generateText({
  taskType: "triage",
  messages: [sys(SYSTEM_PROMPT), usr(userInput)],
});

// After (alpha.26 native multi-turn — previously unavailable)
port.generateStructured({
  taskType: "interview-turn",
  schema: InterviewTurnSchema,
  messages: conversationHistory,  // full context with alternating roles
});
```

**Why.** Every provider's actual API speaks `messages: Message[]` natively. The `{ instructions, prompt }` compression was a defensible design when most calls were single-turn, but consumers with multi-turn workloads (chat, interview agents, coaching workflows) had three bad workarounds — roll history into a `prompt` string (loses role fidelity), abuse `runAgent` with `tools: {}` (semantically broken), or reach past the port via `providerExtras` (kills the abstraction). None acceptable. Aligning the port with the underlying protocol fixes this and matches `runAgent`'s existing shape.

**Migration shim + convenience helpers.** Ship in `@llm-ports/core`:

- `toMessages(instructions?, prompt): LLMMessage[]` — mechanical migration for the legacy shape.
- `sys(content: string): LLMMessage` — idiomatic system message constructor.
- `usr(content: MessageContent): LLMMessage` — idiomatic user message constructor.

**Four new errors** exported from `@llm-ports/core`:

- `MessagesRequiredError` — neither `messages` nor `prompt` supplied.
- `EmptyMessagesError` — `messages` array is empty.
- `MessagesConflictError` — both `messages` AND legacy fields supplied (ambiguity is a caller bug).
- `PromptRequiredError` — `toMessages()` called with no prompt.

**Deprecation warning UX.** Single-line `console.warn` per method per Registry when the legacy shape is used. Method-only dedup — a consumer with 50 legacy call sites across all four methods gets 4 warnings total (one per method), enough signal to trigger a migration audit without flooding logs.

Opt out for mid-migration:

```ts
const registry = createRegistryFromEnv({
  suppressDeprecationWarnings: true, // alpha.26+; removed in alpha.27
});
```

Structured logging:

```ts
const registry = createRegistryFromEnv({
  deprecationWarningHandler: (msg) => logger.warn({ deprecation: true, msg }),
});
```

**Registry-side normalization.** The `RegistryPort` normalizes both shapes before adapter dispatch: canonical → pass-through; legacy → synthesize `messages = toMessages(instructions, prompt)` + emit deduped warning. The adapter always sees `options.messages` after normalization.

**Adapter changes.** `adapter-openai` reads from `options.messages` when set (Registry-normalized path), with a graceful fallback to `{ instructions, prompt }` for consumers that bypass the Registry and call the adapter directly. System-role messages at the start of the array are extracted and concatenated as `instructions` for consistent per-provider handling. Non-contiguous system messages pass through inline (OpenAI supports them as boundary markers).

**runAgent unchanged.** It already accepted `messages`. Consumers using `runAgent` see zero migration impact.

**Test coverage.** 881 tests pass across the workspace (was 864 at alpha.25; +17; zero regressions):
- Helper + shim tests (toMessages, sys, usr, error paths)
- Canonical messages-flow tests (Registry → adapter passing verbatim)
- Legacy-path tests (deprecation warning fires, dedups, respects suppression)
- Error-path tests (all four new errors)
- All existing alpha.25 tests continue to pass unchanged

**Timeline.**
- **alpha.26** (this release): both shapes work. Deprecation warnings on legacy.
- **alpha.27** (~2 weeks): legacy fields removed. TypeScript compilation error if consumers haven't migrated.

See the [alpha.25 → alpha.26 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-25-to-alpha-26.md) for full details, worked examples for all four methods, and the FAQ.
