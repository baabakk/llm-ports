# Migrating from alpha.26 to alpha.27

> **⚠️ BREAKING (removal).** The `instructions?` and `prompt?` fields are removed from the four generation methods. Consumers who migrated during the alpha.26 window have nothing to do. Consumers who did not: your build fails; follow the [alpha.25 → alpha.26 migration guide](./alpha-25-to-alpha-26.md) to migrate to `messages`, then bump to alpha.27.
>
> Two-cycle deprecation window closed: alpha.26 (2026-07-02) announced + deprecated → alpha.27 (2026-07-22) removes.

## Install

```bash
pnpm add @llm-ports/core@alpha @llm-ports/adapter-openai@alpha
```

Six publishable packages bumped to `0.1.0-alpha.27`. `@llm-ports/capabilities` stays at `0.1.0-alpha.26.1` (unchanged; the internal migration to `messages` shipped in the alpha.26.1 hotfix).

## What actually changed

**In one sentence:** the four generation methods (`generateText`, `generateStructured`, `streamText`, `streamStructured`) now type `messages: LLMMessage[]` as required and no longer type `instructions` or `prompt`. The Registry-side dual-population code that made both shapes work in alpha.26 is deleted. Adapter-openai + the four other legacy adapters (Ollama, Vercel, Anthropic, Google) now all consume `options.messages` natively rather than reading a Registry-synthesized legacy shape.

**In slightly more detail:**

- `GenerateTextOptions.instructions?: string` — REMOVED.
- `GenerateTextOptions.prompt?: MessageContent` — REMOVED.
- `GenerateTextOptions.messages: LLMMessage[]` — was optional (`messages?:`), now required.
- Same three changes on `GenerateStructuredOptions`, `StreamTextOptions`, `StreamStructuredOptions`.
- `RunAgentOptions` — UNCHANGED. `runAgent`'s `instructions: string` was always a distinct required field; it's not the deprecated one and stays.

## Migration

You've already migrated during the alpha.26 window? Nothing to do. Just bump the versions.

You didn't migrate? TypeScript now rejects your code with:

```
error TS2353: Object literal may only specify known properties, and 'prompt' does not exist in type 'GenerateTextOptions'.
```

Follow the [alpha.25 → alpha.26 migration guide](./alpha-25-to-alpha-26.md) for the migration paths. Summary:

**Mechanical (~1 minute per call site):**

```ts
import { toMessages } from "@llm-ports/core";

// Before (alpha.25/alpha.26 with warnings)
port.generateText({
  taskType: "triage",
  instructions: SYSTEM_PROMPT,
  prompt: userInput,
});

// After (alpha.27)
port.generateText({
  taskType: "triage",
  messages: toMessages(SYSTEM_PROMPT, userInput),
});
```

**Idiomatic (recommended for new code):**

```ts
import { sys, usr } from "@llm-ports/core";

port.generateText({
  taskType: "triage",
  messages: [sys(SYSTEM_PROMPT), usr(userInput)],
});
```

**Native multi-turn (previously unavailable):**

```ts
port.generateStructured({
  taskType: "interview-turn",
  schema: InterviewTurnSchema,
  messages: conversationHistory,  // full context; roles preserved
});
```

## What else changed

### Public helper rename

`warnDeprecatedLegacyInput(state, method)` renamed to `warnDeprecated(state, details)`. The new signature is generalized: it accepts a `DeprecationDetails` object (`{ what, where, removalVersion?, migrationUrl? }`) instead of just a method name, so future deprecation cycles reuse the same primitive without rebuilding.

```ts
// Before (alpha.26; internal-ish)
import { warnDeprecatedLegacyInput } from "@llm-ports/core";
warnDeprecatedLegacyInput(state, "generateText");

// After (alpha.27)
import { warnDeprecated } from "@llm-ports/core";
warnDeprecated(state, {
  what: "'onMissing' as a function callback",
  where: "createVersionedStore",
  removalVersion: "alpha.35",
  migrationUrl: "https://.../migration/alpha-34-to-alpha-35.md",
});
```

The `WarningState`, `createWarningState`, `suppressDeprecationWarnings` (on `RegistryOptions`), and `deprecationWarningHandler` (on `RegistryOptions`) all stay unchanged. Method-only dedup, structured-log routing, opt-out — all preserved.

If you imported `warnDeprecatedLegacyInput` (rare; the export was primarily internal), rename the import and pass a `DeprecationDetails` object. The runtime behavior is identical.

### `NonContiguousSystemError` (new error class)

Adapter-anthropic and adapter-google now throw `NonContiguousSystemError` when a system-role message appears after a user-role or assistant-role message in the `messages` array. Both providers structurally reject non-leading system messages (`system` / `systemInstruction` are top-level request fields in their SDKs); the adapter fails loudly at the boundary rather than silent flattening.

```ts
import { NonContiguousSystemError } from "@llm-ports/core";

try {
  await port.generateText({
    taskType: "chat",
    messages: [
      sys("You are helpful."),
      usr("Question 1"),
      { role: "assistant", content: "Answer 1" },
      sys("Actually be terse."),  // ← alpha.27+ throws on Anthropic + Google
      usr("Question 2"),
    ],
  });
} catch (err) {
  if (err instanceof NonContiguousSystemError) {
    // err.method, err.messageIndex, err.alias available
  }
}
```

