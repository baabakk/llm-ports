# @llm-ports/observability-contract

Standalone data contract for LLM observability. Zero peer dependency on `@llm-ports/core` so non-port callers can construct and emit conformant observability events without pulling in the registry.

## What this package contains

- **Event envelope** (`ObservabilityEvent<TType, TData>`): the canonical wrapper for every observability event. Carries version, identity, timing, source attribution, correlation, and W3C Trace Context.
- **Correlation model** (`CorrelationContext`, `ObservabilityContext`): splits logical operation identity (`operation_id`) from physical attempt identity (`attempt_id`). Caller-provided context flows in via the port's `withObservabilityContext(port, context)` scoped-port wrapper (which lives in `@llm-ports/core`).
- **Sink interface** (`ObservabilitySink`): the sole sink interface. `emit(event): void | Promise<void>`.
- **W3C Trace Context + Baggage**: string-header form (`traceparent` / `tracestate`), Baggage entry shape, and the W3C-mandated propagation thresholds (≤64 members AND ≤8192 bytes).
- **ID helpers**: nanoid-based `newEventId()`, `newOperationId()`, `newAttemptId()`, `newEvaluationId()`.
- **Version constant**: `SPEC_VERSION` for the envelope's `spec_version` field.

Subsequent alpha.28 commits add: lifecycle event types (§4.3), ErrorInfo shape (§4.4), CacheStats (§4.5), RequestFingerprint + canonicalization spec + golden vectors (§4.6), EvaluationRef + EvaluationTarget union (§4.9), CapturePolicy (§4.10), and the standalone emitter helpers (§4.13).

## What this package does NOT contain

- No runtime instrumentation. Adapters emit contract events via the port; this package defines the shape but does not fire the events. Runtime instrumentation lands in alpha.29.
- No storage adapters (SQLite, ClickHouse, OTel). Those are opt-in companion packages.
- No policy values. `CapturePolicy` (when it lands) is a shape; the values are per-consumer.
- No Node `EventEmitter` in the contract. `ObservabilitySink` is the sole sink interface. See `docs/using-eventemitter.md` for a 5-line adapter pattern.

## Non-port callers

The whole point of packaging this separately from `@llm-ports/core` is that a caller who does not construct an LLM port can still emit conformant observability events. For example, a caller wrapping a subprocess-driven agent runtime (Claude Code CLI, OpenAI Codex CLI) imports the types from this package, constructs `ObservabilityEvent<...>` values, and forwards them to any `ObservabilitySink`.

```typescript
import {
  createCollectingSink,
  newEventId,
  newOperationId,
  SPEC_VERSION,
  type ObservabilityEvent,
} from "@llm-ports/observability-contract";

const sink = createCollectingSink();
const operationId = newOperationId();

const startEvent: ObservabilityEvent<"llm.operation.started", { task_type: string }> = {
  spec_version: SPEC_VERSION,
  event_id: newEventId(),
  event_type: "llm.operation.started",
  occurred_at: new Date().toISOString(),
  emitted_at: new Date().toISOString(),
  source: { library: "my-custom-runner", library_version: "1.0.0" },
  operation_id: operationId,
  data: { task_type: "code-review" },
};

sink.emit(startEvent);
// sink.events now has one event with the same schema an @llm-ports/core-routed
// call would have emitted.
```

## Peer dependency

`zod` in the range `>=3.24.0 <5`. The Zod schemas (arriving in a follow-up commit) validate every event shape at consumer boundaries; the raw types compile without Zod at runtime.

## License

MIT.
