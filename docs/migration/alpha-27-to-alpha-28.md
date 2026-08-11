# Migrating from alpha.27 to alpha.28

> **Impact:** None — fully additive release. Bump peer deps and consume the new surface at your own pace.

## Install

```bash
pnpm add @llm-ports/core@alpha @llm-ports/observability-contract@alpha \
         @llm-ports/adapter-openai@alpha @llm-ports/adapter-anthropic@alpha \
         @llm-ports/adapter-google@alpha @llm-ports/adapter-ollama@alpha \
         @llm-ports/adapter-vercel@alpha @llm-ports/adapter-codex@alpha \
         @llm-ports/adapter-aider@alpha @llm-ports/capabilities@alpha
```

Ten publishable packages at `0.1.0-alpha.28`. Three of those are net-new packages first published in this release.

## What actually changed

**In one sentence:** the observability data model gets its own standalone package (`@llm-ports/observability-contract`) so callers can construct and emit conformant events without pulling in the registry; the core gains a scoped-port wrapper (`withObservabilityContext`) and three new typed error classes; two subprocess-driven agent adapters join the family (Codex, Aider). No public API is removed or renamed.

**In slightly more detail:**

### New package: `@llm-ports/observability-contract`

Zero peer dependency on `@llm-ports/core`. Purpose: any consumer (a Registry, a bespoke wrapper, a non-port caller wrapping a subprocess CLI) can construct `ObservabilityEvent<TType, TData>` values using this package's types and hand them to any `ObservabilitySink` without importing the registry.

