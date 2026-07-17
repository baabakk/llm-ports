/**
 * Verifies adapter-anthropic translates the typed `CacheControl` shape into
 * Anthropic's `cache_control: { type: "ephemeral", ttl? }` markers on the
 * correct positions of the messages.create payload.
 *
 * Per-mode coverage (alpha.19.1):
 *   - `mode: "auto"` with `instructions` → marker on `system` block.
 *   - `mode: "manual"` with breakpoints `{at: "system"}` / `{at: "tools"}` /
 *     `{at: "message-index", index: 0}` → marker on those positions.
 *   - `mode: "off"` → no marker emitted (system stays a string).
 *   - `mode: "preCreated"` → no marker emitted (Anthropic has no handle).
 *   - `ttlSeconds: 3600` → emits `ttl: "1h"`.
 *   - `ttlSeconds: 300` (and undefined) → omits `ttl` (Anthropic default 5m).
 *   - omitting `cacheControl` → no marker emitted (alpha.18 default behavior).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildAnthropicResponse,
  mockCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { createAnthropicAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
});

function adapter() {
  return createAnthropicAdapter({
    apiKey: "test",
    pricingOverrides: { "claude-haiku-4-5": { inputPer1M: 1, outputPer1M: 4 } },
  });
}

function port() {
  return adapter().createLLMPort("claude-haiku-4-5", "claude-haiku");
}

function okResponse() {
  return buildAnthropicResponse({ textBlocks: ["ok"], inputTokens: 10, outputTokens: 5 });
}

describe("CacheControl translation — alpha.19.1", () => {
  describe("mode: auto", () => {
    it("places cache_control on the system block when instructions are present", async () => {
      mockCreate.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        messages: [{ role: "system" as const, content: "stable system prompt" }, { role: "user" as const, content: "hello" }],
        cacheControl: { mode: "auto" },
      });
      const sent = mockCreate.mock.calls[0][0];
      expect(sent.system).toEqual([
        { type: "text", text: "stable system prompt", cache_control: { type: "ephemeral" } },
      ]);
    });

    it("does NOT place cache_control when no instructions are present", async () => {
      mockCreate.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        messages: [{ role: "user" as const, content: "hello" }],
        cacheControl: { mode: "auto" },
      });
      const sent = mockCreate.mock.calls[0][0];
      expect(sent.system).toBeUndefined();
    });

    it("ttlSeconds: 3600 emits ttl: '1h'", async () => {
      mockCreate.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }],
        cacheControl: { mode: "auto", ttlSeconds: 3600 },
      });
      const sent = mockCreate.mock.calls[0][0];
      expect(sent.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    });

    it("ttlSeconds: 300 omits ttl (Anthropic default 5m)", async () => {
      mockCreate.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }],
        cacheControl: { mode: "auto", ttlSeconds: 300 },
      });
      const sent = mockCreate.mock.calls[0][0];
      expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" });
    });
  });

  describe("mode: manual", () => {
    it("at: 'system' places marker on system block", async () => {
      mockCreate.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }],
        cacheControl: { mode: "manual", breakpoints: [{ at: "system" }] },
      });
      const sent = mockCreate.mock.calls[0][0];
      expect(sent.system[0].cache_control).toBeDefined();
    });

    it("at: 'message-index' promotes string content to array + adds marker", async () => {
      // generateStructured needs a JSON-shaped response (Zod-validated downstream),
      // so build a response whose text is the JSON the schema expects.
      mockCreate.mockResolvedValueOnce(
        buildAnthropicResponse({
          textBlocks: ['{"ok": true}'],
          inputTokens: 10,
          outputTokens: 5,
        }),
      );
      await port().generateStructured({
        taskType: "x",
        messages: [{ role: "user" as const, content: "long user turn" }],
        schema: z.object({ ok: z.boolean() }),
        cacheControl: { mode: "manual", breakpoints: [{ at: "message-index", index: 0 }] },
      });
      const sent = mockCreate.mock.calls[0][0];
      // generateStructured sends a single user message; we should see its content
      // promoted to a structured array with cache_control on the last block.
      expect(Array.isArray(sent.messages[0].content)).toBe(true);
      const last = sent.messages[0].content[sent.messages[0].content.length - 1];
      expect(last.cache_control).toEqual({ type: "ephemeral" });
    });

    it("no breakpoints array falls back to system placement (friendly default)", async () => {
      mockCreate.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }],
        cacheControl: { mode: "manual" },
      });
      const sent = mockCreate.mock.calls[0][0];
      expect(sent.system[0].cache_control).toBeDefined();
    });
  });

  describe("mode: off", () => {
    it("leaves system as a plain string with no markers", async () => {
      mockCreate.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }],
        cacheControl: { mode: "off" },
      });
      const sent = mockCreate.mock.calls[0][0];
      expect(sent.system).toBe("sys");
    });
  });

  describe("mode: preCreated", () => {
    it("is a no-op (Anthropic has no createCachedContent handle)", async () => {
      mockCreate.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }],
        cacheControl: { mode: "preCreated", cachedContentHandle: "ignored-on-anthropic" },
      });
      const sent = mockCreate.mock.calls[0][0];
      expect(sent.system).toBe("sys");
    });
  });

  describe("default (cacheControl omitted)", () => {
    it("emits no markers (alpha.18 behavior unchanged)", async () => {
      mockCreate.mockResolvedValueOnce(okResponse());
      await port().generateText({
        taskType: "x",
        messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }],
      });
      const sent = mockCreate.mock.calls[0][0];
      expect(sent.system).toBe("sys");
    });
  });
});
