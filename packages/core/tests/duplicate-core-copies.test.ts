/**
 * Alpha.34, item 6: the error taxonomy survives two copies of core.
 *
 * A consumer can end up with two copies of `@llm-ports/core`, typically after
 * upgrading core without upgrading an adapter. The two copies define
 * different class objects, so a plain `instanceof` is false for an error from
 * the other copy. Every fallback decision in the Registry is an `instanceof`
 * test, so failover silently stopped: no error, no log line, and a symptom
 * that looked like an unreliable provider.
 *
 * This was found by accident, in a test that imported core from source while
 * the adapters it called resolved core from the build, which is exactly the
 * two-copy condition.
 *
 * Here, two copies are produced deliberately by resetting the module registry
 * between two imports of the same file. The first assertion checks that this
 * really yields distinct class objects, because a setup that silently loaded
 * one copy twice would make every other assertion pass without proving
 * anything.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

type ErrorsModule = typeof import("../src/errors.js");

let copyA: ErrorsModule;
let copyB: ErrorsModule;

beforeAll(async () => {
  vi.resetModules();
  copyA = await import("../src/errors.js");
  vi.resetModules();
  copyB = await import("../src/errors.js");
});

describe("the test setup", () => {
  it("really produces two independent copies", () => {
    expect(copyA.ProviderUnavailableError).not.toBe(copyB.ProviderUnavailableError);

    // And the ordinary prototype check alone would fail across them, which is
    // the defect being guarded against.
    const fromB = new copyB.ProviderUnavailableError("b", new Error("down"));
    expect(Object.prototype.isPrototypeOf.call(copyA.ProviderUnavailableError.prototype, fromB)).toBe(false);
  });
});

describe("instanceof across copies", () => {
  it("recognises the same class from the other copy", () => {
    const fromB = new copyB.ProviderUnavailableError("b", new Error("down"));
    expect(fromB instanceof copyA.ProviderUnavailableError).toBe(true);
  });

  it("recognises a subclass from the other copy as its ancestor", () => {
    const fromB = new copyB.AttemptTimeoutError("b", 1000);
    expect(fromB instanceof copyA.AttemptTimeoutError).toBe(true);
    expect(fromB instanceof copyA.ProviderUnavailableError).toBe(true);
    expect(fromB instanceof copyA.ServiceUnavailableError).toBe(true);
    expect(fromB instanceof copyA.LLMPortError).toBe(true);
  });

  it("does not over-match an unrelated class", () => {
    // A rate limit is not a provider outage. The brand must not blur the
    // taxonomy it exists to preserve.
    const fromB = new copyB.RateLimitError("b", "slow down");
    expect(fromB instanceof copyA.ProviderUnavailableError).toBe(false);
    expect(fromB instanceof copyA.RateLimitError).toBe(true);
  });

  it("does not treat a parent as its child", () => {
    const fromB = new copyB.ProviderUnavailableError("b", new Error("down"));
    expect(fromB instanceof copyA.AttemptTimeoutError).toBe(false);
  });

  it("still works within a single copy", () => {
    const local = new copyA.AttemptTimeoutError("a", 5);
    expect(local instanceof copyA.ProviderUnavailableError).toBe(true);
    expect(local instanceof copyA.RateLimitError).toBe(false);
  });
});

describe("what the brand refuses", () => {
  it("rejects a plain object that merely carries the symbol", () => {
    const spoof = { [Symbol.for("llm-ports.error.lineage")]: ["ProviderUnavailableError"] };
    expect(spoof instanceof copyA.ProviderUnavailableError).toBe(false);
  });

  it("rejects an ordinary Error", () => {
    expect(new Error("nope") instanceof copyA.LLMPortError).toBe(false);
  });

  it("rejects primitives without throwing", () => {
    expect((null as unknown) instanceof copyA.LLMPortError).toBe(false);
    expect(("text" as unknown) instanceof copyA.LLMPortError).toBe(false);
  });
});

describe("consumer-defined subclasses", () => {
  // The case that got past the first version of this change. Static fields
  // are inherited, so a consumer class that declares no id of its own used
  // to inherit its parent's, and every error of the parent's kind then passed
  // as the consumer's class. The existing taxonomy suite caught it; this pins
  // it here, beside the rest of the brand's behaviour.
  it("does not treat a library error as an instance of a consumer subclass", () => {
    class MyCustomWalkError extends copyA.LLMPortError {
      public override readonly name: string = "MyCustomWalkError";
    }
    expect(new copyA.AuthenticationError("a", "x") instanceof MyCustomWalkError).toBe(false);
    expect(new copyB.AuthenticationError("b", "x") instanceof MyCustomWalkError).toBe(false);
  });

  it("still recognises the consumer's own instances", () => {
    class MyCustomWalkError extends copyA.LLMPortError {}
    expect(new MyCustomWalkError("custom") instanceof MyCustomWalkError).toBe(true);
  });

  it("still lets a consumer subclass pass as its library ancestor, from either copy", () => {
    class MyCustomWalkError extends copyB.LLMPortError {}
    const err = new MyCustomWalkError("custom");
    expect(err instanceof copyB.LLMPortError).toBe(true);
    expect(err instanceof copyA.LLMPortError).toBe(true);
  });
});

describe("the failure mode itself", () => {
  it("lets one copy's fallback policy walk on an error thrown by the other copy", () => {
    // The consequence that mattered. Before the brand, this returned false,
    // and a chain with a dead first provider simply stopped.
    const thrownByAdapterCopy = new copyB.ProviderUnavailableError("b", new Error("down"));
    expect(copyA.conservativeShouldFallback(thrownByAdapterCopy)).toBe(true);
  });

  it("walks on a timeout and an unsupported block from the other copy too", () => {
    expect(copyA.conservativeShouldFallback(new copyB.AttemptTimeoutError("b", 10))).toBe(true);
    expect(copyA.conservativeShouldFallback(new copyB.ContentBlockUnsupportedError("b", "document"))).toBe(true);
  });

  it("still refuses to walk on a non-walkable error from the other copy", () => {
    expect(copyA.conservativeShouldFallback(new copyB.ConfigError("bad config"))).toBe(false);
  });
});

describe("the brand stays out of the way", () => {
  it("is not serialised", () => {
    const err = new copyA.ProviderUnavailableError("a", new Error("down"));
    expect(JSON.stringify(err)).not.toContain("lineage");
    expect(Object.keys(err)).not.toContain("llm-ports.error.lineage");
  });

  it("records the full lineage by stable id, most derived first", () => {
    const err = new copyA.AttemptTimeoutError("a", 1);
    const lineage = (err as unknown as Record<symbol, unknown>)[Symbol.for("llm-ports.error.lineage")];
    expect(lineage).toEqual([
      "AttemptTimeoutError",
      "ProviderUnavailableError",
      "ServiceUnavailableError",
      "LLMPortError",
    ]);
  });
});
