/**
 * validationAttempts counting probe (filed in alpha.9 follow-up).
 *
 * Verify the field reflects actual attempts, not a constant.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildOpenAIChatResponse,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { createOpenAIAdapter } from "../../src/index.js";

beforeEach(() => resetMocks());

describe("validationAttempts counting", () => {
  it("first-attempt success returns validationAttempts: 1", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":1}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "m": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("m", "test");
    const result = await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "p" }],
      schema: z.object({ x: z.number() }),
    });
    expect(result.validationAttempts).toBe(1);
  });

  it("first-attempt fail, second-attempt success returns validationAttempts: 2", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":"not-a-number"}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":1}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "m": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("m", "test");
    const result = await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "p" }],
      schema: z.object({ x: z.number() }),
    });
    expect(result.validationAttempts).toBe(2);
  });
});
