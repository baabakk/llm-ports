/**
 * Parity with @llm-ports/adapter-vercel #5: generateStructured should throw
 * a typed EmptyResponseError (carrying alias + modelId) instead of letting
 * JSON.parse("") raise SyntaxError that gets wrapped as a generic
 * ProviderUnavailableError. The registry can then route to a fallback.
 *
 * Empty here means: model returned content === "" (or whitespace only).
 * The executeChatRequest layer already retries reasoning-starved responses
 * once with an expanded budget; this test pins the behavior after that
 * retry has fired and produced (still) no usable text.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EmptyResponseError, ProviderUnavailableError } from "@llm-ports/core";
import {
  buildOpenAIChatResponse,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { createOpenAIAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("generateStructured throws EmptyResponseError on empty content (parity with adapter-vercel)", () => {
  it("empty text on a non-reasoning model → EmptyResponseError, not SyntaxError", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "",
        promptTokens: 10,
        completionTokens: 0,
        modelId: "gpt-4o",
        finishReason: "stop",
      }),
    );

    await expect(
      port.generateStructured({
        taskType: "t",
        messages: [{ role: "user" as const, content: "classify" }],
        schema: z.object({ label: z.string() }),
        schemaName: "c",
      }),
    ).rejects.toBeInstanceOf(EmptyResponseError);
  });

  it("EmptyResponseError carries alias + modelId for registry fallback routing", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "   ",
        promptTokens: 10,
        completionTokens: 0,
        modelId: "gpt-4o",
        finishReason: "stop",
      }),
    );

    try {
      await port.generateStructured({
        taskType: "t",
        messages: [{ role: "user" as const, content: "classify" }],
        schema: z.object({ label: z.string() }),
        schemaName: "c",
      });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EmptyResponseError);
      const empty = err as EmptyResponseError;
      expect(empty.alias).toBe("live");
      expect(empty.modelId).toBe("gpt-4o");
      expect(empty.hint).toMatch(/maxOutputTokens|fallback/);
    }
  });

  it("EmptyResponseError is NOT re-wrapped as ProviderUnavailableError", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "",
        promptTokens: 10,
        completionTokens: 0,
        modelId: "gpt-4o",
        finishReason: "stop",
      }),
    );

    await expect(
      port.generateStructured({
        taskType: "t",
        messages: [{ role: "user" as const, content: "x" }],
        schema: z.object({ label: z.string() }),
        schemaName: "c",
      }),
    ).rejects.not.toBeInstanceOf(ProviderUnavailableError);
  });

  it("non-empty text continues to flow through normal validation", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"label":"spam"}',
        promptTokens: 10,
        completionTokens: 5,
        modelId: "gpt-4o",
      }),
    );

    const result = await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "classify" }],
      schema: z.object({ label: z.string() }),
      schemaName: "c",
    });

    expect(result.data).toEqual({ label: "spam" });
  });
});
