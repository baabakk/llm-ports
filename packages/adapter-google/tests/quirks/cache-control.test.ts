/**
 * Verifies adapter-google translates the typed `CacheControl` shape into
 * Gemini's `config.cachedContent` field on the `generateContent` payload.
 *
 * Per-mode coverage (alpha.19.1):
 *   - `mode: "preCreated"` with `cachedContentHandle` → `config.cachedContent` set.
 *   - `mode: "preCreated"` without a handle → no-op (caller bug).
 *   - `mode: "auto" | "manual" | "off"` → no-op (Gemini has no equivalent).
 *   - omitting `cacheControl` → no `cachedContent` field set.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildGeminiResponse,
  mockGenerateContent,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { createGoogleAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
});

function adapter() {
  return createGoogleAdapter({
    apiKey: "test",
    pricingOverrides: { "gemini-2.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 } },
  });
}

function port() {
  return adapter().createLLMPort("gemini-2.5-flash", "gemini");
}

function okResponse() {
  return buildGeminiResponse({ text: "ok", promptTokens: 10, outputTokens: 5 });
}

const HANDLE = "projects/my-project/cachedContents/test-handle-abc123";

describe("CacheControl translation — alpha.19.1", () => {
  describe("mode: preCreated", () => {
    it("with cachedContentHandle, sets config.cachedContent on generateText", async () => {
      mockGenerateContent.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        prompt: "hi",
        cacheControl: { mode: "preCreated", cachedContentHandle: HANDLE },
      });
      const sent = mockGenerateContent.mock.calls[0][0];
      expect(sent.config.cachedContent).toBe(HANDLE);
    });

    it("without cachedContentHandle, does not set config.cachedContent", async () => {
      mockGenerateContent.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        prompt: "hi",
        cacheControl: { mode: "preCreated" },
      });
      const sent = mockGenerateContent.mock.calls[0][0];
      expect(sent.config.cachedContent).toBeUndefined();
    });

    it("with empty cachedContentHandle, does not set config.cachedContent", async () => {
      mockGenerateContent.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        prompt: "hi",
        cacheControl: { mode: "preCreated", cachedContentHandle: "" },
      });
      const sent = mockGenerateContent.mock.calls[0][0];
      expect(sent.config.cachedContent).toBeUndefined();
    });
  });

  describe("mode: auto", () => {
    it("is a no-op on Google (no caller-controllable surface)", async () => {
      mockGenerateContent.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        prompt: "hi",
        cacheControl: { mode: "auto", ttlSeconds: 3600 },
      });
      const sent = mockGenerateContent.mock.calls[0][0];
      expect(sent.config.cachedContent).toBeUndefined();
    });
  });

  describe("mode: manual", () => {
    it("is a no-op on Google", async () => {
      mockGenerateContent.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        prompt: "hi",
        cacheControl: { mode: "manual", breakpoints: [{ at: "system" }] },
      });
      const sent = mockGenerateContent.mock.calls[0][0];
      expect(sent.config.cachedContent).toBeUndefined();
    });
  });

  describe("mode: off", () => {
    it("is a no-op on Google", async () => {
      mockGenerateContent.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        prompt: "hi",
        cacheControl: { mode: "off" },
      });
      const sent = mockGenerateContent.mock.calls[0][0];
      expect(sent.config.cachedContent).toBeUndefined();
    });
  });

  describe("default (cacheControl omitted)", () => {
    it("does not set config.cachedContent", async () => {
      mockGenerateContent.mockResolvedValueOnce(okResponse());
      await port().generateText({ taskType: "x", prompt: "hi" });
      const sent = mockGenerateContent.mock.calls[0][0];
      expect(sent.config.cachedContent).toBeUndefined();
    });
  });
});
