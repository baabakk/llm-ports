# ⚠️ Coming in alpha.26: BREAKING API unification (canonical `messages` input)

**TL;DR** — The next release of `@llm-ports` will break the shape of four methods to align with every provider's native protocol. A one-cycle deprecation window is planned. Migration is ~30 minutes mechanical or ~4 hours idiomatic per consumer. If you're using `@llm-ports` in production, please weigh in on the open design questions below **before** implementation begins.

## What's changing

The current port has TWO input shapes for what is architecturally the same thing:

- `generateText` / `generateStructured` / `streamText` / `streamStructured` accept `{ instructions?: string, prompt: MessageContent }`.
- `runAgent` accepts `{ messages: LLMMessage[] }`.

Every provider's actual API (OpenAI, Anthropic, Google, DeepInfra, Cerebras, Groq, SambaNova, everyone) speaks `messages: Message[]`. The two-shape design was a defensible compression when most calls were single-turn, but it doesn't model the multi-turn use case any richer than "chat interview" workload needs. Alpha.26 unifies:

**All five port methods will accept `messages: LLMMessage[]` as the canonical input.**

## Why this is worth breaking

Three real production workloads have been blocked or forced onto a bad workaround:

1. **Multi-turn interview agents** (SalesCoach, Voxr). Consumer maintains rolling conversation state. Currently forced to either roll history into a `prompt` string (loses role fidelity, breaks provider-native caching), abuse `runAgent` with `tools: {}` (semantically broken; loop terminates on first assistant turn), or reach past the port via `providerExtras` (kills the abstraction).
2. **Chat UIs** (three consumers). Same problem shape.
3. **Iterative refinement / coaching workflows** where prior turns matter. Same shape.

The abstraction should model what the underlying protocol supports natively.

## What alpha.26 will ship

```ts
// New canonical shape:
interface CommonCallOptions {
  taskType: TaskType;
  messages: LLMMessage[];  // NEW canonical field
  // ...existing options unchanged (temperature, refs, budgetScope, cacheControl, etc.)
}

interface GenerateTextOptions extends CommonCallOptions {}
interface GenerateStructuredOptions<T> extends CommonCallOptions {
  schema: z.ZodType<T>;
  schemaName?: string;
  strict?: boolean;
}
interface StreamTextOptions extends CommonCallOptions {}
interface StreamStructuredOptions<T> extends CommonCallOptions {
  schema: z.ZodType<T>;
  schemaName?: string;
  strict?: boolean;
}
interface RunAgentOptions extends CommonCallOptions {
  tools: Record<string, ToolDefinition>;
  maxSteps?: number;
  onStep?: (step: AgentStep) => void;
}
```

Plus three helpers:

```ts
import { toMessages, sys, usr } from "@llm-ports/core";

// Migration shim (one-line change per call site):
toMessages(instructions?: string, prompt: MessageContent): LLMMessage[];

// Idiomatic construction helpers:
sys(content: string): LLMMessage;   // system message
usr(content: MessageContent): LLMMessage;  // user message
```

## Migration path

**During the alpha.26 window (~2 weeks):**

```ts
// alpha.25 (current)
port.generateText({
  taskType: "triage",
  instructions: SYSTEM_PROMPT,
  prompt: userInput,
});

// alpha.26 mechanical — one-line change per call site
port.generateText({
  taskType: "triage",
  messages: toMessages(SYSTEM_PROMPT, userInput),
});

// alpha.26 idiomatic — via sys() + usr() helpers
port.generateText({
  taskType: "triage",
  messages: [sys(SYSTEM_PROMPT), usr(userInput)],
});

// alpha.26 native multi-turn — previously unavailable
port.generateStructured({
  taskType: "interview-turn",
  schema: InterviewTurnSchema,
  messages: conversationHistory,
});
```

Consumers with 20 call sites: ~30 minutes for the mechanical migration via `toMessages()`, ~4 hours to idiomatic native `messages` arrays.

**At alpha.27 (~2 weeks after alpha.26):**

The deprecated `instructions` / `prompt` fields are removed. TypeScript compilation fails for consumers that haven't migrated. Deprecation warnings during the alpha.26 window make this visible in advance.

## Deprecation UX

- Warnings emit via `console.warn` by default.
- Fingerprint dedup: at most ONE warning per unique (adapter, method, call-site) triple per Registry instance. A consumer with 20 call sites gets at most 20 warnings, not 20-per-call.
- Structured single-line format for grep / filter.
- Opt-out during migration: `RegistryOptions.suppressDeprecationWarnings: true`.

