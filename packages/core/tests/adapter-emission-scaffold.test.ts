/**
 * Alpha.30 — §2.4 adapter-emission scaffold.
 *
 * Verifies:
 *   - The Registry stamps `operation_handle` onto every downstream
 *     port call via `withObservabilityContext(port, {...})`.
 *   - Adapters that call `resurrectOperationContext(this)` inside
 *     their port method see the running OperationContext, correctly
 *     correlated with the outer operation.
 *   - Direct-adapter calls (bypassing the Registry) return undefined
 *     from resurrection — the adapter's own withOperation is expected
 *     in that case.
 *   - Handle registry cleanup: the OperationContext isn't retrievable
 *     after the operation completes.
 *   - The operation_id on the plumbed context matches the outer
 *     operation's id (round-trip check).
 */

import { describe, expect, it } from "vitest";
import {
  createRegistryFromEnv,
  getObservabilityContext,
  resurrectOperationContext,
  withObservabilityContext,
  withOperation,
  type AdapterRegistration,
  type GenerateTextResult,
  type Instrumentation,
  type LLMPort,
  type ModelPricing,
  type OperationContext,
} from "../src/index.js";
import { createCollectingSink, type EventSource } from "@llm-ports/observability-contract";

const HAIKU_PRICING: ModelPricing = { inputPer1M: 0.8, outputPer1M: 4.0 };
const testSource: EventSource = { library: "test", library_version: "0.0.0" };

// Adapter whose generateText captures the resurrected context so the
// test can inspect it. Also captures the raw ObservabilityContext
// for the round-trip operation_id check.
function makeInspectingAdapter(): {
  adapter: AdapterRegistration;
  seen: {
    context?: ReturnType<typeof getObservabilityContext>;
    opCtx?: OperationContext;
  };
} {
  const seen: {
    context?: ReturnType<typeof getObservabilityContext>;
    opCtx?: OperationContext;
  } = {};
  const adapter: AdapterRegistration = {
    name: "anthropic",
    pricing: { "claude-haiku-4-5": HAIKU_PRICING },
    createLLMPort: (modelId, alias): LLMPort => {
      const port: LLMPort = {
        async generateText(): Promise<GenerateTextResult> {
          // Adapters read the plumbed context on `this` — but our port
          // object is a fresh object per createLLMPort call. The
          // Registry's scoped wrapper wraps the exact port object that
          // sel.port refers to. Since the closure sees `port`, we
          // capture via the same reference the wrapped port proxies.
          // In practice the adapter reads it off the port the Registry
          // called into (the wrapped one).
          seen.context = getObservabilityContext(wrappedRef.value ?? port);
          seen.opCtx = resurrectOperationContext(wrappedRef.value ?? port);
          return {
            text: "ok",
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
            cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
            modelId,
            providerAlias: alias,
            latencyMs: 1,
          };
        },
        async generateStructured() {
          throw new Error("not used");
        },
        async runAgent() {
          throw new Error("not used");
        },
        streamText: async function* () {
          yield "";
        },
        streamStructured: async function* () {
          yield {} as never;
        },
      };
      // The Registry wraps `port` via `withObservabilityContext` before
      // calling into the adapter's method. Since the wrapper returns a
      // Proxy, the inspector needs a reference to the wrapped instance
      // to read the context. Trick: shim by intercepting `generateText`
      // via a Proxy-aware detection — capture whatever port instance
      // ends up hosting the method invocation.
      const wrappedRef: { value?: LLMPort } = {};
      const spy = new Proxy(port, {
        get(target, prop, receiver) {
          if (prop === "generateText") {
            return (opts: never) => {
              // At this point `receiver` is the outer proxy (the wrapped
              // port the Registry made). Capture it so the inner call
              // can read the context.
              wrappedRef.value = receiver as LLMPort;
              return port.generateText.call(receiver, opts);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return spy;
    },
  };
  return { adapter, seen };
}

// ─── End-to-end: Registry stamps handle; adapter resurrects opCtx ───

describe("Adapter-emission scaffold — Registry → handle → adapter resurrection", () => {
  it("stamps operation_id AND operation_handle onto the wrapped port", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = { config: { sink, source: testSource } };
    const { adapter, seen } = makeInspectingAdapter();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: adapter },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(seen.context?.operation_id).toBeTypeOf("string");
    expect(seen.context?.operation_handle).toBeTypeOf("string");
  });

  it("operation_id on the plumbed context matches the emitted lifecycle events", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = { config: { sink, source: testSource } };
    const { adapter, seen } = makeInspectingAdapter();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: adapter },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    // Every emitted event carries the same operation_id.
    const eventOpIds = new Set(sink.events.map((e) => e.operation_id));
    expect(eventOpIds.size).toBe(1);
    // And it matches what the adapter saw on the plumbed context.
    expect(seen.context!.operation_id).toBe([...eventOpIds][0]);
  });

  it("resurrectOperationContext returns an OperationContext with matching operationId + handle", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = { config: { sink, source: testSource } };
    const { adapter, seen } = makeInspectingAdapter();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: adapter },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(seen.opCtx).toBeDefined();
    expect(seen.opCtx!.operationId).toBe(seen.context!.operation_id);
    expect(seen.opCtx!.handle).toBe(seen.context!.operation_handle);
  });

  it("does NOT stamp a handle when instrumentation is not configured", async () => {
    const { adapter, seen } = makeInspectingAdapter();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: adapter },
      // no instrumentation
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    // The adapter's port was never wrapped by the Registry.
    expect(seen.context).toBeUndefined();
    expect(seen.opCtx).toBeUndefined();
  });
});