Ships (the full list, so you can see what's now on the shelf):

- Event envelope (`ObservabilityEvent<TType, TData>`) with `spec_version`, `event_id`, `event_type`, `occurred_at`, `emitted_at`, `source`, `operation_id`, `attempt_id`, `parent_operation_id`, `trace_context`, `sequence`, and `data`.
- Correlation model splitting logical operation identity from physical attempt identity (`CorrelationContext`, `ObservabilityContext`).
- `ObservabilitySink { emit(event) }` interface, `noopSink`, `createCollectingSink()`.
- W3C Trace Context + Baggage (string-header form, ≤64 members, ≤8192 bytes).
- Nanoid-based ID helpers: `newEventId`, `newOperationId`, `newAttemptId`, `newEvaluationId`.
- 9 lifecycle event types (`llm.operation.started`, `llm.attempt.started`, `llm.attempt.completed`, `llm.attempt.failed`, `llm.attempt.retry_scheduled`, `llm.fallback.selected`, `llm.operation.completed`, `llm.operation.failed`, `llm.operation.cancelled`) + 4 agent-step event types.
- `ErrorInfo` shape + `CauseCategory` (8-value rollup) + static `ERROR_TYPE_TO_CATEGORY` map + `errorTypeToCauseCategory()` resolver.
- Nested `CacheStats { provider_cache?, semantic_cache? }` plus helpers.
- `RequestFingerprint` canonicalization rules v1 (NFC, LF, sorted keys, 16 allowed request keys) + SHA-256 / HMAC-SHA-256 primitives + `computeRequestFingerprint` helper + golden vectors.
- `EvaluationRef` + `EvaluationTarget` discriminated union (7 kinds) + `EvaluationScore` discriminated union (4 shapes).
- `CapturePolicy` shape + `DEFAULT_CAPTURE_POLICY` (strict, content off) + `PERMISSIVE_CAPTURE_POLICY` (debug-mode, content on).
- Full Zod schema catalog + `eventSchemaFor()` factory + `anyObservabilityEventSchema`.
- `buildEvent`, `emitLifecycleEvent`, `emitEvaluation`, `emitRaw` helpers.

Nothing in this package fires from anywhere in the runtime yet. Runtime instrumentation lands in alpha.29.

### `@llm-ports/core` additions

- **`withObservabilityContext(port, context)`** — Proxy-based scoped-port wrapper. Merges caller-supplied `CorrelationContext` + `TraceContext` + `Baggage` into a port-scoped context that adapters can retrieve via `getObservabilityContext(port)`. WeakMap-stored.
- **Three new typed error classes**:
  - `CreditExhaustionError` — provider returned 402 or an insufficient-balance body. Walk-worthy under `defaultShouldFallback`.
  - `ProviderMalformed400Error extends BadRequestError` — 400 caused by the provider's request-schema drift, not the caller. Walk-worthy.
  - `AdapterInternalError` — an adapter-internal JS runtime error (a `TypeError`, `ReferenceError`, `SyntaxError`, or the adapter's own defensive throw). Abort-worthy.
- **`defaultShouldFallback(err)` policy function** — canonical walk-table semantics. Walk-worthy: `RateLimitError`, `ServiceUnavailableError`, `CreditExhaustionError`, `ProviderMalformed400Error`, `ContextWindowExceededError`, `ContentPolicyViolationError`, `ImageTooLargeError`, `ContentBlockUnsupportedError`. Abort-worthy: `AuthenticationError`, generic `BadRequestError`, `AdapterInternalError`, `InvalidImageUrlError`, contract errors.
- Fixes: `wrapProviderError` now propagates `modelId` into `ContextWindowExceededError` and `ContentPolicyViolationError` (`TD-LLMP-16`); defensive `tools: {}` default on `runAgent` + local JS runtime errors classified as `AdapterInternalError` (`TD-LLMP-17`); `attemptValidationRepair` normalizes Unicode confusables (curly hyphens, quotes, and unusual spaces) on `invalid_enum_value` retries (`TD-LLMP-18`).

### New package: `@llm-ports/adapter-codex`

Subprocess-driven adapter for OpenAI Codex CLI. Runs `codex exec --json --cd DIR -m MODEL -s SANDBOX PROMPT` as a subprocess and parses codex's line-delimited JSON output. Exposes only `runAgent` on its port surface; `generateText` / `generateStructured` / `streamText` / `streamStructured` throw `AdapterInternalError` (Codex is an agent runtime, not a raw-completion runtime).

`providerExtras.codex` on `RunAgentOptions`:

```ts
providerExtras: {
  codex: {
    workingDirectory: string;                 // required
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    autoApprove?: boolean;                    // --dangerously-bypass-approvals-and-sandbox
    model?: string;                           // -m MODEL
    imageFiles?: string[];                    // -i IMAGE (repeatable)
  }
}
```

**Shape A passthrough governance:** the operator supplies codex with its own OpenAI credentials (env vars or `~/.codex/auth.toml`). `@llm-ports` does NOT route codex's LLM traffic; the adapter owns lifecycle observability only.

### New package: `@llm-ports/adapter-aider`

Subprocess-driven adapter for the Aider CLI. Runs `aider --no-stream --yes-always --message "<prompt>" [files...]` with `cwd` set to `providerExtras.aider.workingDirectory`. Same shape: `runAgent`-only surface, other methods throw. Same Shape A passthrough governance.

`providerExtras.aider` on `RunAgentOptions`:

```ts
providerExtras: {
  aider: {
    workingDirectory: string;                 // required
    files?: string[];                         // positional file args
    model?: string;                           // --model MODEL
    editFormat?: string;                      // --edit-format FMT
    yesAlways?: boolean;                      // --yes-always (default true)
    verbose?: boolean;                        // --verbose
    mapTokens?: number;                       // --map-tokens N
  }
}
```

## Migration steps

There are no code changes required. The migration is:

1. Update `package.json` peer deps for every `@llm-ports/*` you consume:
   - `"@llm-ports/core": "^0.1.0-alpha.28"`
   - `"@llm-ports/adapter-openai": "^0.1.0-alpha.28"` (and any other adapters you use)
   - Add `"@llm-ports/observability-contract": "^0.1.0-alpha.28"` if you plan to construct observability events (optional).
2. `pnpm install` (or `npm install`).
3. `pnpm build` — confirm nothing broke.

That's it.

## Consuming the new observability contract

Alpha.28 ships the types but not the emission. Nothing in the Registry fires yet. If you want to emit conformant events from your own code paths right now (e.g. from a custom retry loop, a subprocess-driven agent, or a non-port pipeline), the contract package's `buildEvent` + `emitLifecycleEvent` helpers are ready:

```ts
import {
  buildEvent,
  createCollectingSink,
  newOperationId,
  type EmitterConfig,
} from "@llm-ports/observability-contract";

const sink = createCollectingSink();
const config: EmitterConfig = {
  sink,
  source: { library: "my-app", library_version: "1.0.0" },
};

const operationId = newOperationId();
const event = buildEvent(
  config,
  "llm.operation.started",
  { operation_id: operationId },
  { task_type: "triage", method: "generateText", provider_chain: ["openai"] },
);
sink.emit(event);
```

Registry-driven emission (no manual construction) lands in alpha.29.

## When to consider adopting

- **You're on a legacy release (alpha.27 or earlier).** Bump. Everything is additive.
- **You want the new error classes.** `CreditExhaustionError`, `ProviderMalformed400Error`, `AdapterInternalError` are useful for finer-grained failure classification.
- **You have a subprocess-driven agent (Codex, Aider) in your infrastructure.** The new adapters give you a uniform `LLMPort.runAgent` surface for them.
- **You want to build custom observability plumbing today** without waiting for the Registry to emit natively (that arrives in alpha.29).

## Downgrade / rollback

Trivial: revert the version pins to `0.1.0-alpha.27`. Nothing else to undo.