## Open design questions (please weigh in)

1. **`instructions` + `messages` conflict handling.** During the alpha.26 window, if a consumer passes BOTH the legacy `instructions` string AND a `messages` array containing a system-role message, what happens? Recommendation: throw `MessagesConflictError`. Ambiguity is a caller bug worth surfacing. **Comment if you'd prefer silent precedence rules.**

2. **`sys()` accepting `MessageContent` (not just `string`).** Recommendation: keep `sys()` restricted to `string` for the common case. Callers with the rare multimodal-system-prompt case use the object-literal `{role: "system", content: [...]}`. **Comment if you have a real use case for multimodal system prompts.**

3. **Assistant-turn construction sugar.** Recommendation: no `asst()` helper — assistant turns typically come from captured LLM outputs and object literal is fine. **Comment if you construct assistant turns from strings frequently.**

4. **`refs` and multi-turn.** Recommendation: refs are per-call, not per-turn. If consumer passes refs on turn N of an interview, only turn N's observability events carry them. **Comment if you want per-turn refs propagation.**

5. **Adapter behavior on multi-system-role or mid-conversation-system messages.** Anthropic + Google split system out of the messages array; OpenAI keeps it inline. If a consumer supplies multiple system messages OR a mid-conversation system message, adapters need a policy. Recommendation: concatenate contiguous system messages at the start; throw on mid-conversation system for Anthropic + Google, pass through for OpenAI. **Comment if you have a use case for mid-conversation system messages.**

6. **Automated codemod.** Nice to have — a `jscodeshift` transform that rewrites `{instructions, prompt}` to `{messages: toMessages(...)}` mechanically. 20 sites is 30 minutes by hand. **Comment if you'd use one.**

## Timeline (planned)

| Milestone | Target |
|---|---|
| alpha.25 ships | 2026-07-02 (current release) |
| alpha.26 planning + review | 2026-07-03 to 2026-07-15 |
| alpha.26 implementation | 2026-07-16 to 2026-07-22 |
| alpha.26 release | 2026-07-23 |
| alpha.26 migration window | 2026-07-23 to 2026-08-06 |
| alpha.27 release (removal) | 2026-08-10 |

**Slippage tolerance:** the alpha.26 timeline can slip freely without impacting alpha.25 or existing consumers. The migration window between alpha.26 and alpha.27 can extend to 3-4 weeks if consumer feedback indicates additional runway is needed.

## What is NOT changing

- `runAgent` already takes `messages`. Zero migration impact on runAgent consumers.
- All other options (temperature, refs, budgetScope, cacheControl, providerExtras, signal, forceProviderAlias, reasoningEffort, strict) carry over unchanged.
- All error taxonomy, observability hooks, budget gating, per-attempt timeout, task routing, fallback chain semantics: unchanged.
- The `MessageContent` type (per-turn content: `string | ContentBlock[]`) is unchanged. Multimodal content per turn still works exactly the same way.

## Alternatives considered and rejected

- **Parallel field with XOR semantics** (add `messages` alongside `prompt`, exactly one must be set). Rejected: two-ways-to-do-one-thing is a maintenance surface that never converges.
- **New `chat` method** (`chat(opts: ChatOptions)`). Rejected: grows the port from 5 methods to 7 for a semantic distinction that doesn't exist.
- **Rename `prompt` to `input` with union type** (`input: MessageContent | LLMMessage[]`). Rejected: runtime discrimination churn without clarity gain.
- **Extend `MessageContent` to include `LLMMessage[]`.** Rejected: collapses "content of a turn" and "sequence of turns" into one type.
- **Defer to beta.0.** Considered seriously; rejected as the primary path. Beta.0 is the stability signal — if we're breaking, we should break in alpha. If review surfaces unresolved design questions, this stays as the fallback.
- **Do nothing.** Rejected. The abstraction fails its job if it refuses to model a use case the protocol supports natively.

## How to give feedback

- Reply on this discussion with the number of the design question and your position.
- If your consumer would be materially affected in a way not captured above, comment with your workload shape and expected migration cost.
- If you want a delay past 2026-07-23, comment with the timeline that would work — the goal is a clean release for everyone, not a hard deadline.

Once open questions are settled, the design freezes and implementation begins on a `feature/alpha-26-messages-canonical` branch.

Thanks for reading — feedback in the next two weeks is when it has the most leverage.