// ─── resurrectOperationContext direct-call semantics ────────────────

describe("resurrectOperationContext — direct-call semantics", () => {
  it("returns undefined for a bare port with no observability context", () => {
    const bare: LLMPort = {
      async generateText() {
        throw new Error("nu");
      },
      async generateStructured() {
        throw new Error("nu");
      },
      async runAgent() {
        throw new Error("nu");
      },
      streamText: async function* () {
        yield "";
      },
      streamStructured: async function* () {
        yield {} as never;
      },
    };
    expect(resurrectOperationContext(bare)).toBeUndefined();
  });

  it("returns undefined when the plumbed context has NO handle", () => {
    const bare: LLMPort = {
      async generateText() {
        throw new Error("nu");
      },
      async generateStructured() {
        throw new Error("nu");
      },
      async runAgent() {
        throw new Error("nu");
      },
      streamText: async function* () {
        yield "";
      },
      streamStructured: async function* () {
        yield {} as never;
      },
    };
    // Wrap with a context that has operation_id but no handle.
    const scoped = withObservabilityContext(bare, {
      operation_id: "op-external-abc",
    });
    // Handle was not set — resurrection returns undefined even though
    // an ObservabilityContext exists.
    expect(resurrectOperationContext(scoped)).toBeUndefined();
    // getObservabilityContext still returns the context.
    expect(getObservabilityContext(scoped)?.operation_id).toBe("op-external-abc");
  });

  it("returns undefined when the handle points to a completed operation (cleanup verified)", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = { config: { sink, source: testSource } };
    let capturedHandle: string | undefined;
    let capturedPort: LLMPort | undefined;
    await withOperation(
      instr,
      { taskType: "x", method: "generateText", providerChain: ["a"] },
      async (opCtx) => {
        capturedHandle = opCtx!.handle;
        // Simulate a port wrapped with the handle, capture the wrapped
        // reference so we can query resurrection AFTER the operation.
        const bare: LLMPort = {
          async generateText() {
            throw new Error("nu");
          },
          async generateStructured() {
            throw new Error("nu");
          },
          async runAgent() {
            throw new Error("nu");
          },
          streamText: async function* () {
            yield "";
          },
          streamStructured: async function* () {
            yield {} as never;
          },
        };
        capturedPort = withObservabilityContext(bare, {
          operation_id: opCtx!.operationId,
          operation_handle: capturedHandle,
        });
        // Inside the operation, resurrection returns the opCtx.
        expect(resurrectOperationContext(capturedPort)!.handle).toBe(capturedHandle);
      },
    );
    // After withOperation's finally runs, the handle registry has
    // been cleaned up. Resurrection returns undefined even though the
    // port still carries the operation_handle string.
    expect(resurrectOperationContext(capturedPort!)).toBeUndefined();
  });
});

// ─── mergeContext propagation ───────────────────────────────────────

describe("withObservabilityContext — operation_handle merge propagation", () => {
  it("propagates operation_handle through composition (later override)", () => {
    const bare: LLMPort = {
      async generateText() {
        throw new Error("nu");
      },
      async generateStructured() {
        throw new Error("nu");
      },
      async runAgent() {
        throw new Error("nu");
      },
      streamText: async function* () {
        yield "";
      },
      streamStructured: async function* () {
        yield {} as never;
      },
    };
    const s1 = withObservabilityContext(bare, {
      operation_id: "op-1",
      operation_handle: "h-1",
    });
    // A second wrap with a different handle overrides the earlier one.
    const s2 = withObservabilityContext(s1, { operation_handle: "h-2" });
    expect(getObservabilityContext(s2)?.operation_id).toBe("op-1"); // preserved
    expect(getObservabilityContext(s2)?.operation_handle).toBe("h-2"); // overridden
  });
});
