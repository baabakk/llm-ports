/**
 * Tests for the shared `emitRetryEvent` helper. Adapters import this instead
 * of writing their own `emitRetry` helper. The contract: fire-and-forget,
 * never throws, never lets a misbehaving hook break a retry.
 */

import { describe, it, expect } from "vitest";
import { emitRetryEvent } from "../src/retry-emit.js";
import type { RetryEvent } from "../src/retry.js";

const baseEvent: RetryEvent = {
  reason: "transient-auth",
  attempt: 0,
  modelId: "test-model",
  providerAlias: "test-alias",
  delayMs: 0,
};

describe("emitRetryEvent", () => {
  it("no-ops when onRetry is undefined", () => {
    expect(() => emitRetryEvent(undefined, baseEvent)).not.toThrow();
  });

  it("invokes the hook with the given event", () => {
    let called: RetryEvent | null = null;
    emitRetryEvent((event) => {
      called = event;
    }, baseEvent);
    expect(called).toEqual(baseEvent);
  });

  it("swallows synchronous errors thrown by the hook", () => {
    expect(() =>
      emitRetryEvent(() => {
        throw new Error("boom");
      }, baseEvent),
    ).not.toThrow();
  });

  it("swallows rejected promises returned by the hook", async () => {
    expect(() =>
      emitRetryEvent(async () => {
        throw new Error("async boom");
      }, baseEvent),
    ).not.toThrow();
    // Give the microtask queue a chance to surface the rejection; should
    // not produce an unhandled-rejection warning.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("does not await the hook result (fire-and-forget)", () => {
    let resolveHook!: () => void;
    const hookPromise = new Promise<void>((resolve) => {
      resolveHook = resolve;
    });
    const start = Date.now();
    emitRetryEvent(() => hookPromise, baseEvent);
    expect(Date.now() - start).toBeLessThan(5);
    resolveHook();
  });

  it("passes capability field through unchanged", () => {
    let called: RetryEvent | null = null;
    emitRetryEvent(
      (event) => {
        called = event;
      },
      { ...baseEvent, reason: "capability-fallback", capability: "temperatureLocked" },
    );
    expect(called?.capability).toBe("temperatureLocked");
  });
});
