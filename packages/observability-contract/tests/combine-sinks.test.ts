/**
 * `combineSinks` exists because the obvious version of it is wrong.
 *
 * `Instrumentation` takes one sink, so a consumer wanting two writes the
 * fan-out. A `for` loop calling `emit` looks correct and is not: the first
 * sink that throws stops every sink after it, and the symptom is events
 * quietly missing from the later ones rather than an error anybody sees.
 *
 * BEPA wrote the isolating version in its own tree. These tests pin that
 * behaviour here so nobody has to write it a third time.
 */

import { combineSinks, createCollectingSink, type ObservabilitySink } from "../src/index.js";
import { describe, expect, it } from "vitest";

const EVENT = {
  event: "llm.operation.started",
  operation_id: "op-1",
  occurred_at: new Date().toISOString(),
} as never;

describe("combineSinks", () => {
  it("delivers every event to every sink", () => {
    const a = createCollectingSink();
    const b = createCollectingSink();

    combineSinks(a, b).emit(EVENT);

    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  it("keeps delivering after a sink throws, which is the whole point", () => {
    const thrower: ObservabilitySink = {
      emit() {
        throw new Error("this sink is broken");
      },
    };
    const after = createCollectingSink();

    // The broken sink is first, so a naive implementation loses the event.
    expect(() => combineSinks(thrower, after).emit(EVENT)).not.toThrow();
    expect(after.events).toHaveLength(1);
  });

  it("swallows a rejected promise from an asynchronous sink", async () => {
    const rejecting: ObservabilitySink = {
      emit(): Promise<void> {
        return Promise.reject(new Error("async sink failed"));
      },
    };
    const after = createCollectingSink();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      combineSinks(rejecting, after).emit(EVENT);
      // Give the microtask queue a turn, which is when an unhandled rejection
      // would surface and take down a process that is only recording events.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
    expect(after.events).toHaveLength(1);
  });

  it("returns the single sink unchanged when given one", () => {
    const only = createCollectingSink();
    expect(combineSinks(only)).toBe(only);
  });

  it("accepts none, and emitting is then a no-op", () => {
    expect(() => combineSinks().emit(EVENT)).not.toThrow();
  });

  it("preserves order, so a logging sink sees events in sequence", () => {
    const collected = createCollectingSink();
    const sink = combineSinks(collected);
    sink.emit({ ...EVENT, operation_id: "first" } as never);
    sink.emit({ ...EVENT, operation_id: "second" } as never);
    expect(collected.events.map((e) => (e as { operation_id: string }).operation_id)).toEqual([
      "first",
      "second",
    ]);
  });
});
