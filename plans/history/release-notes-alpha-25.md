# @llm-ports v0.1.0-alpha.25 — Observability surface + reliability hardening

**Released 2026-07-02.** Install: `pnpm add @llm-ports/core@alpha @llm-ports/adapter-openai@alpha`

Three additive features under one release theme. Zero breaking changes. All existing code compiles and runs unmodified.

---

## What's in this release

### 1. `refs?: Record<string, ArtifactRef>` on every call ([#53](https://github.com/baabakk/llm-ports/issues/53))

A consumer-owned, keyed map of artifact references that flows through to every observability event (`onCost`, `onTokenUsage`, `onFallback`, `onCacheHit`, `onValidationRetry`) unchanged. Use it for prompt versioning, cost attribution by tenant / project / experiment, session correlation — any versioned or identifiable artifact you want stamped onto trace.

```ts
import type { ArtifactRef } from "@llm-ports/core";

port.generateStructured({
  taskType: "extract",
  prompt: input,
  schema: MySchema,
  refs: {
    prompt:  { key: "extractor-v3", version: 3, hash: "sha256:..." },
    tenant:  { key: "acme-corp" },
    session: { key: "sess-abc123" },
  },
});
```

The observability side reads them back cleanly:

```ts
const registry = createRegistryFromEnv({
  observability: {
    onCost: (e) => audit.recordCost({
      totalUsd:      e.totalUsd,
      promptVersion: e.refs?.prompt?.version,
      tenant:        e.refs?.tenant?.key,
    }),
  },
});
```

**Non-goals (guarded against scope creep):** not validated, not sent to the model, not read by adapters, no vocabulary standardization, no merging or inheritance across nested `runAgent` calls. Pure consumer-owned trace metadata.

### 2. `runtimeFallback: "aggressive"` preset ([#54](https://github.com/baabakk/llm-ports/issues/54), LP-REQ-01)

Three consumers (BEPA Plan 29, HomeSignal, SalesCoach Plan 30) each rebuilt the same classifier by hand. Bundled as a preset:

```ts
const registry = createRegistryFromEnv({
  adapters: { /* ... */ },
  runtimeFallback: "aggressive",
});
```

**Walks on** (in addition to the default `ProviderUnavailableError`):
- `RateLimitError` — try next provider rather than wait out backoff
- `EmptyResponseError` — adapter's own retries gave up
- `ContextWindowExceededError` — try a larger-window provider
- `BadRequestError` matching credit-exhaustion body patterns (`credit balance is too low`, `insufficient funds`, `account disabled`, `billing`, `exceeded your current quota`, `out of credits`, `payment required`, `organization has been deactivated`)
- Raw error with `status >= 500` (defensive)

**Does NOT walk on** `AuthenticationError`, generic `BadRequestError` (malformed request), `ContentPolicyViolationError`, `BudgetExceededError`, `SessionBudgetExceededError`.

Classifier + credit-pattern list exported for composition:

```ts
import { aggressiveShouldFallback, AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS } from "@llm-ports/core";
```

### 3. Streamed cost surfacing ([#55](https://github.com/baabakk/llm-ports/issues/55))

`onCost` and `onTokenUsage` now fire once per stream at natural completion for `streamText` and `streamStructured` — matching the non-streaming contract. Enabled by default in `adapter-openai` via `stream_options: { include_usage: true }`.

```ts
for await (const chunk of registry.getPort().streamText({
  taskType: "chat",
  prompt: "hello",
  refs: { session: { key: "sess-abc123" } },
})) {
  ui.append(chunk);
}
// onCost + onTokenUsage fired once at completion with refs.session.key preserved.
```

**Semantics:**
- Emit ONCE per stream, at natural completion.
- Mid-stream errors do NOT emit.
- Consumer-cancelled streams (via `AbortSignal`) do NOT emit.
- Opt out per adapter with `createOpenAIAdapter({ streamUsage: false })` for compat providers that reject `stream_options`.

**Adapter coverage:** `adapter-openai` in this release. Other adapters (`adapter-anthropic`, `adapter-google`, `adapter-ollama`, `adapter-vercel`) follow in patch releases as their SDK's stream-completion metadata surface is wired.

---

## Backwards compatibility

All three features are opt-in. Existing code compiles and runs unchanged. No new imports required unless you want to use the new features.

## Tests

- 8 refs tests
- 23 aggressive-fallback tests (positive + negative per error class + Registry integration)
- 5 streamed-cost tests (callback firing, no-op path, mid-stream error path, refs preservation, streamStructured parity)
- **864 total (was 828; +36; 0 regressions)**

---

## ⚠️ What's next: alpha.26 is BREAKING

The next release will be a **BREAKING API unification** to align the port with every provider's native protocol. The four generation methods (`generateText` / `generateStructured` / `streamText` / `streamStructured`) will move from `{ instructions, prompt }` to a canonical `messages: LLMMessage[]` input.

**Why:** consumers with multi-turn workloads (chat, interview agents, coaching workflows) currently have three bad workarounds — roll conversation history into a string (loses role fidelity), abuse `runAgent` with an empty tools object (semantically broken), or reach past the port via `providerExtras` (bypasses the abstraction). None are acceptable. Aligning the port with the underlying protocol (which every provider speaks natively) fixes this and matches `runAgent`'s existing shape.

**Migration path:**
- **alpha.26:** ships `{ messages, ... }` alongside `{ instructions, prompt, ... }`. Existing fields marked `@deprecated`. Deprecation warnings emit with fingerprint dedup (one warning per unique call site per Registry). A one-line migration shim ships: `toMessages(instructions, prompt)` returns the equivalent messages array. Plus convenience helpers `sys(content)` and `usr(content)`.
- **alpha.27** (~2 weeks later): removes the deprecated fields. TypeScript compilation error if consumers haven't migrated.

**Migration examples (planned):**

```ts
// alpha.25 (current)
port.generateText({
  taskType: "triage",
  instructions: SYSTEM_PROMPT,
  prompt: userInput,
});

// alpha.26 mechanical (via shim, one-line change)
port.generateText({
  taskType: "triage",
  messages: toMessages(SYSTEM_PROMPT, userInput),
});

// alpha.26 idiomatic (via helpers)
port.generateText({
  taskType: "triage",
  messages: [sys(SYSTEM_PROMPT), usr(userInput)],
});

// alpha.26 native (multi-turn, previously unavailable)
port.generateStructured({
  taskType: "interview-turn",
  schema: InterviewTurnSchema,
  messages: conversationHistory,  // full context; no workaround needed
});
```

Full plan and open design questions in the alpha.26 planning discussion. If you have a workload that would be affected, comment there — feedback informs the deprecation window and shim shape.

---

[Full release notes](https://github.com/baabakk/llm-ports/releases/tag/v0.1.0-alpha.25) | [alpha.24 → alpha.25 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-24-to-alpha-25.md) | [Observability concept](https://github.com/baabakk/llm-ports/blob/main/docs/concepts/observability.md)
