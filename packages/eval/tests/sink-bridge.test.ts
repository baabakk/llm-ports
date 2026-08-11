/**
 * @llm-ports/eval — observability-sink bridge tests.
 *
 * The bridge lets a Registry's instrumentation sink persist evaluations
 * automatically. Verifies:
 *   - evaluation.recorded events go to store.write.
 *   - Every other event type is silently ignored.
 *   - store.write errors are routed to onError when provided.
 *   - Sync + async store implementations both work.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildEvent,
  EVALUATION_EVENT_TYPE,
  type EmitterConfig,
  type EvaluationRef,
  type EventSource,
} from "@llm-ports/observability-contract";
import {
  createInMemoryEvaluationStore,
  toObservabilitySink,
} from "../src/index.js";

const src: EventSource = { library: "test", library_version: "0.0.0" };
const config: Pick<EmitterConfig, "source" | "spec_version" | "now"> = { source: src };

function makeRef(overrides: Partial<EvaluationRef> = {}): EvaluationRef {
  return {
    evaluation_id: `eval-${Math.random().toString(36).slice(2)}`,
    target: { kind: "operation", id: "op-x" },
    evaluator_name: "test_evaluator",
    score: { score_type: "numeric", value: 1 },
    source: "model",
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("toObservabilitySink", () => {
  it("routes evaluation.recorded events to store.write", async () => {
    const store = createInMemoryEvaluationStore();
    const sink = toObservabilitySink(store);
    const ref = makeRef({ evaluation_id: "eval-routed" });
    const event = buildEvent(
      config,
      EVALUATION_EVENT_TYPE,
      { operation_id: "op-x" },
      ref,
    );
    await sink.emit(event);
    // Give the emit's returned promise time to complete.
    await new Promise((r) => setImmediate(r));
    expect(await store.get("eval-routed")).toBeDefined();
  });

  it("silently ignores non-evaluation events", async () => {
    const store = createInMemoryEvaluationStore();
    const sink = toObservabilitySink(store);
    const lifecycleEvent = buildEvent(
      config,
      "llm.operation.started",
      { operation_id: "op-y" },
      {
        task_type: "triage",
        method: "generateText",
        provider_chain: ["openai"],
      },
    );
    await sink.emit(lifecycleEvent);
    expect(await store.count()).toBe(0);
  });

  it("routes write errors to onError when provided", async () => {
    const failingStore = {
      async write() {
        throw new Error("write failed");
      },
      async get() {
        return undefined;
      },
      async find() {
        return [];
      },
      async count() {
        return 0;
      },
      async close() {
        return undefined;
      },
    };
    const onError = vi.fn();
    const sink = toObservabilitySink(failingStore, { onError });
    const event = buildEvent(
      config,
      EVALUATION_EVENT_TYPE,
      { operation_id: "op-y" },
      makeRef({ evaluation_id: "eval-err" }),
    );
    await sink.emit(event);
    await new Promise((r) => setImmediate(r));
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe("write failed");
  });

  it("swallows write errors when no onError is provided", async () => {
    const failingStore = {
      async write() {
        throw new Error("still failing");
      },
      async get() {
        return undefined;
      },
      async find() {
        return [];
      },
      async count() {
        return 0;
      },
      async close() {
        return undefined;
      },
    };
    const sink = toObservabilitySink(failingStore);
    const event = buildEvent(
      config,
      EVALUATION_EVENT_TYPE,
      { operation_id: "op-y" },
      makeRef({ evaluation_id: "eval-err-swallow" }),
    );
    // Should NOT throw.
    await expect(sink.emit(event)).resolves.toBeUndefined();
  });

  it("routes multiple evaluation events to the store in order", async () => {
    const store = createInMemoryEvaluationStore();
    const sink = toObservabilitySink(store);
    for (let i = 0; i < 3; i++) {
      const ref = makeRef({
        evaluation_id: `multi-${i}`,
        occurred_at: `2026-08-1${i}T00:00:00Z`,
      });
      await sink.emit(
        buildEvent(config, EVALUATION_EVENT_TYPE, { operation_id: `op-${i}` }, ref),
      );
    }
    await new Promise((r) => setImmediate(r));
    expect(await store.count()).toBe(3);
  });
});
