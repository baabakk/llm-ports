# @llm-ports v0.1.0-alpha.26 — API Unification (Canonical Messages Input)

**Released 2026-07-02.** Install: `pnpm add @llm-ports/core@alpha @llm-ports/adapter-openai@alpha`

⚠️ **BREAKING in alpha.27** (~2 weeks). This release adds the canonical shape alongside the deprecated fields. Migration is mechanical via `toMessages(instructions, prompt)`.

---

## The unification

Every provider's actual API speaks `messages: Message[]` natively. The port's `{ instructions, prompt }` shape was a defensible compression for single-turn calls but couldn't model multi-turn workloads (chat, interview agents, coaching workflows) without bad workarounds.

Alpha.26 unifies. All four generation methods now accept a canonical `messages: LLMMessage[]` input, aligning with `runAgent`'s existing shape and every provider's native protocol:

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

## What ships

### 1. New canonical field: `messages: LLMMessage[]`

On all four generation methods (`generateText`, `generateStructured`, `streamText`, `streamStructured`). Supports arbitrary multi-turn shapes.

### 2. Migration shim + convenience helpers

New exports from `@llm-ports/core`:

- `toMessages(instructions?, prompt): LLMMessage[]` — one-line migration for the legacy shape.
- `sys(content: string): LLMMessage` — idiomatic system message constructor.
- `usr(content: MessageContent): LLMMessage` — idiomatic user message constructor.

### 3. Four new errors

- `MessagesRequiredError` — neither `messages` nor `prompt` supplied.
- `EmptyMessagesError` — `messages` array is empty.
- `MessagesConflictError` — both `messages` AND legacy fields supplied (ambiguity is a caller bug).
- `PromptRequiredError` — `toMessages()` called with no prompt.

### 4. Deprecation warning UX

Single-line `console.warn` per method per Registry when the legacy shape is used. Method-only dedup — a consumer with 50 legacy call sites across all four methods gets 4 warnings total (one per method), enough signal to trigger a migration audit without flooding logs.

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

### 5. Registry-side dual-population

The `RegistryPort` normalizes both shapes to canonical `messages` before dispatch AND populates the legacy `instructions` + `prompt` fields from the resolved messages. This means:

- Adapters updated for `messages` (adapter-openai in this release) get the full multi-turn path.
- Adapters not yet updated (adapter-anthropic, adapter-google, adapter-ollama, adapter-vercel) continue to work by reading the synthesized legacy fields. Single-turn works fully; multi-turn semantically degrades to "system + last user message" until each adapter is refactored in a patch release.

## What's NOT changing

- `runAgent` already took `messages`. Zero migration impact if you only use `runAgent`.
- All other options (temperature, refs, budgetScope, cacheControl, providerExtras, signal, forceProviderAlias, reasoningEffort, strict): unchanged.
- Error taxonomy, observability hooks, budget gating, per-attempt timeout, task routing, fallback chain: unchanged.
- The `MessageContent` type (per-turn content: `string | ContentBlock[]`): unchanged.

## Timeline

- **alpha.26** (this release): both shapes work. Deprecation warnings on legacy.
- **alpha.27** (~2 weeks): legacy fields removed. TypeScript compilation error if consumers haven't migrated.

## Test coverage

- 10 helper + shim tests (toMessages, sys, usr, error paths)
- 5 canonical messages-flow tests (Registry → adapter passing verbatim)
- 4 legacy-path tests (deprecation warning fires, dedups, respects suppression)
- 8 error-path tests (all four new errors)
- All existing alpha.25 tests continue to pass unchanged

**881 total tests pass across the workspace (was 864 at alpha.25; +17; zero regressions).**

## Adapter status

| Adapter | messages input | Multi-turn |
|---|---|---|
| `adapter-openai` | ✅ | ✅ Full |
| `adapter-anthropic` | ⚠ | ⚠ Single-turn only (patch release upcoming) |
| `adapter-google` | ⚠ | ⚠ Single-turn only (patch release upcoming) |
| `adapter-ollama` | ⚠ | ⚠ Single-turn only (patch release upcoming) |
| `adapter-vercel` | ⚠ | ⚠ Single-turn only (patch release upcoming) |

Consumers using multi-turn `messages` today should route through `adapter-openai`. Other adapters accept `messages` shape (Registry-normalized) but internally use the last user message; full multi-turn support follows in patch releases per adapter.

## Alternatives considered and rejected

- Parallel field with XOR semantics (two-ways-to-do-one-thing). Rejected.
- New `chat` method (grows port surface). Rejected.
- Rename `prompt` to `input` with union type (runtime discrimination churn). Rejected.
- Extend `MessageContent` to include `LLMMessage[]` (conflates content vs sequence). Rejected.
- Defer to beta.0. Considered; rejected. Beta.0 is the stability signal — if we're breaking, we should break in alpha.
- Do nothing. Rejected. The abstraction fails its job if it refuses to model a use case the protocol supports natively.

---

[Full release notes](https://github.com/baabakk/llm-ports/releases/tag/v0.1.0-alpha.26) | [alpha.25 → alpha.26 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-25-to-alpha-26.md) | [alpha.26 planning discussion](https://github.com/baabakk/llm-ports/discussions/62)
