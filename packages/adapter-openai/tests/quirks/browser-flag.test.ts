/**
 * dangerouslyAllowBrowser flag forwarding (issue #32, shipped alpha.9).
 *
 * The OpenAI SDK refuses to run in a browser by default. The adapter now
 * exposes `dangerouslyAllowBrowser?: boolean` on its options and forwards
 * it to `new OpenAI({ dangerouslyAllowBrowser })`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMocks } from "../helpers/mock-sdk.js";
import { createOpenAIAdapter } from "../../src/index.js";

import OpenAI from "openai";

beforeEach(() => {
  resetMocks();
});

describe("dangerouslyAllowBrowser option", () => {
  it("forwards dangerouslyAllowBrowser=true to the OpenAI constructor", () => {
    createOpenAIAdapter({ apiKey: "test", dangerouslyAllowBrowser: true });
    // Use .at(-1) — the OpenAI ctor mock is module-level; resetMocks only
    // clears chat/embedding mocks, not the constructor's call history.
    const calls = (OpenAI as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const ctorCall = calls.at(-1);
    expect(ctorCall).toBeDefined();
    const opts = ctorCall![0] as { dangerouslyAllowBrowser?: boolean };
    expect(opts.dangerouslyAllowBrowser).toBe(true);
  });

  it("does NOT include the flag when the option is omitted", () => {
    createOpenAIAdapter({ apiKey: "test" });
    // Use .at(-1) — the OpenAI ctor mock is module-level; resetMocks only
    // clears chat/embedding mocks, not the constructor's call history.
    const calls = (OpenAI as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const ctorCall = calls.at(-1);
    expect(ctorCall).toBeDefined();
    const opts = ctorCall![0] as { dangerouslyAllowBrowser?: boolean };
    expect("dangerouslyAllowBrowser" in opts).toBe(false);
  });

  it("does NOT include the flag when explicitly set to false", () => {
    createOpenAIAdapter({ apiKey: "test", dangerouslyAllowBrowser: false });
    // Use .at(-1) — the OpenAI ctor mock is module-level; resetMocks only
    // clears chat/embedding mocks, not the constructor's call history.
    const calls = (OpenAI as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const ctorCall = calls.at(-1);
    expect(ctorCall).toBeDefined();
    const opts = ctorCall![0] as { dangerouslyAllowBrowser?: boolean };
    // Same as omitted — only forwarded when truthy. The SDK's default
    // is "off"; not setting the key is equivalent to false.
    expect("dangerouslyAllowBrowser" in opts).toBe(false);
  });
});
