/**
 * httpOptions pass-through (alpha.22+).
 *
 * Adapter-google forwards `opts.httpOptions` verbatim to the
 * `@google/genai` `GoogleGenAI` constructor. The primary use case is a
 * backend proxy that holds the real `GEMINI_API_KEY` and exposes a
 * Bearer-token-authenticated endpoint to a browser bundle (Dramma
 * backend-proxy plan, llm-ports#46 / discussion #49 follow-up).
 *
 * Pre-alpha.22, `GoogleAdapterOptions` had no way to override the
 * baseUrl — the SDK always talked to generativelanguage.googleapis.com,
 * forcing browser bundles to inline the real key or fail to redirect.
 */

import { beforeEach, describe, expect, it } from "vitest";
// Import helper FIRST so its vi.mock("@google/genai", ...) registers before
// the SUT loads. Reversing these imports causes the real SDK to be loaded.
import { mockGoogleGenAICtor, resetMocks } from "../helpers/mock-sdk.js";
import { createGoogleAdapter, type HttpOptions } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
});

describe("httpOptions pass-through (alpha.22+)", () => {
  it("forwards baseUrl override to GoogleGenAI constructor", () => {
    createGoogleAdapter({
      apiKey: "test-key",
      httpOptions: { baseUrl: "https://prototypedemos.com/apps/dramma/api/v1/llm/google" },
    });
    expect(mockGoogleGenAICtor).toHaveBeenCalledTimes(1);
    const ctorArgs = mockGoogleGenAICtor.mock.calls[0]![0] as {
      apiKey: string;
      httpOptions: HttpOptions;
    };
    expect(ctorArgs.apiKey).toBe("test-key");
    expect(ctorArgs.httpOptions).toEqual({
      baseUrl: "https://prototypedemos.com/apps/dramma/api/v1/llm/google",
    });
  });

  it("forwards full httpOptions object (baseUrl + apiVersion + headers + timeout) verbatim", () => {
    const httpOptions: HttpOptions = {
      baseUrl: "https://proxy.example.com",
      apiVersion: "v1beta",
      headers: { "X-Custom": "value", "X-Forwarded-For": "127.0.0.1" },
      timeout: 30000,
    };
    createGoogleAdapter({
      apiKey: "test-key",
      httpOptions,
    });
    const ctorArgs = mockGoogleGenAICtor.mock.calls[0]![0] as { httpOptions: HttpOptions };
    expect(ctorArgs.httpOptions).toEqual(httpOptions);
  });

  it("omits httpOptions from the constructor call when not supplied (no breaking change)", () => {
    createGoogleAdapter({ apiKey: "test-key" });
    expect(mockGoogleGenAICtor).toHaveBeenCalledTimes(1);
    const ctorArgs = mockGoogleGenAICtor.mock.calls[0]![0] as Record<string, unknown>;
    expect(ctorArgs).toEqual({ apiKey: "test-key" });
    expect("httpOptions" in ctorArgs).toBe(false);
  });

  it("does NOT inject httpOptions when the caller explicitly passes undefined", () => {
    createGoogleAdapter({ apiKey: "test-key", httpOptions: undefined });
    const ctorArgs = mockGoogleGenAICtor.mock.calls[0]![0] as Record<string, unknown>;
    expect("httpOptions" in ctorArgs).toBe(false);
  });

  it("HttpOptions is re-exported so consumers can type their override without an extra dep", () => {
    // Compile-time check via tsc; this assertion just confirms the export is reachable.
    const opts: HttpOptions = { baseUrl: "x" };
    expect(opts.baseUrl).toBe("x");
  });
});
