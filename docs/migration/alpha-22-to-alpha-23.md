# Migrating from alpha.22 to alpha.23

> **Zero breaking changes — runtime AND type-level.** alpha.23 is fully additive. Existing code compiles and runs without modification.

## Install

```bash
pnpm add @llm-ports/core@alpha @llm-ports/adapter-openai@alpha
```

All 7 publishable packages are bumped to `0.1.0-alpha.23`.

## What was added

### 1. Harmony tool-call extraction (adapter-openai)

When the model's `tool_calls` array is empty AND the response includes a non-empty `message.reasoning_content` containing a parseable harmony tool call, the adapter extracts and executes it automatically. No code change required to consume — the improvement kicks in for any `runAgent` call.

**Impact**: DeepInfra-served `openai/gpt-oss-120b` tool-use now works end-to-end in `runAgent`. Pre-alpha.23, the loop terminated as `completed` with no executable output because the tool intent landed in the wrong channel. Post-alpha.23, the tool call executes.

The harmony parser is also exported for direct use:

```ts
import { parseHarmonyToolCalls } from "@llm-ports/adapter-openai";

const calls = parseHarmonyToolCalls(reasoningContentString);
// returns OpenAIToolCall[] or null when no parseable harmony tool call is found
```

### 2. Zero-tool-call corrective rescue (adapter-openai)

When the model returns prose content with empty `tool_calls` and the request had a tools array, the adapter retries once with a corrective system message asking the model to use the standard tool_calls format. No code change required to consume.

**Impact**: Models that emit prose explaining what they "would do" instead of actually calling tools now get one rescue retry. mimo-parasail in the multi-team agentic-build prompt that ADW diagnosed is the canonical case.

**Discriminators that prevent over-firing** (so you don't see unexpected retries):

- No tools in request → skip
- `tool_calls` populated → skip
- Empty content → reasoning starvation case; handled by the alpha.22 path
- `reasoning_content` populated → harmony case; handled by extraction above
- Conversation includes a `role: "tool"` message → model is summarizing tool results, not failing → skip

### 3. Telemetry tags (`@llm-ports/core`)

Two new values on the existing `RetryReason` union:

```ts
type RetryReason =
  | "transient-auth"
  | "capability-fallback"
  | "reasoning-starvation"
  | "validation-feedback"
  | "harmony-tool-call-extracted"     // alpha.23+ (ASK 1 fired)
  | "zero-tool-call-prose-retry";     // alpha.23+ (ASK 2 fired)
```

Filter the existing adapter `onRetry` hook to distinguish rescue events:

```ts
const adapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  onRetry: (e) => {
    if (e.reason === "harmony-tool-call-extracted") {
      myMetrics.harmonyRescues.inc({ model: e.modelId });
    } else if (e.reason === "zero-tool-call-prose-retry") {
      myMetrics.proseRescues.inc({ model: e.modelId });
    }
  },
});
```

### 4. Per-attempt timeout (`@llm-ports/core`)

`RegistryOptions.perAttemptTimeoutMs` wraps every provider attempt inside `walkChain` with an `AbortController` + timer. On timeout, the abort propagates to the adapter; the adapter throws `ProviderUnavailableError`; the Registry's `shouldFallback` catches it and walks to the next provider with a fresh timer.

```ts
const registry = createRegistryFromEnv({
  env: process.env,
  adapters: { /* ... */ },
  perAttemptTimeoutMs: 30000, // 30s cap per provider attempt
});
```

**Per-attempt, not chain-wide.** A 30s timeout against a 3-provider chain caps total wall-clock at ~90s, but any single provider can't exceed 30s. Critical for routing around reasoning models that grind on hidden chain-of-thought without erroring.

**Composes with user-supplied `signal`.** Both fire the same wrapped controller; the shorter trigger wins.

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000); // user-side 5s cap

await registry.getPort().generateText({
  taskType: "...",
  prompt: "...",
  signal: controller.signal,
});
// Either user signal (5s) or per-attempt timeout (30s) fires, whichever first.
```

When both `perAttemptTimeoutMs` is undefined AND there's no user signal, the wrapper is a pass-through (no AbortController created).

## What did NOT change

- All public types and interfaces unchanged.
- Existing call patterns unchanged.
- `@llm-ports/capabilities` factories unchanged.
- All other adapters (anthropic, google, ollama, vercel) unchanged — they get a version bump to keep the `@alpha` tag synchronized but no behavior change.

## Should you do anything?

If you're upgrading from alpha.22 with no changes, nothing breaks. Pick from these on your own schedule:

| If you want… | Do this |
|---|---|
| DeepInfra gpt-oss harmony tool-use to work | Just upgrade — automatic |
| Mimo / similar prose-only failures to retry | Just upgrade — automatic |
| Telemetry on which rescue path fired | Filter your existing adapter `onRetry` hook on the new `RetryReason` values |
| Provider-grind protection | Set `perAttemptTimeoutMs` on the Registry |
| All four | Upgrade + set `perAttemptTimeoutMs` |

## What this release does NOT fix

The Case B "under-production" pattern (model makes some tool calls, then stops with the planned manifest incomplete) is NOT addressed at the adapter layer. The adapter sees a clean multi-call completion; only the orchestration knows the manifest is incomplete.

If you're building an agentic orchestrator (ADW-style), add a "planned ≠ written" guard at the workflow layer that compares the planned file/action manifest against what actually got executed. The adapter cannot do this for you because it doesn't have orchestration context.

## Reference

- [Release notes](https://github.com/baabakk/llm-ports/releases/tag/v0.1.0-alpha.23) | [Discussion #51](https://github.com/baabakk/llm-ports/discussions/51)
- [ADW Development_Logs.md b1eeee2](https://github.com/baabakk/agentic_development_worker/commit/b1eeee2) — empirical motivation
- [Issue #46](https://github.com/baabakk/llm-ports/issues/46) — design discussion
