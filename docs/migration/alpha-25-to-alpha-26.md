# Migrating from alpha.25 to alpha.26

> **⚠️ BREAKING (upcoming in alpha.27).** The `instructions` and `prompt` fields are **deprecated in alpha.26** and will be **removed in alpha.27** (~2 weeks after alpha.26 ships). This release adds the canonical `messages: LLMMessage[]` input alongside the deprecated fields; deprecation warnings emit when the legacy shape is used.
>
> A one-line migration shim (`toMessages`) makes the mechanical upgrade take ~30 minutes for a 20-call-site consumer.

## Install

```bash
pnpm add @llm-ports/core@alpha @llm-ports/adapter-openai@alpha
```

All 7 publishable packages bumped to `0.1.0-alpha.26`.

## The headline

Every provider (OpenAI, Anthropic, Google, DeepInfra, Cerebras, Groq, SambaNova, everyone) speaks `messages: Message[]` natively. The port's `{ instructions, prompt }` shape was a compression for the single-turn case that doesn't model multi-turn workloads (chat, interview agents, coaching workflows).

Alpha.26 unifies:

- **New:** `messages: LLMMessage[]` on all four generation methods (`generateText`, `generateStructured`, `streamText`, `streamStructured`).
- **Deprecated:** `instructions?: string` + `prompt?: MessageContent` on the same four methods.
- **Migration shim:** `toMessages(instructions, prompt)` returns the equivalent messages array.
- **Convenience helpers:** `sys(content: string)` and `usr(content: MessageContent)`.
- **New errors:** `MessagesRequiredError`, `EmptyMessagesError`, `MessagesConflictError`, `PromptRequiredError`.
- **Deprecation-warning UX:** fingerprint-deduplicated `console.warn` per method per Registry, opt-out via `suppressDeprecationWarnings: true`, structured logging via `deprecationWarningHandler`.

**`runAgent` is unchanged** — it already took `messages`. Zero migration impact if you only use `runAgent`.

## Migration paths

### Path 1: Mechanical (one-line change per site, ~30 minutes for 20 sites)

Replace `{ instructions, prompt }` with `{ messages: toMessages(instructions, prompt) }`:

```ts
// Before (alpha.25)
port.generateText({
  taskType: "triage",
  instructions: SYSTEM_PROMPT,
  prompt: userInput,
});

// After (alpha.26 mechanical, via shim)
import { toMessages } from "@llm-ports/core";

port.generateText({
  taskType: "triage",
  messages: toMessages(SYSTEM_PROMPT, userInput),
});
```

Same wire format, same behavior. This is the recommended first step — get the deprecation warnings out of your logs quickly, migrate to idiomatic on your own schedule.

### Path 2: Idiomatic (uses `sys` / `usr` helpers)

Cleaner code, slightly more verbose than the shim:

```ts
import { sys, usr } from "@llm-ports/core";

port.generateText({
  taskType: "triage",
  messages: [sys(SYSTEM_PROMPT), usr(userInput)],
});
```

`sys()` returns `{ role: "system", content: string }`. `usr()` returns `{ role: "user", content: MessageContent }` — accepts either a plain string or a `MessageContent` array for multimodal.

### Path 3: Native multi-turn (previously unavailable)

The whole point of the unification — real multi-turn workloads with full conversation state:

```ts
port.generateStructured({
  taskType: "interview-turn",
  schema: InterviewTurnSchema,
  messages: [
    sys(INTERVIEWER_SYSTEM_PROMPT),
    usr(student.firstAnswer),
    { role: "assistant", content: interviewer.firstFollowup },
    usr(student.secondAnswer),
    { role: "assistant", content: interviewer.secondFollowup },
    usr(student.thirdAnswer),
    // Model produces the next assistant turn
  ],
});
```

In alpha.25 this required rolling history into a string (loses role fidelity) or abusing `runAgent` with an empty tools object. Now it's a first-class shape.

## What the Registry does under the hood

