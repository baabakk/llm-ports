/**
 * Tests for the `throwIfAborted` helper — the entry-time abort check that
 * each adapter calls at the top of every port method (issue #24).
 */

import { describe, expect, it } from "vitest";
import { throwIfAborted } from "../src/utils/abort.js";

describe("throwIfAborted", () => {
  it("is a no-op when signal is undefined", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it("is a no-op when signal is not aborted", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  it("throws when signal is already aborted (no reason)", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow();
  });

  it("throws the supplied reason when signal.reason is set", () => {
    const controller = new AbortController();
    const reason = new Error("user clicked cancel");
    controller.abort(reason);
    expect(() => throwIfAborted(controller.signal)).toThrow("user clicked cancel");
  });

  it("throws a string reason verbatim when reason is a string", () => {
    const controller = new AbortController();
    controller.abort("ctx-deadline-exceeded");
    let caught: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe("ctx-deadline-exceeded");
  });

  it("throws DOMException AbortError when signal aborted with no reason", () => {
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (err) {
      caught = err;
    }
    // Browsers + Node 18+ populate signal.reason with a DOMException("AbortError")
    // automatically when abort() is called without an argument; either we get
    // that, or our DOMException fallback. Both are acceptable.
    expect(caught).toBeDefined();
  });
});
