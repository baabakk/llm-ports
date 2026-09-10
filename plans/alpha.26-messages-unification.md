> **Recovered 2026-09-10.** This document survived only in a temporary folder
> (`E:/tmp`) and existed nowhere in the repository, even though the release it
> plans shipped on 2026-07-02 and `plans/` is meant to hold one document per
> release. It is filed here unedited below this banner.
>
> **The release shipped.** The status line below reads "awaiting design-freeze
> approval" because that was true when the document was last saved; the release
> journal records alpha.26 as "API unification on canonical `messages` input,
> alongside the deprecated fields", with the legacy `{instructions, prompt}`
> fields removed in alpha.27 as this plan's deprecation schedule intended.
>
> Left as it was rather than updated in place, because a plan is a record of
> what was intended at the time and rewriting it to match the outcome destroys
> the only evidence of the gap between the two.

# @llm-ports alpha.26 — Messages Unification Plan

**Status:** Draft v3.2 (supersedes v3.1) — awaiting design-freeze approval, then implementation.
**Author:** Babak
**Created:** 2026-07-02T02:53:31 -07:00
**Revised:** 2026-07-02T03:15:00 -07:00 — v2.0 addresses external critique of v1.0
**Revised:** 2026-07-02T03:40:00 -07:00 — v3.0 addresses second-pass sharpening review of v2.0
**Revised:** 2026-07-02T04:05:00 -07:00 — v3.1 addresses third-pass patch review of v3.0 (8 blocking edits)
**Revised:** 2026-07-02T04:20:00 -07:00 — v3.2 ratifies Option C for SalesCoach coordination (§9.6); removes alpha.26-rc.0 milestone from §14
**Ship target:** `@llm-ports` alpha.26 (breaking, with one-cycle deprecation shim); removal in alpha.27
**Related issues (open):** #53 (refs), #54 (aggressive fallback), #55 (streamed cost), #56 (timeout hygiene), #57 (validation-repair docs), #58 (two-tree migration guide), #59 (circuit breaker), #60 (alias baseURL)
**Precedents for the deprecation discipline:** alpha.22 harmony extraction (announce, deprecate, remove), alpha.24 catalog freeze policy (three-tier + fingerprint takes precedence over legacy)

---

## §0 Changelog