Adapters that tolerate mid-conversation system messages (Ollama, Vercel, OpenAI) pass them through inline and never throw this error.

### Adapter cleanup (backwards-compat)

All four legacy adapters now consume `options.messages` natively. The Registry no longer synthesizes legacy `{instructions, prompt}` fields for them. Every adapter's per-message translation matches its provider's native API:

- **OpenAI** — leading system messages fold into a top-level system slot when the model rejects the standard shape (existing capability-learning); mid-conversation system messages pass through inline.
- **Ollama** — pure pass-through; Ollama accepts mid-conversation system messages natively.
- **Vercel** — leading contiguous system messages concatenate into the SDK's top-level `system` field; per-message multimodal handling preserved.
- **Anthropic** — leading contiguous system messages concatenate into the top-level `system` field; non-leading throws `NonContiguousSystemError`.
- **Google** — leading contiguous system messages concatenate into `systemInstruction`; non-leading throws `NonContiguousSystemError`.

Multi-turn workloads with non-leading system messages that used to work on OpenAI via the alpha.26 dual-population shim will now throw on Anthropic + Google. If you need those providers, restructure to put system content only at the start.

## Timeline

| Milestone | Ship date |
|---|---|
| alpha.26 (deprecation announced) | 2026-07-02 |
| alpha.26.1 (capabilities internal migration hotfix) | 2026-07-03 |
| alpha.27 (fields removed) | 2026-07-22 |

Two-cycle window opened 2026-07-02 and closed 2026-07-16 with a one-week extension bringing us here. See [alpha.26 planning discussion #62](https://github.com/baabakk/llm-ports/discussions/62) and [alpha.26 release discussion #63](https://github.com/baabakk/llm-ports/discussions/63) for the full audit trail.

## What's next

**Alpha.28 "Reliability + observability polish"** ships next (target 2026-08-05). Sixteen items synthesized from findings by four consumers (ADW, SalesCoach, BEPA, Dramma). Highest-leverage item: per-attempt deadline that automatically triggers failover through `AttemptTimeoutError extends ProviderUnavailableError`. See [alpha.28 planning discussion #64](https://github.com/baabakk/llm-ports/discussions/64) for the full slate.

Two more themed releases queued after alpha.28:

- **Alpha.29 "Capability factory ergonomics"** (target 2026-08-19) — [Planning #65](https://github.com/baabakk/llm-ports/discussions/65).
- **Alpha.30 "Persistent backends + caching"** (target 2026-09-02) — [Planning #66](https://github.com/baabakk/llm-ports/discussions/66).
- **Alpha.31 "Local runtime + orchestration"** (target 2026-09-15 → 09-29) — [Planning #67](https://github.com/baabakk/llm-ports/discussions/67).

## FAQ

**Q: I'm on alpha.20.1 (skipped alpha.21-26). How do I get to alpha.27?**

Skip straight to alpha.27; the alpha.26 window is closed and there's no point stepping through it. Bump the version and follow the migration guide's Mechanical path via `toMessages(instructions, prompt)`. TypeScript's error messages will show you every call site to update.

**Q: Are there any runtime behavior changes for canonical `messages` callers?**

Two:

1. **Anthropic + Google** now throw `NonContiguousSystemError` on non-leading system messages. Previous alpha.26 shims silently flattened them; if you relied on that flatten behavior, restructure your prompts.
2. **Deprecation warnings are gone.** No more `[llm-ports] DEPRECATED: ...` in your logs, because the legacy path is unreachable.

**Q: Can I still catch `MessagesConflictError`?**

The class is exported for backwards compat with any handlers you already wrote, but it's unreachable in alpha.27 (there are no legacy fields to conflict with). Safe to remove.

**Q: My `warnDeprecatedLegacyInput` import broke.**

Renamed to `warnDeprecated`; new signature takes a `DeprecationDetails` object. See §"Public helper rename" above.

**Q: I have a custom adapter (not one of the bundled five). What do I need to change?**

If your adapter reads `options.messages` — nothing. If your adapter reads `options.prompt` or `options.instructions` — those fields no longer exist on the option types; you need to migrate the adapter to consume `options.messages` (see `adapter-openai`'s `resolveMessagesFromCallOptions` for the pattern).

## Package versions

| Package | Version |
|---|---|
| `@llm-ports/core` | `0.1.0-alpha.27` |
| `@llm-ports/adapter-openai` | `0.1.0-alpha.27` |
| `@llm-ports/adapter-anthropic` | `0.1.0-alpha.27` |
| `@llm-ports/adapter-google` | `0.1.0-alpha.27` |
| `@llm-ports/adapter-ollama` | `0.1.0-alpha.27` |
| `@llm-ports/adapter-vercel` | `0.1.0-alpha.27` |
| `@llm-ports/capabilities` | `0.1.0-alpha.26.1` (unchanged; migrated internally in the alpha.26.1 hotfix) |

886 tests pass across the workspace. Zero regressions.
