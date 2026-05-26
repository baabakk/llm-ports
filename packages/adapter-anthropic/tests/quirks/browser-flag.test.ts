/**
 * dangerouslyAllowBrowser flag forwarding (issue #32, shipped alpha.9).
 *
 * The Anthropic SDK refuses to run in a browser by default. The adapter now
 * exposes `dangerouslyAllowBrowser?: boolean` on its options and forwards
 * it to `new Anthropic({ dangerouslyAllowBrowser })`. When enabled, the
 * SDK automatically includes the `anthropic-dangerous-direct-browser-access`
 * header on every request.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetMocks } from "../helpers/mock-sdk.js";
import { createAnthropicAdapter } from "../../src/index.js";

import Anthropic from "@anthropic-ai/sdk";

beforeEach(() => {
  resetMocks();
});

describe("dangerouslyAllowBrowser option", () => {
  it("forwards dangerouslyAllowBrowser=true to the Anthropic constructor", () => {
    createAnthropicAdapter({ apiKey: "test", dangerouslyAllowBrowser: true });
    const calls = (Anthropic as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const ctorCall = calls.at(-1);
    expect(ctorCall).toBeDefined();
    const opts = ctorCall![0] as { dangerouslyAllowBrowser?: boolean };
    expect(opts.dangerouslyAllowBrowser).toBe(true);
  });

  it("does NOT include the flag when the option is omitted", () => {
    createAnthropicAdapter({ apiKey: "test" });
    const calls = (Anthropic as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const ctorCall = calls.at(-1);
    expect(ctorCall).toBeDefined();
    const opts = ctorCall![0] as { dangerouslyAllowBrowser?: boolean };
    expect("dangerouslyAllowBrowser" in opts).toBe(false);
  });
});