- **v3.2 (2026-07-02T04:20:00 -07:00)** — Ratified SalesCoach coordination as **Option C** (§9.6): SalesCoach Plan 30 ships 20 sites on `{instructions, prompt}` shape against alpha.24; during the alpha.26 → alpha.27 window (3 weeks) SalesCoach re-migrates to `messages`. Coordination cost absorbed by SalesCoach; ~half a day of mechanical work. Option B (alpha.26-rc branch) not pursued; Plan 30 continues unchanged against alpha.24. §14 timeline drops the "Alpha.26-rc.0 published" milestone. §13 DoD item 22 rewritten accordingly. Also: plan file stays local (`e:/tmp/`); GitHub gets a brief issue (not the full plan) that points to the local design.
- **v3.1 (2026-07-02T04:05:00 -07:00)** — Third-pass patch review addressed. Eight blocking edits: (a) Type-shape backward-compat fix — `messages?: LLMMessage[]` (OPTIONAL) in alpha.26 across all five methods; alpha.27 makes it required. Prior v3.0 said "required" which would fail-compile every alpha.25 call. (b) Normalizer now calls `validateMessagesShape()` at every return path to enforce strict system-role rules from §4.4; prior v3.0 draft in Appendix B checked conflict but not multi-system/mid-conversation-system. (c) `sys()` signature fixed in Appendix B: `MessageContent`, not `string` (v3.0 §5.2 said broaden but Appendix B still showed string). (d) Structured-output fallback rule S1 rewritten: merge schema instruction into last user message if the array already ends with a user turn; append new user turn only if last is assistant or tool. Prior rule would violate Google's user/model alternation contract. (e) Deprecation-warning default resolved: `"console"` everywhere (no browser heuristic); direct-adapter consumers get a per-adapter constructor option so they can silence too. (f) Cache-control precedence warning removed — it was a warning about precedence, not a deprecation event, and reusing `DeprecationEvent` would have polluted the taxonomy. Behavior documented and tested; no runtime warning. (g) Alpha.25 dependency loosened — alpha.26 rebases against whatever alpha.25 actually shipped; unshipped fields (refs, aggressive fallback, streamed cost) get omitted from examples rather than blocking the release. (h) Document footer fixed to "End of plan v3.2."
- **v3.0 (2026-07-02T03:40:00 -07:00)** — Second-pass sharpening review. Additions: (a) System-role message rules made strict — throw `NonContiguousSystemError` on multi-system or mid-conversation-system arrays; adapters get zero-or-one leading system message only. This resolves the cross-provider silent-drift risk (OpenAI treats mid-conv system as boundary marker; Anthropic + Google collapse). (b) `sys()` broadened to accept `MessageContent` (reversal of v2.0's §11.5) so callers can attach block-level `cache_control`; Anthropic prompt-caching regression prevented. (c) `@llm-ports/capabilities` package added to migration scope; all 7 factory files (draft, summarize, classify, extract, score, plan, analyze) internally reference `instructions`/`prompt` and need migration. (d) Deprecation-warning dedup-key granularity made explicit: one warning per `(tag, method, adapter)` tuple per Registry lifetime. (e) SalesCoach coordination explicit as new §9.6: **Option B (alpha.26-rc branch; Plan 30 Phase 4.0 migrates directly to `messages`, skipping the intermediate shape)** recommended and gated. (f) Alpha.25 dependency (refs) made explicit and non-conditional in §1.1; alpha.26 depends on alpha.25 landing #53/#54/#55; if #53 slips, alpha.25 slips, alpha.26 slips. (g) §4.7 extended for tool_use content blocks in assistant messages passed to non-agentic calls (per-adapter behavior documented). (h) Effort estimate +0.5 day for capabilities package migration (10 → 10.5 engineer-days).
- **v2.0 (2026-07-02T03:15:00 -07:00)** — Rewrite after external critique of v1.0. Corrections: (a) `runAgent` DOES need migration; it has `instructions: string` REQUIRED alongside `messages: LLMMessage[]`; unification must include it. (b) Adapters access `options.prompt` and `options.instructions` directly today; Registry-layer-only normalization is insufficient, need a shared normalizer used by both Registry and adapters. (c) Adapter list corrected to openai/anthropic/google/ollama/vercel (no deepinfra as separate package). (d) `generateStructured` multi-turn schema-instruction placement now explicitly specified. (e) Existing silent-precedence inconsistency documented: Anthropic prefers `system-in-messages`; Google prefers `options.instructions`; must resolve. (f) New errors extend `LLMPortError`. (g) Deprecation-warning UX simplified: `"console" | "silent" | (fn)`, no stack fingerprinting. (h) Timeline revised 5 → 8-12 engineer-days. (i) Contract-tests package treated as separate implementation surface. (j) OpenAI `developer` role added as open question. All eight code-level claims in the critique verified against the actual repo before acceptance.
- v1.0 (2026-07-02T02:53:31 -07:00) initial draft.

---

## §1 Executive summary

### §1.1 Alpha.25 dependency (loose, rebase-friendly)

Alpha.26 is expected to branch after alpha.25. If any of #53 (refs), #54 (aggressive fallback), or #55 (streamed cost) slip, alpha.26 rebases against the actual shipped alpha.25 surface and omits the unshipped fields from examples. Alpha.26 does not try to also ship them.

Rationale: message unification does not logically require aggressive fallback or streamed cost. It touches `refs?: Record<string, ArtifactRef>` only as a passthrough field in the type example; if #53 slips, the example is edited and the release still ships. Coupling alpha.26 to an alpha.25 feature slippage would create avoidable schedule risk with no correctness benefit.

Docs sweeps #56, #57, #58 are non-blocking and can land in alpha.25.x concurrently with alpha.26 core work.

### §1.2 Summary

The `LLMPort` interface today models chat completion with an inconsistent input shape across its five methods:

- Four methods (`generateText`, `generateStructured`, `streamText`, `streamStructured`) take `instructions?: string` (system prompt) plus `prompt: MessageContent` (single user turn).
- `runAgent` takes `instructions: string` (REQUIRED) AND `messages: LLMMessage[]` — two channels for the system prompt, in parallel, with silent precedence rules that DIFFER across adapters (Anthropic prefers `system-in-messages`, Google prefers `instructions`).

This forces multi-turn conversation callers into three bad workarounds and makes `runAgent`'s system-prompt semantics adapter-dependent. The unification aligns all five methods around one canonical field: `messages: LLMMessage[]`. `instructions` becomes optional and deprecated in alpha.26 across ALL methods including runAgent; both `instructions` and `prompt` are removed in alpha.27. A migration shim (`toMessages(instructions?, prompt)`) and two convenience helpers (`sys(content)`, `usr(content)`) ship in alpha.26 to make the transition one-line for existing consumers.

A shared normalizer (`normalizeCallMessages` in `packages/core/src/utils/`) is used at BOTH the Registry entry points AND inside each adapter's own methods, so direct-adapter consumers get the same behavior as Registry consumers. Conflict rules are explicit and throw:
- `messages` set AND `prompt` set → throw `MessagesConflictError`.
- `messages` contains a system-role turn AND separate `instructions` set → throw `MessagesConflictError`.
- Legacy `instructions + prompt` (alpha.26 only) normalizes to `[system?, user]`.

Migration cost per consumer: 30 minutes mechanical (shim), 4–6 hours idiomatic (native message arrays).

## §2 Motivation

### §2.1 The gap: what the port fails to model

The `LLMPort` interface (`packages/core/src/ports/llm-port.ts`) today:

```ts
interface GenerateTextOptions {
  taskType: TaskType;
  instructions?: string;
  prompt: MessageContent;
  // ...routing, temperature, refs, budget, etc.
}

interface GenerateStructuredOptions<T> { /* same, plus schema */ }
interface StreamTextOptions            { /* same */ }
interface StreamStructuredOptions<T>   { /* same, plus schema */ }

interface RunAgentOptions {              // ← llm-port.ts:388–414
  taskType: TaskType;
  priority?: LLMPriority;
  instructions: string;                  // ← REQUIRED
  messages: LLMMessage[];                // ← REQUIRED
  tools: Record<string, ToolDefinition>;
  maxSteps?: number;
  // ...
}
```

Two problems:

1. **Multi-turn is unavailable in the four non-agent methods.** No caller can pre-compose a `[system, user, assistant, user, assistant, user]` history and hand it to `generateText`. The interview-agent use case (SalesCoach Plan 30 site #12) is blocked.
2. **`runAgent` has two parallel system-prompt channels TODAY.** `instructions: string` is required. `messages: LLMMessage[]` can contain a system-role turn. Both cannot be reconciled cleanly, and adapters have silent, DIFFERING precedence rules today (verified below).

### §2.2 The existing silent-precedence bug in runAgent

Same `runAgent` call sent to different adapters produces different behavior. Verified by reading adapter source:

- **Anthropic** (`packages/adapter-anthropic/src/adapter.ts:559`):
  ```ts
  const { system, messages } = toAnthropicMessages(conversation);
  // ...
  system: system ?? options.instructions,
  ```
  System-role message in `messages` WINS. If none, falls back to `options.instructions`.

- **Google** (`packages/adapter-google/src/adapter.ts:459-463`):
  ```ts
  // options.instructions takes precedence over a system message
  ...(options.instructions !== undefined
    ? { systemInstruction: options.instructions }
    : { systemInstruction: extractedFromMessages })
  ```
  `options.instructions` WINS. Opposite of Anthropic.

- **OpenAI** (`packages/adapter-openai/src/adapter.ts:718`): passes `options.instructions` alongside converted messages; the messages array is sent to the SDK plus a separate `instructions` field. Both are sent; provider-side merge behavior is opaque.

Same call, three different behaviors. This is not a hypothetical concern the unification introduces; it is a live inconsistency the unification resolves.

### §2.3 Empirical evidence: SalesCoach interview agent

SalesCoach Plan 30 §1 documents the "get structured LLM response" mediator (call site #12) used by its interview agent, which needs `[system, user1, assistant1, user2, assistant2, ...userN]` history. On `@llm-ports` alpha.24, none of the four non-agent methods accept this shape. The three inadequate workarounds (roll into prompt string, `runAgent` with empty tools, `providerExtras` bypass) are documented in v1.0 §2.2.

### §2.4 Cost of not doing this

Not unifying means:
1. Multi-turn callers wait for beta.0 or ship one of the three bad workarounds.
2. `runAgent` continues to have adapter-dependent system-prompt behavior, quietly.
3. Two ways to spell the same thing (`instructions` vs system-in-messages) persist forever.
4. The port's abstraction over provider protocols keeps a compression (single-user-turn) that provider protocols don't require.

### §2.5 Why alpha.26 (not alpha.25, not beta.0)

Unchanged from v1.0: alpha.25 stays crisp with additive features; alpha.26 is the themed unification release; beta.0 stays reserved as the stability signal for post-cleanup shape.

## §3 Current architecture: what the port models today

### §3.1 The five port methods (corrected)

| Method | Instruction field | Turn content field |
|---|---|---|
| `generateText` | `instructions?: string` | `prompt: MessageContent` (single turn) |
| `generateStructured<T>` | `instructions?: string` | `prompt: MessageContent` (single turn) |
| `streamText` | `instructions?: string` | `prompt: MessageContent` (single turn) |
| `streamStructured<T>` | `instructions?: string` | `prompt: MessageContent` (single turn) |
| `runAgent` | `instructions: string` (**REQUIRED**) | `messages: LLMMessage[]` |

`runAgent` is the ONLY method that takes `messages`, but it ALSO requires `instructions`. Two channels, not one.

### §3.2 The types

```ts
type MessageRole = "system" | "user" | "assistant" | "tool";  // ← llm-port.ts:33

interface LLMMessage {
  role: MessageRole;
  content: MessageContent;
}

type MessageContent = string | ContentBlock[];
```

`MessageContent` handles multimodal per-turn content. `LLMMessage` is the multi-turn atom.

### §3.3 Adapter-layer access

Adapters access `options.prompt` and `options.instructions` DIRECTLY in each method (verified in `adapter-openai/src/adapter.ts` at 15+ lines, and analogously in anthropic/google/ollama/vercel). Any normalization strategy must therefore live in a SHARED helper used by BOTH Registry entry points AND every adapter method.

### §3.4 Contract-tests package

The `adapter-contract-tests` package (`packages/adapter-contract-tests/src/suite.ts`) is the shared conformance test suite every adapter runs. It uses `prompt` and `runAgent.instructions` in 20+ fixtures. This is a separate implementation surface the migration must update.

## §4 Design: canonical messages input

### §4.1 The unified shape

All five methods accept `messages: LLMMessage[]` as canonical. `instructions` and `prompt` (where present) are deprecated in alpha.26 and removed in alpha.27.

**Backward-compat framing (v3.1 correction).** In alpha.26, `messages` is TYPE-LEVEL OPTIONAL (`messages?: LLMMessage[]`) so alpha.25 code compiling `{taskType, instructions, prompt}` still passes TypeScript. Runtime validation via the normalizer catches "neither messages nor prompt set" and throws `MessagesRequiredError`. In alpha.27, `messages` becomes REQUIRED (`messages: LLMMessage[]`) and TypeScript enforces migration at compile time.

```ts
// ─── Alpha.26 shape (messages OPTIONAL to preserve compile-time backward-compat) ───
interface CommonCallOptionsAlpha26 {
  taskType: TaskType;
  priority?: LLMPriority;
  messages?: LLMMessage[];                // OPTIONAL in alpha.26; runtime-validated
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  forceProviderAlias?: string;
  reasoningEffort?: "low" | "medium" | "high";
  providerExtras?: Record<string, unknown>;
  cacheControl?: CacheControl;
  budgetScope?: BudgetScopeRef;
  refs?: Record<string, ArtifactRef>;    // shipped in alpha.25 per §1.1 — omit if #53 slips
}

// Alpha.27 shape (messages REQUIRED; legacy fields removed).
interface CommonCallOptionsAlpha27 {
  taskType: TaskType;
  priority?: LLMPriority;
  messages: LLMMessage[];                 // REQUIRED
  // ...rest unchanged from alpha.26
}

// Below examples show alpha.26 shape:
interface GenerateTextOptions extends CommonCallOptionsAlpha26 {
  /** @deprecated alpha.26; removed alpha.27. Use a system message in `messages`. */
  instructions?: string;
  /** @deprecated alpha.26; removed alpha.27. Use `messages`. */
  prompt?: MessageContent;
}

interface GenerateStructuredOptions<T> extends CommonCallOptionsAlpha26 {
  schema: z.ZodType<T>;
  schemaName?: string;
  useStrictResponseFormat?: boolean;
  /** @deprecated alpha.26; removed alpha.27. */
  instructions?: string;
  /** @deprecated alpha.26; removed alpha.27. */
  prompt?: MessageContent;
}

interface StreamTextOptions extends CommonCallOptionsAlpha26 {
  /** @deprecated alpha.26; removed alpha.27. */
  instructions?: string;
  /** @deprecated alpha.26; removed alpha.27. */
  prompt?: MessageContent;
}

interface StreamStructuredOptions<T> extends CommonCallOptionsAlpha26 {
  schema: z.ZodType<T>;
  schemaName?: string;
  /** @deprecated alpha.26; removed alpha.27. */
  instructions?: string;
  /** @deprecated alpha.26; removed alpha.27. */
  prompt?: MessageContent;
}

interface RunAgentOptions extends CommonCallOptionsAlpha26 {
  tools: Record<string, ToolDefinition>;
  maxSteps?: number;
  onStep?: (step: AgentStep) => void;
  /** @deprecated alpha.26; removed alpha.27. Use a system message in `messages`. */
  instructions?: string;
}
```

Alpha.26 signal: `messages` is optional (backwards compat), legacy fields still work with warnings. Alpha.27 signal: `messages` is required, legacy fields deleted, TypeScript enforces migration.

### §4.2 Conflict rules (explicit, throw)

```ts
// Alpha.26 normalization at every call entry point (Registry AND adapter):

function normalizeCallMessages<O extends {
  instructions?: string;
  prompt?: MessageContent;
  messages?: LLMMessage[];
}>(opts: O): LLMMessage[] {
  const hasMessages = opts.messages !== undefined;
  const hasPrompt = opts.prompt !== undefined;
  const hasInstructions = opts.instructions !== undefined && opts.instructions.length > 0;

  // Rule 1: messages + prompt is ambiguous. Throw.
  if (hasMessages && hasPrompt) {
    throw new MessagesConflictError(
      "Both `messages` and `prompt` set. `prompt` is deprecated; use `messages` only.",
    );
  }

  // Rule 2: messages array with a system-role turn + separate instructions is ambiguous. Throw.
  if (hasMessages && hasInstructions) {
    const hasSystemInMessages = opts.messages!.some((m) => m.role === "system");
    if (hasSystemInMessages) {
      throw new MessagesConflictError(
        "`messages` contains a system-role turn and `instructions` is also set. Use one.",
      );
    }
    // Rule 2a (grace): instructions + messages without a system turn — merge and warn.
    // Prepend instructions as a system-role message.
    emitDeprecationWarning("instructions-alongside-messages", opts);
    return [{ role: "system", content: opts.instructions! }, ...opts.messages!];
  }

  // Rule 3: legacy instructions + prompt (alpha.26 only). Normalize + warn.
  if (hasPrompt) {
    emitDeprecationWarning("legacy-instructions-prompt", opts);
    return toMessages(opts.instructions, opts.prompt);
  }

  // Rule 4: messages alone. Canonical path.
  if (hasMessages) {
    if (opts.messages!.length === 0) throw new EmptyMessagesError();
    return opts.messages!;
  }

  // Rule 5: nothing set.
  throw new MessagesRequiredError();
}
```

For `runAgent` in alpha.26, apply the same rules with `instructions` REQUIRED loosened to optional. Alpha.27 removes `instructions` from runAgent entirely.

### §4.3 Multi-turn structured output policy

The v1.0 plan didn't address this. `generateStructured` today (verified in `adapter-openai/src/adapter.ts:517-518` and analogously in other adapters) appends schema-instruction text to `options.prompt` for the classic JSON-object path, and retries with error-feedback text concatenated to the prompt when validation fails.

For multi-turn callers, the schema-instruction placement and retry mechanics must be explicit:

**Rule S1: Schema instruction placement.**
- If the adapter has native structured-output support (OpenAI strict JSON schema, Google native `responseSchema`, Anthropic tool-use trick): use it. No prompt mutation of the message array.
- If the adapter falls back to prompted JSON: apply `appendUserInstruction(messages, "Return JSON matching the schema. No prose, no code fences.")`. The helper follows the rule below.

  ```ts
  function appendUserInstruction(
    messages: LLMMessage[],
    instruction: string,
  ): LLMMessage[] {
    const last = messages[messages.length - 1];
    if (last?.role === "user") {
      // Merge into the existing final user turn — preserves user/model alternation.
      return [
        ...messages.slice(0, -1),
        { ...last, content: appendToContent(last.content, instruction) },
      ];
    }
    // Last turn is assistant/tool/none — safe to append a new user turn.
    return [...messages, { role: "user", content: instruction }];
  }
  ```

  Rationale: Google's `contents` API requires user/model alternation. Anthropic tolerates but discourages consecutive user turns. OpenAI accepts either shape. Merging into the trailing user turn keeps every provider on their preferred wire format and avoids the `[..., user, user]` shape that would break Google.

  `appendToContent` handles both string and block-shaped `MessageContent`: string → concatenate with newline separator; block-shaped → append a `TextBlock` with the instruction.

**Rule S2: Validation-retry mechanics.**
On the retry attempt after a schema-validation failure, do NOT concatenate error text into an existing message. Instead:
1. Take the invalid model output (raw text) and append it to the message array as a `{role: "assistant", content: invalidText}` turn.
2. Append a NEW user-role turn: `"Your previous response did not match the schema. Errors: <zod formatted errors>. Reply with valid JSON only."`
3. Re-send.

Rationale: preserves the conversation history intact, keeps the correction visible to the reader of the message log, matches how a human coach would correct a student mid-conversation. Verifies against the schema on the next assistant turn.

**Rule S3: attemptValidationRepair still applies FIRST.**
The alpha.19+ `attemptValidationRepair` deterministic repair kicks in BEFORE the retry-with-conversation. Only if repair fails does the conversation extend.

### §4.4 `LLMMessage` role model and system-role discipline

`MessageRole = "system" | "user" | "assistant" | "tool"` (unchanged from today).

**Strict system-role rules (throws on violation):**

The plan enforces exactly zero or one system-role message, and if present, it must be at index 0 of the array. Any violation throws `NonContiguousSystemError` (extends `LLMPortError`). Enforcement lives in `validateMessagesShape()` (Appendix B), called from `normalizeCallMessages()` at its single return point so every path through the normalizer is covered. Rules:

1. **Zero system messages.** Legal. The provider is invoked without a system prompt.
2. **Exactly one system message, at index 0.** Legal. Canonical shape. The adapter routes it to the provider's system channel (top-level `system` on Anthropic, `systemInstruction` on Google, first `system`-role message on OpenAI).
3. **Two or more system messages anywhere in the array.** Throw. Different providers treat multi-system differently (OpenAI keeps them as positioned messages; Anthropic and Google can only accept one system value). Silent concatenation would produce cross-provider drift; explicit throw forces the caller to merge intentionally.
4. **A system message at any index other than 0.** Throw. OpenAI treats mid-conversation system messages as boundary markers ("reset context"); Anthropic and Google have no equivalent. Silent flattening would produce cross-provider drift; explicit throw forces the caller to restructure.

Rationale: the port's job is to provide *deterministic cross-provider behavior*. Silent concatenation or silent flattening breaks that contract. The throw surfaces the ambiguity at the call site, where the caller can decide the correct merge for their use case.

**Provider mapping (per adapter, in the legal shapes above):**

- **OpenAI adapter**: index-0 system message → sent as first `system`-role message in the array. `user`/`assistant`/`tool` → passthrough. If OpenAI internally distinguishes `system` vs `developer` for reasoning models, adapter routes silently (see §11.1).
- **Anthropic adapter**: index-0 system message → extracted and passed as top-level `system` parameter (Anthropic API does not accept system-role inside `messages`); `user`/`assistant` → passthrough; `tool` → mapped to `user` message with `tool_result` content block (Anthropic's convention).
- **Google adapter**: index-0 system message → extracted and passed as top-level `systemInstruction`; `user` → `user`; `assistant` → `model` (Google's rename); `tool` → `function` role.
- **Ollama adapter**: passes messages through natively; ollama supports the OpenAI-compatible role set.
- **Vercel adapter**: bridge over Vercel AI SDK; converts to Vercel's `CoreMessage` type; strict rules apply before conversion.

**Escape hatch for callers who WANT multi-system semantics.** If a caller has "persona system + task system" pattern and knows exactly which provider they're targeting, they merge to a single system message before calling the port:

```ts
const merged = `${personaPrompt}\n\n${taskPrompt}`;
messages: [sys(merged), usr(userInput)]
```

Or, for provider-specific behavior, use `providerExtras` to bypass the port shape (documented as advanced usage).

**Open decision (§11.1): OpenAI `developer` role.** OpenAI added a `developer` role for reasoning-model system prompts (o-series, gpt-5). Options:
- **(a) Add now**: extend `MessageRole` to include `"developer"`. OpenAI adapter uses it natively for reasoning models; other adapters map to system.
- **(b) Defer**: keep 4 roles; OpenAI adapter internally routes `system` to `developer` for reasoning models. Transparent to consumers.

Recommendation: **(b) defer**. The developer/system distinction is provider-internal for now.

### §4.5 Tool-role message validation

`role: "tool"` messages are permitted in `generateText` / `generateStructured` / `streamText` / `streamStructured` when passed as part of a `messages` array that came from a prior `runAgent` step (continuation pattern).

Structural validation: allowed. Sequence validation (tool result must follow an assistant tool_use call): NOT enforced by the port. Adapters may throw provider-native errors if the sequence is invalid; caller responsibility to build correct sequences.

Documented in the migration guide with a note: "If you pass tool messages, ensure they follow a preceding assistant tool_use call. Invalid sequences produce provider errors."

### §4.6 Interaction with existing options

All existing options carry over: `refs`, `budgetScope`, `providerExtras`, `signal`, `reasoningEffort`, `forceProviderAlias`, per-attempt timeout, runtimeFallback. `cacheControl` needs specific composition rules given the shape change (below).

**Anthropic prompt-caching composition (regression risk without this):**

Pre-alpha.26, the flow was `instructions: "long persona"` → adapter attaches `cache_control: {type: "ephemeral"}` to the extracted system field → Anthropic caches the persona. Post-alpha.26, the caller writes `messages: [sys("long persona"), ...]`. The caching hint has two possible attachment points:

1. **Block-level `cache_control` inside the system message content.** Requires `sys()` to accept `MessageContent` (blocks), not just `string`. **This plan broadens `sys()` accordingly (§5.2).** Caller writes:
   ```ts
   messages: [
     sys([{ type: "text", text: longPersona, cache_control: { type: "ephemeral" } }]),
     usr(userInput),
   ]
   ```
   Adapter extracts the system message's content blocks intact, including the `cache_control` hint, and passes to the provider's system field.

2. **Call-level `cacheControl` option.** When the caller sets `cacheControl` on the call itself AND the message array has an index-0 system message with plain-string content, the adapter attaches the hint to that system message's extracted content. When the message array has block-level content, call-level `cacheControl` is IGNORED and the block-level hint wins (block-level is more specific).

**Rule table for `cacheControl` composition:**

| System message content shape | Call-level `cacheControl` | Behavior |
|---|---|---|
| String | Set | Adapter promotes system content to `[{type:"text", text, cache_control}]` for providers that support it (Anthropic). Silently ignored by providers that don't. |
| String | Unset | No caching hint applied. |
| Blocks (ContentBlock[]) | Set | Call-level ignored; block-level `cache_control` on each block used. **No warning** — this is a precedence rule, not a deprecation. Documented behavior; tested for parity. |
| Blocks | Unset | Block-level `cache_control` on each block used. |
| No system message | Any | Call-level `cacheControl` (if applied to first user message) unchanged per current behavior. |

**Anthropic caching-parity test (mandatory in §10):** send `instructions: longPersona` under legacy shape and `messages: [sys(longPersona)]` under new shape; verify identical wire format with `cache_control` on both.

### §4.7 Empty, invalid, and tool-content messages

- `messages: []` throws `EmptyMessagesError` (extends `LLMPortError`).
- Missing both `messages` and `prompt` throws `MessagesRequiredError` (extends `LLMPortError`).
- Multi-system or mid-conversation-system throws `NonContiguousSystemError` (extends `LLMPortError`) per §4.4.
- All new error classes live in `packages/core/src/errors.ts` alongside the existing taxonomy.

**Tool messages and `tool_use` content blocks passed to non-agentic calls.**

A `messages` array captured from a prior `runAgent` step may contain `role: "tool"` messages AND assistant messages whose content includes `tool_use` blocks. When this array is subsequently passed to `generateText` / `generateStructured` / `streamText` / `streamStructured`, per-adapter behavior differs:

- **OpenAI adapter**: accepts both `role: "tool"` messages and assistant `tool_use` content blocks in non-agentic calls. Silently processes.
- **Anthropic adapter**: an assistant message containing a `tool_use` content block without a following `tool_result` will produce a `400 invalid_request_error` from the provider. Adapter surfaces as `BadRequestError`.
- **Google adapter**: inconsistent; sometimes accepts, sometimes errors. Adapter surfaces provider error as-is.
- **Ollama adapter**: treats `tool_use` blocks as text; may produce incoherent output. No error.
- **Vercel adapter**: passes to Vercel AI SDK which routes to underlying provider; same behavior as above.

**Rule**: caller responsibility to ensure valid sequences. The port does NOT scrub tool-related content from message arrays because doing so would destroy provenance. Consumers building "capture runAgent state, continue in non-agentic call" workflows must filter or transform the array themselves before the call.

Documented in the migration guide with a "Continuing from a runAgent step" section.

## §5 Migration ergonomics: `toMessages` and helpers

### §5.1 `toMessages()` migration shim

```ts
export function toMessages(
  instructions: string | undefined,
  prompt: MessageContent,
): LLMMessage[];
```

Semantics: if `instructions` is non-empty, prepend a system-role message; then append a user-role message with `prompt`. Throws `PromptRequiredError` (extends `LLMPortError`) if `prompt` is undefined.

Stays past alpha.27 as an ergonomic utility.

### §5.2 `sys()` and `usr()` convenience helpers

```ts
export function sys(content: MessageContent): LLMMessage;   // {role: "system", content}
export function usr(content: MessageContent): LLMMessage;   // {role: "user", content}
```

**Note on `sys()` accepting `MessageContent`:** v2.0 §11.5 recommended keeping `sys()` as `string`-only. Reversed in v3.0 because Anthropic prompt-caching requires block-level `cache_control` attachment (§4.6). Callers who want to hint caching write:

```ts
messages: [
  sys([{ type: "text", text: longPersona, cache_control: { type: "ephemeral" } }]),
  usr(userInput),
]
```

Simple string case still works: `sys("Classify.")` returns `{role: "system", content: "Classify."}`.

Idiomatic single-turn:
```ts
port.generateText({
  taskType: "triage",
  messages: [sys("Classify."), usr(rawEmail)],
});
```

Stay past alpha.27.

### §5.3 No `asst()` helper

Assistant turns typically come from LLM outputs (captured and fed back in) with structure (may include tool_use blocks). Constructing from a plain string is uncommon; object literal is clear enough.

### §5.4 Import paths

All from `@llm-ports/core`:
```ts
import { toMessages, sys, usr } from "@llm-ports/core";
```

## §6 Alternatives considered and rejected

Same six alternatives as v1.0 §6, all still rejected for the same reasons. Deferring to beta.0 (v1.0 §6.5) remains the escape hatch if the alpha.26 review surfaces unresolvable design questions.

## §7 Rollout plan: alpha.26 → alpha.27

### §7.1 Alpha.26 scope (revised)

Single themed release: "API unification, canonical messages input."

Changes:

1. Add `messages?: LLMMessage[]` to all five options types (including `RunAgentOptions`). Optional in alpha.26.
2. Mark `instructions` and `prompt` (where present) as `@deprecated` in JSDoc — across ALL FIVE methods including runAgent.
3. Make `RunAgentOptions.instructions` optional in alpha.26 (was required). Consumers who pass it get deprecation warning; consumers who use system-role message in `messages` get canonical behavior.
4. Add shared normalizer `normalizeCallMessages()` in `packages/core/src/utils/normalize-messages.ts`. Call it in:
   - Registry entry points (`packages/core/src/registry/registry.ts`)
   - Each adapter's method entry point (openai, anthropic, google, ollama, vercel)
5. Deprecation warning mechanism: `RegistryOptions.deprecationWarnings?: "console" | "silent" | ((event: DeprecationEvent) => void)` — default `"console"` in Node, `"silent"` in browser (heuristic: no stack fingerprinting; use a plain `Set<string>` of deprecation-tag keys to dedup within a single Registry lifetime). Simpler than v1.0's fingerprinting proposal.
6. Add errors to `packages/core/src/errors.ts`: `MessagesRequiredError`, `EmptyMessagesError`, `MessagesConflictError`, `PromptRequiredError`. All extend `LLMPortError`.
7. Export `toMessages`, `sys`, `usr` from `@llm-ports/core`.
8. Update contract tests (`packages/adapter-contract-tests/src/suite.ts`) to exercise BOTH legacy and messages paths during alpha.26.
9. Migration guide `docs/migration/alpha-25-to-alpha-26.md`.
10. Adapter READMEs updated. Top-level README getting-started shows `messages` shape.
11. Structured-output multi-turn schema policy (§4.3) implemented in each adapter's `generateStructured` retry path.
12. Release notes titled `⚠️ BREAKING (upcoming in alpha.27)`.

### §7.2 Alpha.27 scope

Removal release:

1. Remove `instructions` and `prompt` fields from all five options types (including `RunAgentOptions.instructions`).
2. `messages: LLMMessage[]` becomes required on all five methods.
3. Remove deprecation-warning code + option.
4. Delete legacy code paths in adapters.
5. Contract tests: delete legacy-path duplicates.
6. Migration guide `docs/migration/alpha-26-to-alpha-27.md` as pointer.
7. Release notes titled `⚠️ BREAKING (removal)`.

### §7.3 Deprecation-warning UX (revised, simpler)

Option shape:
```ts
type DeprecationWarningMode =
  | "console"
  | "silent"
  | ((event: DeprecationEvent) => void);

interface RegistryOptions {
  // ...existing fields
  deprecationWarnings?: DeprecationWarningMode;
}

// Adapters also accept the same option in their constructor for direct-adapter consumers:
interface OpenAIAdapterOptions {
  // ...existing fields
  deprecationWarnings?: DeprecationWarningMode;
}
// Analogously for Anthropic, Google, Ollama, Vercel adapter constructors.

interface DeprecationEvent {
  tag: "legacy-instructions-prompt" | "instructions-alongside-messages" | "runagent-instructions";
  method: "generateText" | "generateStructured" | "streamText" | "streamStructured" | "runAgent";
  adapter?: string;   // set when raised inside an adapter, else Registry
  message: string;
  seenBefore: boolean;  // true after the first occurrence of this (tag, method) pair
}
```

**Default: `"console"` everywhere.** No browser heuristic (removed in v3.1 for consistency). Consumers who want silence pass `"silent"` explicitly. Consumers running in noisy environments (bundled browser, edge worker, hot log path) explicitly configure once at construction.

Direct-adapter consumers configure via the adapter constructor's `deprecationWarnings` field. Registry consumers configure via `RegistryOptions.deprecationWarnings`. When the Registry constructs an internal adapter, it propagates its own setting into the adapter unless the adapter was constructed with its own explicit setting.

**Dedup-key granularity (explicit):** the dedup key is `` `${tag}:${method}:${adapter ?? "registry"}` ``. This yields at most **one warning per `(deprecation-type, method, adapter)` tuple per Registry lifetime**. That is, if a Registry has 5 aliases (openai, anthropic, google, ollama, vercel) and the caller uses legacy `{instructions, prompt}` on `generateText`, the caller sees up to 5 warnings across the lifetime of the process (one per adapter that observes the deprecation). NOT one warning per call site. Site-level dedup was considered in v1.0 via stack fingerprinting and rejected in v2.0 as bundler-unsafe and cost-prohibitive.

Rationale: (a) predictable behavior, no stack-trace parsing overhead; (b) the warning message names the deprecation and the migration path — one message per method per adapter is enough signal; (c) consumers who want site-level attribution provide a custom `deprecationWarnings` function and log call-site context themselves.

Cost: single hash-set lookup per deprecation-triggering call. Effectively free.

No stack-trace fingerprinting. No file-path leakage. Bundler-safe.

### §7.4 Release notes format

Unchanged from v1.0 §7.4.

## §8 Implementation (revised)

### §8.1 Files changed in `packages/core`

- `src/ports/llm-port.ts`: add `messages?` to `GenerateTextOptions`, `GenerateStructuredOptions`, `StreamTextOptions`, `StreamStructuredOptions`; make `RunAgentOptions.instructions` optional; add `@deprecated` JSDoc on `instructions` and `prompt` (all methods).
- `src/utils/normalize-messages.ts` (new): `normalizeCallMessages()`, `toMessages()`, `sys()`, `usr()`, deprecation-warning emitter.
- `src/registry/registry.ts`: call `normalizeCallMessages()` at the entry of each of the five methods before dispatching to the adapter. Pass the normalized `messages` through so the adapter sees only the canonical shape.
- `src/errors.ts`: add `MessagesRequiredError`, `EmptyMessagesError`, `MessagesConflictError`, `PromptRequiredError` all extending `LLMPortError`.
- `src/index.ts`: export the new symbols.

Estimated core LOC: ~350 lines production, ~250 lines tests.

### §8.2 Files changed in each adapter

Each of `adapter-openai`, `adapter-anthropic`, `adapter-google`, `adapter-ollama`, `adapter-vercel`:

- `src/adapter.ts`: replace direct `options.prompt` / `options.instructions` reads with a `const messages = normalizeCallMessages(options);` call at the top of each of the four generation methods AND `runAgent`. Downstream logic reads from the normalized `messages` array.
- Provider-specific translation logic (system-role extraction for Anthropic, `systemInstruction` for Google, `model` role for Google's assistant turn, etc.): refactor to consume the normalized `messages` array as the single source of truth.
- `generateStructured` retry path: implement §4.3 rules S1/S2/S3.
- `runAgent` path: remove `options.instructions` fallback logic; the normalizer handles it. Silent-precedence inconsistency (Anthropic vs Google) resolved by the throw-on-conflict rule.

Per-adapter LOC: 50–100 production lines, 150–250 test lines.

### §8.3 @llm-ports/capabilities package (added in v3.0)

`packages/capabilities/` has 7 factory files that internally call the port with `{instructions, prompt}`:

- `src/compression/summarize.ts` — `createSummarizer`
- `src/generation/draft.ts` — `createDrafter`
- `src/reasoning/analyze.ts` — `createAnalyzer`
- `src/reasoning/plan.ts` — `createPlanner`
- `src/understanding/classify.ts` — `createClassifier`
- `src/understanding/extract.ts` — `createExtractor`
- `src/understanding/score.ts` — `createScorer`

Alpha.26 changes:
- Each factory's internal `{instructions, prompt}` construction migrates to `messages` array construction using `sys()` + `usr()` helpers or `toMessages()`.
- Factory external APIs (what consumers call) are unchanged. Task-specific input signatures stay stable. Only the internal port call changes.
- Update the shared `src/shared.ts` helper if it constructs port calls centrally.
- Update `src/index.ts` re-exports if any factory's typing surface changed.

Alpha.27 changes: none. The alpha.26 internal migration is sufficient; consumers of capabilities never saw the legacy port shape.

Capabilities LOC: ~50 production lines (7 files × ~7 lines each) + ~150 lines of internal-call tests updated.

**Open question (§11.11): should alpha.26 ship a `createChatExtractor(schema, opts)` multi-turn variant?**

The interview-agent shape (§2.3) is a natural fit for a capabilities-package factory: takes a message array, returns the next assistant turn's extracted structure. Options:
- (a) Ship in alpha.26. Adds ~100 LOC + a new factory + docs.
- (b) Defer to alpha.27+. Alpha.26 stays scoped to the port unification; capabilities gets multi-turn variants in a later release.

Recommendation: **(b) defer**. Keeps alpha.26 focused on the port; capabilities package migration is internal-only. New factory variants are additive and can ship in alpha.27 or later without breaking anything.

### §8.4 Contract tests package

`packages/adapter-contract-tests/src/suite.ts` currently uses `prompt` and `runAgent.instructions` in 20+ fixtures.

Alpha.26 update:
- Every fixture using `prompt: "x"` gets a paired fixture using `messages: [usr("x")]`. Runs BOTH to prove parity.
- Every fixture using `runAgent({instructions, messages})` gets a paired fixture using `runAgent({messages: [sys(instructions), ...messages]})`. Runs BOTH.
- New fixtures added for multi-turn cases (interview-agent shape, tool-continuation, multi-system-message).
- New fixtures added for conflict cases (both `messages` and `prompt` → throw; system-in-messages + `instructions` → throw).

Alpha.27 update: delete legacy-path fixtures; keep only `messages`-based.

Contract-tests LOC: ~400 alpha.26; ~-200 alpha.27 (net deletion).

### §8.5 Documentation

Same as v1.0 §8.4, plus:
- Document the `MessagesConflictError` shape and conflict rules explicitly in the migration guide.
- Document per-adapter system-role mapping in each adapter README.
- Document the multi-turn structured-output retry mechanic (§4.3 rules) in `docs/concepts/structured-output.md`.
- Document the OpenAI-developer-role open decision either as "used internally, transparent to consumers" or as an explicit new role, per §4.4 resolution.

### §8.6 Estimated total effort (revised v3.0)

- Core changes: 1.5 days (350 LOC + tests)
- Adapter changes: 4 days (5 adapters × ~1 day each: normalize call + refactor + structured retry + tests)
- Capabilities package changes: 0.5 day (~50 LOC + internal test updates)
- Contract-tests update: 1 day
- Documentation: 2 days (migration guide + concept pages + adapter READMEs + top-level README)
- Review + BEPA + SalesCoach smoke test: 1 day
- Buffer for structured-output retry semantics validation across adapters: 1 day

Total: **~10.5 engineer-days**. Range: 8–12 depending on how many surprises hit in the structured-output multi-turn path (which is the least-explored surface) and the block-level `cache_control` composition on Anthropic.

Calendar timeline: 2–3 weeks after alpha.25 ships (assuming 4–5 productive days per calendar week and interleaving with other work).

## §9 Migration path for consumers

Same as v1.0 §9 with two additions:

### §9.6 SalesCoach coordination decision (Plan 30 collision)

**Situation.** SalesCoach Plan 30 v1.3 is APPROVED (2026-07-02T01:49:42) and executing NOW on `feature/llm-ports-migration`. Its Phase 4 pins alpha.24 and migrates 20 call sites to the `{instructions, prompt}` shape. If alpha.26 ships on schedule (2026-07-29 per §14), those 20 sites break during the alpha.27 removal, and SalesCoach re-migrates from `{instructions, prompt}` to `messages`.

**Three options, one recommendation.**

- **Option A — Delay alpha.26.** Wait until BEPA, SalesCoach, HomeSignal, and ADW finish their alpha.24-shape migrations. Alpha.26 tag slides ~4–6 weeks. Downside: velocity cost; every consumer waits; other alpha.26 dependents (multi-turn use cases) blocked.

- **Option B — Ship alpha.26-rc branch early; SalesCoach Phase 4.0 migrates directly to `messages`.** The alpha.26 working branch becomes usable ~1 week after alpha.25 tags. SalesCoach Plan 30's Phase 4.0 (facade + adapter parity) targets alpha.26-rc from day one instead of alpha.24-shape. SalesCoach skips the intermediate `{instructions, prompt}` shape entirely; no re-migration. Alpha.26 timeline unchanged. Coordination cost: Plan 30 amends its Phase 4.0 note to target `messages`; SalesCoach uses `npm install @llm-ports/core@rc-alpha-26` or equivalent until tag.

- **Option C — Ship alpha.26 as planned; SalesCoach eats re-migration.** SalesCoach lands 20 sites on `{instructions, prompt}`, then during the alpha.26 → alpha.27 window (3 weeks) re-migrates to `messages`. Half a day of mechanical work. Downside: SalesCoach absorbs coordination cost that could have been prevented.

**Ratified (2026-07-02T04:20:00 -07:00): Option C.** SalesCoach Plan 30 continues unchanged against alpha.24 shape. During the alpha.26 → alpha.27 migration window (3 weeks), SalesCoach re-migrates its 20 sites from `{instructions, prompt}` to `messages`. Approximate cost: half a day of mechanical work using `toMessages()` shim, or ~4 hours idiomatic with `sys()` + `usr()` helpers.

**Rationale for choosing C over B:** Option B would have required Plan 30 to amend Phase 4.0 mid-flight and adopt an rc-branch dependency for a release that hasn't tagged yet. That is coordination cost + risk (rc-branch APIs can shift before tag) traded for saving ~half a day of SalesCoach re-migration work later. The trade favors ratifying the already-approved Plan 30 execution and accepting a small, deterministic re-migration cost in the alpha.26 window. Option A rejected as before: too much velocity cost to other consumers waiting on alpha.26.

**Consequences of Option C for the plan:**

1. No alpha.26-rc.0 milestone — §14 timeline reflects direct alpha.26 tag.
2. Plan 30 continues on its approved path; no `Development_Plans.md` amendment needed.
3. SalesCoach's alpha.26 → alpha.27 window includes an explicit re-migration line item, tracked as a Plan 30 close-out task (or a new small plan against SalesCoach's own tracker).
4. BEPA, HomeSignal, ADW migrate to `messages` on their own alpha.26 upgrade cadence per §9.1-9.4.
5. Alpha.26 release notes note SalesCoach as a known consumer whose Phase 4 migration lands on legacy shape and will re-migrate in the window; other consumers should target `messages` from day one on alpha.26.

### §9.7 runAgent callers

Every current `runAgent` consumer passes `instructions` today (it's required). Migration:

**Mechanical (alpha.26 window):**
```ts
// Before:
port.runAgent({
  taskType: "coding-agent",
  instructions: SYSTEM_PROMPT,
  messages: history,
  tools: coder.tools,
});

// After (alpha.26 mechanical, warning-free):
port.runAgent({
  taskType: "coding-agent",
  messages: [sys(SYSTEM_PROMPT), ...history],
  tools: coder.tools,
});
```

**Or during alpha.26 grace period:** keep `instructions` field set, get one deprecation warning, migrate later. In alpha.27 the field is gone; must use the messages-array shape.

### §9.8 SalesCoach interview-agent update

The unblocked path (v1.0 §4.4 last example) uses messages natively. Verified now that this same shape works for `runAgent` if the interview agent needs tools:

```ts
port.runAgent({
  taskType: "interview",
  messages: [
    sys(interviewerSystemPrompt),
    usr(student.answer1),
    { role: "assistant", content: interviewer.followup1 },
    usr(student.answer2),
    // ...
  ],
  tools: interviewerToolset,
});
```

## §10 Testing strategy (revised)

Everything from v1.0 §10, plus:

### §10.7 runAgent parity tests

For each adapter, verify that:
1. `runAgent({instructions: "X", messages: [{user, "hi"}]})` produces the same wire format as `runAgent({messages: [sys("X"), usr("hi")]})`. Same wire format = same behavior.
2. `runAgent({instructions: "X", messages: [sys("Y"), usr("hi")]})` throws `MessagesConflictError`.
3. `runAgent({messages: [sys("Y"), usr("hi")]})` uses "Y" as system prompt on Anthropic AND Google (resolving the pre-alpha.26 silent-precedence divergence).

### §10.8 Multi-turn structured-output tests

For each adapter, verify:
1. Multi-turn `generateStructured` with a valid conversation history + schema returns validated data.
2. Multi-turn `generateStructured` where the model's first response fails validation:
   - Extends the conversation array with the invalid assistant turn.
   - Appends a user-role correction turn.
   - Retries with the extended array.
   - Passes validation on retry.
3. `attemptValidationRepair` fires BEFORE the conversation extends (§4.3 rule S3).

### §10.9 Contract-test parity

Runs the full contract-test suite once with legacy-path fixtures and once with messages-path fixtures. Both must pass in alpha.26. Legacy-path fixtures deleted in alpha.27.

## §11 Open design questions (revised)

1. **OpenAI `developer` role**: covered in §4.4. Recommendation: defer to adapter-internal mapping; do NOT extend `MessageRole` union in alpha.26.
2. **`instructions` interaction with system-role messages**: covered in §4.2. Recommendation: throw on conflict (already specified).
3. **`runAgent` treatment**: v1.0 said "no impact." v2.0 explicitly makes `instructions` optional and deprecated on runAgent too.
4. **Provider adapters that split system out of messages**: covered in §4.4. Multi-system-message concatenation documented per adapter.
5. **`sys()` accepting `MessageContent`**: **REVERSED in v3.0**. Broaden `sys()` to accept `MessageContent` so callers can attach block-level `cache_control` for Anthropic prompt caching. Anthropic caching-parity test mandatory (§4.6, §10).
6. **Codemod for automated migration**: nice-to-have; not blocking. Defer to alpha.26.1 docs sweep.
7. **`asst()` helper**: no. Object literal is fine.
8. **NEW: Deprecation-warning heuristic for browser detection**: `"silent"` default in browser is a heuristic based on `globalThis.window`. Fragile in some edge cases (Deno with browser polyfills, Bun, workers). Recommendation: default `"console"` everywhere; consumers who don't want warnings pass `"silent"` explicitly.
9. **NEW: Should the normalizer live in a subpath export?** e.g. `@llm-ports/core/normalize`. Recommendation: no. Ship from the main `@llm-ports/core` entry point; the helpers are small.
10. **NEW: `MessagesConflictError` at conversion (Registry entry) vs at dispatch (adapter entry)?** Both call the normalizer, so both can throw. Recommendation: throw at the FIRST call — this is Registry when the port is Registry-wrapped, adapter when the port is used directly. Idempotent; either throws the same error.
11. **NEW: `createChatExtractor` (multi-turn capabilities factory)?** Covered in §8.3. Recommendation: defer to alpha.27+. Additive; can ship without breaking anything.
12. **NEW: Multi-system escape hatch policy.** Callers who legitimately want persona-plus-task system pattern merge to a single string before calling the port (§4.4 escape hatch example). Documented in migration guide. No API surface for "please concatenate my two system messages" because provider behavior differs and the port refuses to hide that.
13. ~~**NEW: SalesCoach coordination — Option B ratification.**~~ **RESOLVED v3.2: Option C ratified** (§9.6). SalesCoach re-migrates in the alpha.26 → alpha.27 window. No rc-branch coordination artifact needed.

## §12 Risks and mitigations (revised)

Same as v1.0 §12 plus:

### §12.6 Structured-output retry semantics regression

**Risk.** Rule S2 (append invalid assistant + user correction on retry) is different from today's behavior (concatenate correction into prompt). Some models may behave differently when they see their own invalid output in the history.

**Mitigation.** Run cross-provider empirical test on 5+ providers with 10+ structured-output schemas that fail on first try. Confirm the append-conversation path produces valid retries at rates ≥ current concatenate-prompt path. If regression, adjust the correction-message wording; if severe regression, keep the current concatenate path as a per-adapter fallback and file follow-up work.

### §12.7 runAgent silent-precedence break for existing consumers

**Risk.** Consumers today may rely on Anthropic's "system-in-messages wins" or Google's "instructions wins" behavior. Alpha.26 throws on the conflict; alpha.27 removes the ambiguity. Some consumer's current runAgent call may throw at alpha.26.

**Mitigation.**
- Migration guide explicitly documents the pre-alpha.26 silent-precedence inconsistency (with citations to the Anthropic and Google adapter code).
- The throw is a clear error, not a silent behavior change. Consumer sees `MessagesConflictError` and fixes the call.
- BEPA + SalesCoach + HomeSignal + ADW audit before alpha.26 ships: grep for any runAgent call that passes both `instructions` and a system-role message in `messages`. Zero cases in BEPA (verified via grep); confirm same for the other three.

## §13 Definition of done (revised)

Alpha.26 ships when all of the following are true:

1. All FIVE methods (`generateText`, `generateStructured`, `streamText`, `streamStructured`, `runAgent`) accept `messages: LLMMessage[]`.
2. `RunAgentOptions.instructions` is optional (was required); deprecated.
3. `instructions` and `prompt` deprecated on all four other methods.
4. `normalizeCallMessages` is used at Registry entry AND every adapter method entry.
5. `MessagesConflictError`, `MessagesRequiredError`, `EmptyMessagesError`, `PromptRequiredError`, `NonContiguousSystemError` all extend `LLMPortError`.
6. Strict system-role rules enforced (§4.4): zero or one leading system message; multi-system and mid-conversation-system throw `NonContiguousSystemError`. Tested per adapter.
7. `sys()` accepts `MessageContent` (broadened for block-level `cache_control`).
8. Anthropic prompt-caching parity verified: `instructions: longPersona` under legacy shape and `sys([{type:"text", text: longPersona, cache_control:{type:"ephemeral"}}])` under new shape produce identical Anthropic wire format.
9. `cacheControl` composition rule table (§4.6) implemented; block-level wins over call-level with warning.
10. Multi-turn structured-output retry mechanics (§4.3 rules S1/S2/S3) implemented in every adapter.
11. @llm-ports/capabilities package's 7 factories migrated to internal `messages` construction; external factory APIs unchanged.
12. All existing alpha.25 tests pass unchanged.
13. Contract tests run BOTH legacy and messages paths for every fixture. Both pass on all five adapters (openai/anthropic/google/ollama/vercel).
14. Cross-provider parity tests pass for single-turn AND multi-turn shapes.
15. Silent-precedence divergence resolved: same `runAgent` call sent to Anthropic and Google produces the same system-prompt behavior.
16. Deprecation warnings emit per `deprecationWarnings` option; default `"console"`; dedup key `(tag, method, adapter)` tuple; tested.
17. Tool-content behavior (§4.7) documented per adapter in migration guide.
18. Migration guide `docs/migration/alpha-25-to-alpha-26.md` published with worked examples for each of the four non-agent methods AND runAgent.
19. Adapter READMEs updated across all five adapters.
20. Top-level README getting-started shows `messages` shape.
21. GitHub Release + Discussion post published with `⚠️ BREAKING (upcoming in alpha.27)` label.
22. Option C ratified for SalesCoach (§9.6): Plan 30 continues on alpha.24 shape; alpha.26 release notes acknowledge SalesCoach as a known re-migration consumer in the alpha.26 → alpha.27 window. BEPA, HomeSignal, ADW target `messages` from day one on their alpha.26 upgrade cadence.
23. Alpha.25 dependencies (#53 refs, #54 aggressive fallback, #55 streamed cost) have shipped before alpha.26 tag.

Alpha.27 ships when all of the following are true:

1. `instructions` and `prompt` removed from all five options types.
2. `messages: LLMMessage[]` required on all five methods.
3. Deprecation-warning code + `deprecationWarnings` option removed.
4. Legacy-path fixtures deleted from contract tests.
5. `docs/migration/alpha-26-to-alpha-27.md` published.
6. GitHub Release + Discussion post published with `⚠️ BREAKING (removal)` label.
7. BEPA, SalesCoach, HomeSignal, ADW confirm clean upgrade.

## §14 Timeline estimate (revised)

| Milestone | Target | Notes |
|---|---|---|
| Alpha.25 ships | 2026-07-08 to 2026-07-12 | refs + aggressive fallback + streamed cost + docs |
| Alpha.26 planning + review | 2026-07-13 to 2026-07-15 | Address open questions §11; freeze design |
| Alpha.26 core implementation | 2026-07-16 to 2026-07-17 | shared normalizer + errors + Registry wiring |
| Alpha.26 adapter implementation | 2026-07-18 to 2026-07-23 | 5 adapters × ~1 day each + structured retry + system-role strict rules + Anthropic cache_control parity |
| Alpha.26 capabilities migration | 2026-07-23 | 7 factories internal-call migration |
| Alpha.26 contract-tests update | 2026-07-25 | legacy + messages paths |
| Alpha.26 docs + BEPA/SalesCoach smoke test | 2026-07-27 to 2026-07-28 | migration guide + concept pages |
| Alpha.26 release | 2026-07-29 | ⚠️ BREAKING (upcoming in alpha.27) label |
| Alpha.26 migration window | 2026-07-29 to 2026-08-19 | 3 weeks (5 adapters + runAgent + capabilities) |
| Alpha.27 implementation | 2026-08-20 to 2026-08-22 | Remove deprecated code + tests |
| Alpha.27 release | 2026-08-24 | ⚠️ BREAKING (removal) label |

Slippage tolerance: alpha.27 delays cheap; alpha.26 delays cheap. Beta.0 target independent.

## §15 Acceptance and next steps (revised)

Confirmation needed:

1. Alpha.26 is the right target (unchanged).
2. One-cycle deprecation window (unchanged; window widened from 2 to 3 weeks in v2.0).
3. Shim shape: `toMessages` + `sys(MessageContent)` + `usr(MessageContent)`, no `asst`. `sys` broadened in v3.0 for Anthropic caching.
4. Deprecation-warning UX: `"console" | "silent" | fn`; dedup key `(tag, method, adapter)`; no fingerprinting.
5. Conflict resolution: throw on `messages + prompt`; throw on `system-in-messages + instructions`; merge with warning on `instructions + messages-without-system`.
6. Strict system-role rules (v3.0): throw on multi-system or mid-conversation-system (§4.4).
7. Anthropic `cache_control` composition rule table (v3.0, §4.6).
8. Multi-turn structured-output policy: rules S1/S2/S3 (§4.3).
9. OpenAI `developer` role: defer, adapter-internal.
10. Include `runAgent` in the unification: yes, non-negotiable.
11. Include `@llm-ports/capabilities` in the migration: yes; internal-only changes (v3.0).
12. **SalesCoach coordination (§9.6): Option C ratified v3.2.** Plan 30 continues on alpha.24; re-migrates during alpha.26 → alpha.27 window.
13. Timeline: 10.5 engineer-days, ~3-week alpha.26 → alpha.27 window.
14. Alpha.25 dependencies (§1.1): #53, #54, #55 land in alpha.25 before alpha.26 tag; if any slip, alpha.25 + alpha.26 slip together.

Once settled: file as GitHub issue against `baabakk/llm-ports` with milestone `alpha.26`. Amend Plan 30 v1.3 to v1.4 with the Option B Phase 4.0 target update in `Development_Plans.md`. Ship alpha.25 first. Publish alpha.26-rc.0 as soon as core + adapter changes stabilize. SalesCoach Phase 4 uses rc-branch. Tag alpha.26 release. Run 3-week migration window for BEPA/HomeSignal/ADW to also migrate. Tag alpha.27.

---

## Appendix A: The full `LLMMessage` and `MessageContent` types

For reference; unchanged by this plan.

```ts
export type MessageRole = "system" | "user" | "assistant" | "tool";  // llm-port.ts:33

export interface LLMMessage {
  role: MessageRole;
  content: MessageContent;
}

export type MessageContent = string | ContentBlock[];

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | AudioBlock
  | ToolUseBlock
  | ToolResultBlock;
```

## Appendix B: Full draft of the shared normalizer

```ts
// packages/core/src/utils/normalize-messages.ts

import { LLMMessage, MessageContent } from "../ports/llm-port.js";
import {
  MessagesRequiredError,
  EmptyMessagesError,
  MessagesConflictError,
  PromptRequiredError,
  NonContiguousSystemError,
} from "../errors.js";

export interface DeprecationEvent {
  tag: "legacy-instructions-prompt" | "instructions-alongside-messages" | "runagent-instructions";
  method: "generateText" | "generateStructured" | "streamText" | "streamStructured" | "runAgent";
  adapter?: string;
  message: string;
  seenBefore: boolean;
}

export type DeprecationWarningMode =
  | "console"
  | "silent"
  | ((event: DeprecationEvent) => void);

const seenWarnings = new WeakMap<object, Set<string>>();

export function emitDeprecationWarning(
  registryKey: object,
  event: Omit<DeprecationEvent, "seenBefore">,
  mode: DeprecationWarningMode = "console",
): void {
  const seen = seenWarnings.get(registryKey) ?? new Set<string>();
  const key = `${event.tag}:${event.method}:${event.adapter ?? "registry"}`;
  const seenBefore = seen.has(key);
  seen.add(key);
  seenWarnings.set(registryKey, seen);

  const fullEvent: DeprecationEvent = { ...event, seenBefore };
  if (mode === "silent") return;
  if (typeof mode === "function") {
    mode(fullEvent);
    return;
  }
  if (!seenBefore) {
    console.warn(`[llm-ports] ${event.message}`);
  }
}

/**
 * Enforces the strict system-role discipline from §4.4.
 * Called at every return path of normalizeCallMessages.
 * Also enforces the empty-array rule.
 */
export function validateMessagesShape(messages: LLMMessage[]): void {
  if (messages.length === 0) throw new EmptyMessagesError();

  const systemIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") systemIndexes.push(i);
  }

  if (systemIndexes.length > 1) {
    throw new NonContiguousSystemError(
      `Multiple system-role messages found at indexes [${systemIndexes.join(", ")}]. ` +
        `The port accepts zero or one system message at index 0. Merge into a single string before calling.`,
    );
  }

  if (systemIndexes.length === 1 && systemIndexes[0] !== 0) {
    throw new NonContiguousSystemError(
      `System-role message found at index ${systemIndexes[0]} but must be at index 0. ` +
        `Mid-conversation system messages are not portable across providers.`,
    );
  }
}

export function normalizeCallMessages(opts: {
  instructions?: string;
  prompt?: MessageContent;
  messages?: LLMMessage[];
  __registryKey?: object;
  __method?: DeprecationEvent["method"];
  __adapter?: string;
  __deprecationMode?: DeprecationWarningMode;
}): LLMMessage[] {
  const hasMessages = opts.messages !== undefined;
  const hasPrompt = opts.prompt !== undefined;
  const hasInstructions =
    typeof opts.instructions === "string" && opts.instructions.length > 0;

  if (hasMessages && hasPrompt) {
    throw new MessagesConflictError(
      "Both `messages` and `prompt` are set. `prompt` is deprecated; use `messages` only.",
    );
  }

  let normalized: LLMMessage[];

  if (hasMessages && hasInstructions) {
    const hasSystemInMessages = opts.messages!.some((m) => m.role === "system");
    if (hasSystemInMessages) {
      throw new MessagesConflictError(
        "`messages` contains a system-role turn and `instructions` is also set. Use one.",
      );
    }
    // Grace: prepend instructions as a system message + warn.
    if (opts.__registryKey && opts.__method) {
      emitDeprecationWarning(
        opts.__registryKey,
        {
          tag: "instructions-alongside-messages",
          method: opts.__method,
          adapter: opts.__adapter,
          message: `\`instructions\` alongside \`messages\` is deprecated. Move it into a system-role message.`,
        },
        opts.__deprecationMode,
      );
    }
    normalized = [{ role: "system", content: opts.instructions! }, ...opts.messages!];
  } else if (hasPrompt) {
    if (opts.__registryKey && opts.__method) {
      emitDeprecationWarning(
        opts.__registryKey,
        {
          tag: "legacy-instructions-prompt",
          method: opts.__method,
          adapter: opts.__adapter,
          message: `\`instructions\`/\`prompt\` are deprecated; use \`messages\`.`,
        },
        opts.__deprecationMode,
      );
    }
    normalized = toMessages(opts.instructions, opts.prompt!);
  } else if (hasMessages) {
    normalized = opts.messages!;
  } else {
    throw new MessagesRequiredError();
  }

  validateMessagesShape(normalized);  // Single validator, single return.
  return normalized;
}

export function toMessages(
  instructions: string | undefined,
  prompt: MessageContent,
): LLMMessage[] {
  if (prompt === undefined || prompt === null) throw new PromptRequiredError();
  const out: LLMMessage[] = [];
  if (typeof instructions === "string" && instructions.length > 0) {
    out.push({ role: "system", content: instructions });
  }
  out.push({ role: "user", content: prompt });
  return out;
}

export function sys(content: MessageContent): LLMMessage {
  return { role: "system", content };
}

export function usr(content: MessageContent): LLMMessage {
  return { role: "user", content };
}
```

## Appendix C: Migration example strip (revised to include runAgent)

Before (alpha.25):
```ts
// The four non-agent methods
port.generateStructured({
  taskType: "sms-triage",
  instructions: SMS_TRIAGE_SYSTEM_PROMPT,
  prompt: rawSmsBody,
  schema: SmsTriageSchema,
  temperature: 0.1,
});

// runAgent
port.runAgent({
  taskType: "coding-agent",
  instructions: CODER_SYSTEM_PROMPT,       // required today
  messages: conversationHistory,
  tools: coderToolset,
});
```

After alpha.26 mechanical (shim):
```ts
port.generateStructured({
  taskType: "sms-triage",
  messages: toMessages(SMS_TRIAGE_SYSTEM_PROMPT, rawSmsBody),
  schema: SmsTriageSchema,
  temperature: 0.1,
});

port.runAgent({
  taskType: "coding-agent",
  messages: [sys(CODER_SYSTEM_PROMPT), ...conversationHistory],
  tools: coderToolset,
});
```

After alpha.26 idiomatic:
```ts
port.generateStructured({
  taskType: "sms-triage",
  messages: [sys(SMS_TRIAGE_SYSTEM_PROMPT), usr(rawSmsBody)],
  schema: SmsTriageSchema,
  temperature: 0.1,
});

port.runAgent({
  taskType: "coding-agent",
  messages: [sys(CODER_SYSTEM_PROMPT), ...conversationHistory],
  tools: coderToolset,
});
```

After alpha.26 multi-turn (interview agent):
```ts
port.generateStructured({
  taskType: "interview-turn",
  messages: conversationHistory,  // pre-built LLMMessage[] with full context, incl. system
  schema: InterviewTurnSchema,
  temperature: 0.4,
});
```

---

End of plan v3.2.
