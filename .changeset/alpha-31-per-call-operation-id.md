---
"@llm-ports/core": patch
---

Alpha.31 — per-call `operation_id` precedence via `withObservabilityContext(port, ctx)`.

Alpha.29 shipped `Instrumentation.context.operation_id` as a Registry-level (config-time) pinning slot. That works for setups that want one id per Registry instance, but it doesn't let a caller pin a per-call id — every `RegistryPort.generateText(...)` / `runAgent(...)` / `streamText(...)` invocation minted a fresh id regardless of what the caller wrapped the port with.

Alpha.31 extends the precedence chain to honor a per-call `ObservabilityContext` attached to the port instance via `withObservabilityContext(port, { operation_id })`. The Registry's five port methods now pass `getObservabilityContext(this)` into `withOperation` / `startOperation`, which check that caller-supplied context first before falling back to Registry-level `Instrumentation.context.operation_id` and finally to a freshly minted id.

**New precedence chain (any of the three levels may be present or absent):**

1. `withObservabilityContext(port, { operation_id }).method(...)` — the caller's id lands on every emitted lifecycle event for that call.
2. Registry-level `Instrumentation.context.operation_id` — the alpha.29 behavior, preserved.
3. Fresh mint via `newOperationId()` — the pre-alpha.29 behavior, still the default for uninstrumented consumers.

**API changes.** `startOperation` and `withOperation` each gain an optional final parameter `perCallContext?: ObservabilityContext`. Existing callers who don't pass it see zero behavior change.

**BEPA unblocker.** BEPA's Plan 58 §5.4 slice 3b (quality-tracker re-key on `operation_id`) was blocked on this change. With alpha.31, BEPA's capability wrappers can pre-mint an id, wrap the port with `withObservabilityContext(getLLMPort(), { operation_id: minted })`, and have that id flow through the full contract lifecycle — enabling cross-store joins between quality-tracker Redis entries, incident-logger `entity_events` rows, and OTel spans by shared `operation_id`.

**Verified.** 9 new tests in `packages/core/tests/per-call-operation-id.test.ts` cover the four precedence conditions (per-call only, Registry-level only, neither, both) across all five port methods (`generateText`, `generateStructured`, `runAgent`, `streamText`, `streamStructured`), plus a distinct-per-call-ids case. Core 586/586 (was 577 + 9 new). Full workspace green (12 packages, zero regressions).

**Non-breaking.** Purely additive. Consumers who don't wrap the port for per-call context see identical behavior; the third argument on `startOperation` / `withOperation` is optional and defaults to undefined.