The `RegistryPort` normalizes both shapes before dispatch:

```
opts.messages is set?
├─ yes: was legacy also set?
│  ├─ yes → throw MessagesConflictError (ambiguity is a caller bug)
│  ├─ no  → messages length 0?
│  │       ├─ yes → throw EmptyMessagesError
│  │       └─ no  → dispatch with opts.messages
│  
└─ no: opts.prompt is set?
   ├─ yes → emit deprecation warning (deduped);
   │        synthesize messages = toMessages(opts.instructions, opts.prompt);
   │        dispatch with synthesized messages
   └─ no  → throw MessagesRequiredError
```

The adapter always sees `options.messages` after normalization — even when the caller used the legacy shape.

## Deprecation warning UX

**Format:** single-line `console.warn` per method per Registry:

```
[llm-ports] DEPRECATED: 'instructions'/'prompt' fields on generateText will be removed in alpha.27. Use 'messages: LLMMessage[]' instead. See https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-25-to-alpha-26.md.
```

**Dedup:** one warning per unique method per Registry instance. A consumer with 50 legacy call sites across all four methods gets 4 warnings total (one per method) — enough signal to trigger a migration audit without flooding logs.

**Suppression** (mid-migration opt-out):

```ts
const registry = createRegistryFromEnv({
  // ...existing options...
  suppressDeprecationWarnings: true, // alpha.26+; removed in alpha.27
});
```

**Structured logging** (route warnings through your logger instead of `console.warn`):

```ts
const registry = createRegistryFromEnv({
  // ...existing options...
  deprecationWarningHandler: (msg) => {
    logger.warn({ deprecation: true, msg });
  },
});
```

Both options ship in alpha.26 and are removed in alpha.27 alongside the legacy fields.

## Error paths

Four new errors are exported from `@llm-ports/core`:

| Error | Thrown when |
|---|---|
| `MessagesRequiredError` | Neither `messages` nor `prompt` supplied on a call |
| `EmptyMessagesError` | `messages` supplied but the array is empty |
| `MessagesConflictError` | Both `messages` AND legacy `{ instructions, prompt }` supplied |
| `PromptRequiredError` | `toMessages()` called with no prompt |

All extend `LLMPortError` so blanket `catch (e instanceof LLMPortError)` handling continues to work.

## Adapter behavior

`adapter-openai` reads `options.messages` directly when set (the Registry-normalized path). For the rare case of a direct-adapter call bypassing the Registry, the adapter falls back to `{ instructions, prompt }`. Both shapes produce identical wire format for single-turn calls.

**System-role message handling:** the adapter extracts leading contiguous system-role messages from `messages`, concatenates them (with `\n\n` separator), and treats the concatenation as `instructions` for the underlying provider. Non-contiguous system messages (system in the middle of a conversation) pass through inline; OpenAI natively supports them as boundary markers.

