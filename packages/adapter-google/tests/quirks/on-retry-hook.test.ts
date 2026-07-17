/**
 * onRetry observability hook (alpha.17 parity; TD-LLMPORTS-ALPHA17-CLOSEOUT).
 *
 * Verifies the hook fires exactly once per validation-feedback retry with
 * the right shape (reason, attempt index, model, provider). adapter-google
 * has the validation-feedback retry path for generateStructured; this test
 * pins it.
 *
 * Also asserts hook errors don't cancel the retry — observability only.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { RetryEvent } from "@llm-ports/core";
import {
  buildGeminiResponse,
  mockGenerateContent,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { createGoogleAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
});

describe("onRetry observability hook (validation-feedback)", () => {
  it("fires for validation-feedback retry with the right shape", async () => {
    const events: RetryEvent[] = [];
    const adapter = createGoogleAdapter({
      apiKey: "test",
      onRetry: (e) => {
        events.push(e);
      },
      pricingOverrides: {
        "gemini-2.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
      },
    });
    const port = adapter.createLLMPort("gemini-2.5-flash", "google");

    const Schema = z.object({
      intent: z.enum(["question", "request"]),
    });

    mockGenerateContent
      .mockResolvedValueOnce(
        buildGeminiResponse({
          text: '{"intent":"WRONG_VALUE"}',
          promptTokens: 10,
          outputTokens: 5,
          modelId: "gemini-2.5-flash",
        }),
      )
      .mockResolvedValueOnce(
        buildGeminiResponse({
          text: '{"intent":"request"}',
          promptTokens: 10,
          outputTokens: 5,
          modelId: "gemini-2.5-flash",
        }),
      );

    const result = await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "classify this" }],
      schema: Schema,
      schemaName: "Test",
    });

    expect(result.data).toEqual({ intent: "request" });
    expect(result.validationAttempts).toBe(2);

    // Exactly one retry event fired.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "validation-feedback",
      attempt: 0,
      modelId: "gemini-2.5-flash",
      providerAlias: "google",
      delayMs: 0,
    });
    expect(events[0]?.cause).toBeDefined();
  });

  it("does not fire when first attempt succeeds (no retry needed)", async () => {
    const events: RetryEvent[] = [];
    const adapter = createGoogleAdapter({
      apiKey: "test",
      onRetry: (e) => events.push(e),
      pricingOverrides: {
        "gemini-2.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
      },
    });
    const port = adapter.createLLMPort("gemini-2.5-flash", "google");

    const Schema = z.object({ intent: z.enum(["question", "request"]) });

    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({
        text: '{"intent":"request"}',
        promptTokens: 10,
        outputTokens: 5,
        modelId: "gemini-2.5-flash",
      }),
    );

    await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      schema: Schema,
      schemaName: "Test",
    });

    expect(events).toHaveLength(0);
  });

  it("hook errors do NOT cancel the retry (observability only)", async () => {
    const adapter = createGoogleAdapter({
      apiKey: "test",
      onRetry: () => {
        throw new Error("hook should not break the call");
      },
      pricingOverrides: {
        "gemini-2.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
      },
    });
    const port = adapter.createLLMPort("gemini-2.5-flash", "google");

    const Schema = z.object({ intent: z.enum(["question", "request"]) });

    mockGenerateContent
      .mockResolvedValueOnce(
        buildGeminiResponse({
          text: '{"intent":"WRONG"}',
          promptTokens: 10,
          outputTokens: 5,
          modelId: "gemini-2.5-flash",
        }),
      )
      .mockResolvedValueOnce(
        buildGeminiResponse({
          text: '{"intent":"request"}',
          promptTokens: 10,
          outputTokens: 5,
          modelId: "gemini-2.5-flash",
        }),
      );

    // The retry SHOULD succeed even though the hook throws.
    const result = await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      schema: Schema,
      schemaName: "Test",
    });

    expect(result.data).toEqual({ intent: "request" });
    expect(result.validationAttempts).toBe(2);
  });

  it("is silent (no errors) when onRetry is not configured", async () => {
    const adapter = createGoogleAdapter({
      apiKey: "test",
      pricingOverrides: {
        "gemini-2.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
      },
    });
    const port = adapter.createLLMPort("gemini-2.5-flash", "google");

    const Schema = z.object({ intent: z.enum(["question", "request"]) });

    mockGenerateContent
      .mockResolvedValueOnce(
        buildGeminiResponse({
          text: '{"intent":"WRONG"}',
          promptTokens: 10,
          outputTokens: 5,
          modelId: "gemini-2.5-flash",
        }),
      )
      .mockResolvedValueOnce(
        buildGeminiResponse({
          text: '{"intent":"request"}',
          promptTokens: 10,
          outputTokens: 5,
          modelId: "gemini-2.5-flash",
        }),
      );

    const result = await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      schema: Schema,
      schemaName: "Test",
    });

    expect(result.validationAttempts).toBe(2);
  });
});
