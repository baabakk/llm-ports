/**
 * `deriveValidationRetryFromAdapterRetry` helper (alpha.24+).
 *
 * Closes the alpha.21-deferred `onValidationRetry` Registry-level emission.
 * The Registry can't intercept adapter-internal retries (adapters are
 * constructed independently), so the helper produces an `OnRetry` callback
 * that consumers pass to each adapter at construction. The callback filters
 * for `reason === "validation-feedback"` events and forwards them to the
 * Registry's `observability.onValidationRetry` hook.
 *
 * Optionally chains with a user-supplied adapter-level `onRetry` so
 * existing observability code keeps working.
 */

import { describe, expect, it, vi } from "vitest";
import {
  deriveValidationRetryFromAdapterRetry,
  type ObservabilityHooks,
  type RetryEvent,
  type ValidationRetryEvent,
} from "../src/index.js";

function makeRegistry(observability: ObservabilityHooks): {
  observability: ObservabilityHooks;
} {
  return { observability };
}

describe("deriveValidationRetryFromAdapterRetry", () => {
  it("forwards validation-feedback events to onValidationRetry", () => {
    const onValidationRetry = vi.fn();
    const registry = makeRegistry({ onValidationRetry });
    const wrapped = deriveValidationRetryFromAdapterRetry(registry);

    const retryEvent: RetryEvent = {
      reason: "validation-feedback",
      attempt: 0,
      modelId: "gpt-5-nano",
      providerAlias: "openai",
      delayMs: 0,
      cause: { issues: [{ path: ["x"], message: "expected string" }] },
    };
    wrapped(retryEvent);

    expect(onValidationRetry).toHaveBeenCalledTimes(1);
    const event = onValidationRetry.mock.calls[0]![0] as ValidationRetryEvent;
    expect(event.attempt).toBe(0);
    expect(event.modelId).toBe("gpt-5-nano");
    expect(event.providerAlias).toBe("openai");
    expect(event.cause).toBe("schema-mismatch");
    expect(event.operation).toBe("generateStructured");
  });

  it("does NOT forward other retry reasons", () => {
    const onValidationRetry = vi.fn();
    const registry = makeRegistry({ onValidationRetry });
    const wrapped = deriveValidationRetryFromAdapterRetry(registry);

    for (const reason of [
      "transient-auth",
      "capability-fallback",
      "reasoning-starvation",
      "harmony-tool-call-extracted",
      "zero-tool-call-prose-retry",
    ] as const) {
      wrapped({
        reason,
        attempt: 0,
        modelId: "m",
        providerAlias: "p",
        delayMs: 0,
      });
    }

    expect(onValidationRetry).not.toHaveBeenCalled();
  });

  it("chains with a user-supplied adapter-level onRetry", () => {
    const onValidationRetry = vi.fn();
    const userOnRetry = vi.fn();
    const registry = makeRegistry({ onValidationRetry });
    const wrapped = deriveValidationRetryFromAdapterRetry(registry, {
      userOnRetry,
    });

    const event: RetryEvent = {
      reason: "validation-feedback",
      attempt: 1,
      modelId: "m",
      providerAlias: "p",
      delayMs: 0,
    };
    wrapped(event);

    // User's adapter-level callback received the full RetryEvent
    expect(userOnRetry).toHaveBeenCalledTimes(1);
    expect(userOnRetry.mock.calls[0]![0]).toEqual(event);
    // Registry's hook received the derived ValidationRetryEvent
    expect(onValidationRetry).toHaveBeenCalledTimes(1);
  });

  it("user's onRetry receives ALL reasons, not just validation-feedback", () => {
    const onValidationRetry = vi.fn();
    const userOnRetry = vi.fn();
    const registry = makeRegistry({ onValidationRetry });
    const wrapped = deriveValidationRetryFromAdapterRetry(registry, {
      userOnRetry,
    });

    wrapped({
      reason: "transient-auth",
      attempt: 0,
      modelId: "m",
      providerAlias: "p",
      delayMs: 500,
    });
    wrapped({
      reason: "validation-feedback",
      attempt: 0,
      modelId: "m",
      providerAlias: "p",
      delayMs: 0,
    });

    expect(userOnRetry).toHaveBeenCalledTimes(2);
    expect(onValidationRetry).toHaveBeenCalledTimes(1); // only validation-feedback
  });

  it("swallows user onRetry errors (matches OnRetry contract)", () => {
    const onValidationRetry = vi.fn();
    const userOnRetry = vi.fn(() => {
      throw new Error("user callback bug");
    });
    const registry = makeRegistry({ onValidationRetry });
    const wrapped = deriveValidationRetryFromAdapterRetry(registry, {
      userOnRetry,
    });

    expect(() =>
      wrapped({
        reason: "validation-feedback",
        attempt: 0,
        modelId: "m",
        providerAlias: "p",
        delayMs: 0,
      }),
    ).not.toThrow();
    // Despite user's error, registry hook still fired
    expect(onValidationRetry).toHaveBeenCalledTimes(1);
  });

  it("does nothing when Registry has no onValidationRetry hook (regression check)", () => {
    const registry = makeRegistry({}); // no hooks
    const wrapped = deriveValidationRetryFromAdapterRetry(registry);

    // Should not throw
    expect(() =>
      wrapped({
        reason: "validation-feedback",
        attempt: 0,
        modelId: "m",
        providerAlias: "p",
        delayMs: 0,
      }),
    ).not.toThrow();
  });

  it("operation override is honored", () => {
    const onValidationRetry = vi.fn();
    const registry = makeRegistry({ onValidationRetry });
    const wrapped = deriveValidationRetryFromAdapterRetry(registry, {
      operation: "streamStructured",
    });

    wrapped({
      reason: "validation-feedback",
      attempt: 0,
      modelId: "m",
      providerAlias: "p",
      delayMs: 0,
    });

    const event = onValidationRetry.mock.calls[0]![0] as ValidationRetryEvent;
    expect(event.operation).toBe("streamStructured");
  });

  it("forwards Zod issues via event.cause → ValidationRetryEvent.issues", () => {
    const onValidationRetry = vi.fn();
    const registry = makeRegistry({ onValidationRetry });
    const wrapped = deriveValidationRetryFromAdapterRetry(registry);

    const issues = [{ path: ["foo"], message: "Required" }];
    wrapped({
      reason: "validation-feedback",
      attempt: 0,
      modelId: "m",
      providerAlias: "p",
      delayMs: 0,
      cause: issues,
    });

    const event = onValidationRetry.mock.calls[0]![0] as ValidationRetryEvent;
    expect(event.issues).toBe(issues);
  });

  it("derives maxAttempts as attempt + 1 (best-known lower bound)", () => {
    const onValidationRetry = vi.fn();
    const registry = makeRegistry({ onValidationRetry });
    const wrapped = deriveValidationRetryFromAdapterRetry(registry);

    wrapped({
      reason: "validation-feedback",
      attempt: 2,
      modelId: "m",
      providerAlias: "p",
      delayMs: 0,
    });

    const event = onValidationRetry.mock.calls[0]![0] as ValidationRetryEvent;
    expect(event.attempt).toBe(2);
    expect(event.maxAttempts).toBe(3);
  });
});