**Multi-system-role messages:** contiguous system messages at the start are concatenated. Non-contiguous system messages pass through. If you need per-provider policy for these (Anthropic + Google split system into a top-level field and don't accept mid-conversation system messages), the adapters may throw provider-native errors in alpha.26; a follow-up patch release will normalize this cross-adapter.

**Cache control:** `cacheControl` on the call options continues to work unchanged. Anthropic's block-level `cache_control` markers on `TextBlock`s inside a `messages` array's `content` field are respected verbatim.

## Multi-turn use cases now natively supported

- **Chat UIs** — full conversation history passed each turn.
- **Interview / coaching workflows** — rolling state where prior turns matter.
- **Iterative refinement** — feedback loops with the user in the middle.
- **Roleplay / persona-based generation** — arbitrary conversation state.
- **Any workflow that maintains chat state** — no more `providerExtras` workarounds.

## Timeline

| Milestone | Target |
|---|---|
| alpha.26 ships | 2026-07-02 (this release) |
| Migration window | 2026-07-02 to 2026-07-16 |
| alpha.27 ships (removes deprecated fields) | 2026-07-16 |

Alpha.27 is the removal release. Consumers who haven't migrated by then hit TypeScript compilation errors on upgrade. Deprecation warnings during the alpha.26 window make the migration surface visible in advance.

## Package versions

All 7 publishable packages bumped in lockstep:

- `@llm-ports/core@0.1.0-alpha.26`
- `@llm-ports/adapter-openai@0.1.0-alpha.26`
- `@llm-ports/adapter-anthropic@0.1.0-alpha.26`
- `@llm-ports/adapter-google@0.1.0-alpha.26`
- `@llm-ports/adapter-ollama@0.1.0-alpha.26`
- `@llm-ports/adapter-vercel@0.1.0-alpha.26`
- `@llm-ports/capabilities@0.1.0-alpha.26`

Test coverage: **881 total** (was 864 at alpha.25; +17 new for alpha.26 messages input; **zero regressions**).

## Alternatives considered and rejected

- **Parallel field with XOR semantics** (add `messages` alongside `prompt`, exactly one must be set forever). Rejected: two-ways-to-do-one-thing is a maintenance surface that never converges. The one-cycle deprecation window is the price of unifying.
- **New `chat` method** (`chat(opts: ChatOptions)`). Rejected: grows the port from 5 methods to 7 for a semantic distinction that doesn't exist (chat and generateText produce identical output; only the input shape differs).
- **Rename `prompt` to `input` with union type** (`input: MessageContent | LLMMessage[]`). Rejected: runtime discrimination churn without clarity gain.
- **Extend `MessageContent` to include `LLMMessage[]`.** Rejected: collapses "content of a turn" and "sequence of turns" into one type.
- **Defer to beta.0.** Considered seriously; rejected. Beta.0 is the stability signal — if we're breaking, we should break in alpha.
- **Do nothing.** Rejected. The abstraction fails its job if it refuses to model a use case the protocol supports natively.

## FAQ

**Q: I can't upgrade all my code in one PR — can I migrate incrementally?**

Yes. `suppressDeprecationWarnings: true` on the Registry silences warnings during your migration window. Land the migration in whatever cadence works; TypeScript compilation is your enforcement at alpha.27.

**Q: What if I want per-turn refs in a multi-turn conversation?**

Refs are per-call in alpha.26 — they apply to the whole call, not individual messages. If you want per-turn refs (unusual), split into multiple calls or embed the ref in your own message metadata outside `refs`.

**Q: Can I still pass `instructions` alone with the new `messages` shape?**

No — either use `messages` alone (put the system content as `[sys(instructions), ...]`) or use the deprecated `{ instructions, prompt }` shape. Mixing throws `MessagesConflictError`.

**Q: Does my adapter need to be updated for alpha.26?**

If you're a consumer of `@llm-ports/adapter-openai` (or any of the bundled adapters), no. The alpha.26 ship updates all bundled adapters to read from `options.messages`. If you maintain a custom third-party adapter, update it to prefer `options.messages` when set; the Registry always passes it now.

**Q: Do I need to update my capability-factory calls (`createExtractor`, `createClassifier`, etc.)?**

No. The capability factories in `@llm-ports/capabilities` continue to accept the same task-specific inputs (`{ input: string }`, etc.). Their internal port calls have been updated to construct `messages` under the hood. Zero migration impact for capability-factory consumers.

**Q: Where does `runAgent` fit?**

`runAgent` already took `messages` and is unchanged. Alpha.26 aligns the other four methods with what `runAgent` already had.

## Full test coverage summary

- 10 helper + shim tests (toMessages, sys, usr, error paths)
- 5 canonical messages-flow tests (Registry → adapter passing verbatim)
- 4 legacy-path tests (deprecation warning fires, dedups, respects suppression)
- 8 error-path tests (all four new errors)
- All existing alpha.25 tests continue to pass unchanged

**881 total tests pass across the workspace (was 864 at alpha.25; +17; zero regressions).**
