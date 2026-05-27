/**
 * `reasoningEffort` option threading (alpha.12, closes BEPA TD-LLMPORTS-
 * REASONING-EFFORT).
 *
 * Adapter forwards `reasoning_effort: "low" | "medium" | "high"` to the
 * SDK call when set on the call options. Applies to OpenAI native o-series
 * + gpt-5-nano + gpt-5 family, AND to OpenAI-compat providers like Groq's
 * `openai/gpt-oss-120b` which accept the same parameter.
 *
 * Non-reasoning models generally ignore the field; we pass it through
 * verbatim with no per-model gating in v0.1.
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

describe("reasoningEffort option", () => {
  it("forwards reasoning_effort=high to the SDK when set on generateText", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 5,
        completionTokens: 2,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.groq.com/openai/v1",
      displayName: "groq",
      pricingOverrides: {
        "openai/gpt-oss-120b": { inputPer1M: 0.15, outputPer1M: 0.6 },
      },
    });
    const port = adapter.createLLMPort("openai/gpt-oss-120b", "groq");

    await port.generateText({
      taskType: "complex-reasoning",
      prompt: "think hard about this",
      reasoningEffort: "high",
    });

    const args = mockChatCompletionsCreate.mock.calls[0]![0] as {
      reasoning_effort?: string;
    };
    expect(args.reasoning_effort).toBe("high");
  });

  it("does NOT include reasoning_effort when option is omitted", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 5,
        completionTokens: 2,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 } },
    });
    const port = adapter.createLLMPort("gpt-4o-mini", "openai");

    await port.generateText({
      taskType: "t",
      prompt: "hello",
    });

    const args = mockChatCompletionsCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect("reasoning_effort" in args).toBe(false);
  });

  it("forwards on generateStructured", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":1}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4, capabilities: { reasoningModel: true } } },
    });
    const port = adapter.createLLMPort("o3-mini", "openai");

    await port.generateStructured({
      taskType: "t",
      prompt: "x is 1",
      schema: z.object({ x: z.number() }),
      reasoningEffort: "medium",
    });

    const args = mockChatCompletionsCreate.mock.calls[0]![0] as {
      reasoning_effort?: string;
    };
    expect(args.reasoning_effort).toBe("medium");
  });

  it("forwards on runAgent (every step in the loop)", async () => {
    // Single-step agent — model returns text, no tools.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "done",
        promptTokens: 10,
        completionTokens: 5,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.2, capabilities: { reasoningModel: true } } },
    });
    const port = adapter.createLLMPort("gpt-5-nano", "openai");

    await port.runAgent({
      taskType: "agent",
      instructions: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      reasoningEffort: "low",
    });

    const args = mockChatCompletionsCreate.mock.calls[0]![0] as {
      reasoning_effort?: string;
    };
    expect(args.reasoning_effort).toBe("low");
  });

  it("accepts all three effort levels", async () => {
    for (const effort of ["low", "medium", "high"] as const) {
      mockChatCompletionsCreate.mockResolvedValueOnce(
        buildOpenAIChatResponse({
          text: "ok",
          promptTokens: 5,
          completionTokens: 2,
        }),
      );
      const adapter = createOpenAIAdapter({
        apiKey: "test",
        pricingOverrides: { "test-m": { inputPer1M: 1, outputPer1M: 1 } },
      });
      const port = adapter.createLLMPort("test-m", "test");
      await port.generateText({
        taskType: "t",
        prompt: "x",
        reasoningEffort: effort,
      });
      const lastIdx = mockChatCompletionsCreate.mock.calls.length - 1;
      const args = mockChatCompletionsCreate.mock.calls[lastIdx]![0] as {
        reasoning_effort?: string;
      };
      expect(args.reasoning_effort).toBe(effort);
    }
  });
});
