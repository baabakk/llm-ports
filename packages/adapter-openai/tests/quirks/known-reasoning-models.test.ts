/**
 * Static catalog of known-reasoning models — pre-seeds the capability learner
 * at port creation so first calls against these models skip the "starve,
 * learn, retry with multiplier" round-trip.
 *
 * Coverage:
 *   1. KNOWN_REASONING_MODELS patterns match expected canonical model IDs
 *      (Clarifai's Qwen3_6-35B-A3B-FP8, SambaNova's MiniMax-M2.7, OpenAI
 *      o-series, gpt-5-nano, Cerebras gpt-oss-*).
 *   2. createLLMPort calls seedKnownConstraints, so getEffectiveCapabilities
 *      returns reasoningModel: true before any request.
 *   3. First-call max_completion_tokens reflects the reasoning headroom
 *      multiplier on seeded models, with no wasted round-trip.
 *   4. Non-reasoning models (gpt-5-mini, gpt-4o) are not seeded.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildOpenAIChatResponse,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import {
  KNOWN_REASONING_MODELS,
  createOpenAIAdapter,
} from "../../src/index.js";
import {
  _resetLearnedConstraints,
  getEffectiveCapabilities,
  seedKnownConstraints,
} from "../../src/capabilities.js";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("KNOWN_REASONING_MODELS catalog patterns", () => {
  const expectedReasoning: ReadonlyArray<string> = [
    // OpenAI o-series
    "o1",
    "o1-mini",
    "o1-preview",
    "o3",
    "o3-mini",
    "o4-mini",
    // OpenAI gpt-5-nano
    "gpt-5-nano",
    "gpt-5-nano-2026-01",
    // Cerebras gpt-oss reasoning
    "gpt-oss-120b",
    "gpt-oss-20b",
    // Clarifai Qwen3.6 reasoning (canonical Clarifai ID is Qwen3_6-35B-A3B-FP8)
    "Qwen3_6-35B-A3B-FP8",
    "qwen3.6-35b",
    "qwen3-6-35b-a3b",
    // SambaNova MiniMax M2.7 reasoning
    "MiniMax-M2.7",
    "minimax-m2.7",
    "MiniMax_M2_7",
  ];

  const expectedNotReasoning: ReadonlyArray<string> = [
    "gpt-5-mini",
    "gpt-5",
    "gpt-4o",
    "gpt-4o-mini",
    "claude-opus-4-5",
    "llama-3.3-70b-versatile",
    "qwen-2.5-72b",
    "qwen3-32b",
    "minimax-text-01",
  ];

  it("seeds reasoningModel: true for every expected ID", () => {
    for (const modelId of expectedReasoning) {
      _resetLearnedConstraints();
      seedKnownConstraints(modelId);
      const caps = getEffectiveCapabilities(modelId, undefined);
      expect(caps.reasoningModel, `expected ${modelId} to be marked reasoning`).toBe(true);
    }
  });

  it("does NOT seed reasoning for non-reasoning models", () => {
    for (const modelId of expectedNotReasoning) {
      _resetLearnedConstraints();
      seedKnownConstraints(modelId);
      const caps = getEffectiveCapabilities(modelId, undefined);
      expect(
        caps.reasoningModel,
        `expected ${modelId} NOT to be marked reasoning`,
      ).not.toBe(true);
    }
  });

  it("catalog exports include Clarifai Qwen3.6 + SambaNova MiniMax patterns", () => {
    const patterns = KNOWN_REASONING_MODELS.map((c) => c.pattern.source);
    expect(patterns.some((p) => /qwen3/i.test(p))).toBe(true);
    expect(patterns.some((p) => /minimax/i.test(p))).toBe(true);
  });
});

describe("First-call behavior for seeded reasoning models", () => {
  it("Clarifai Qwen3.6: first call sends max_completion_tokens with reasoning multiplier", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.clarifai.com/v2/ext/openai/v1",
      pricingOverrides: {
        "Qwen3_6-35B-A3B-FP8": { inputPer1M: 1, outputPer1M: 4 },
      },
    });
    const port = adapter.createLLMPort("Qwen3_6-35B-A3B-FP8", "clarifai-qwen");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 10,
        completionTokens: 5,
        modelId: "Qwen3_6-35B-A3B-FP8",
      }),
    );

    await port.generateText({ taskType: "test", prompt: "hi", maxOutputTokens: 100 });

    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
    const firstCall = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      max_completion_tokens: number;
    };
    // Default reasoningHeadroomMultiplier is 10, so 100 * 10 = 1000
    expect(firstCall.max_completion_tokens).toBe(1000);
  });

  it("SambaNova MiniMax-M2.7: first call uses reasoning multiplier", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.sambanova.ai/v1",
      pricingOverrides: {
        "MiniMax-M2.7": { inputPer1M: 1, outputPer1M: 4 },
      },
    });
    const port = adapter.createLLMPort("MiniMax-M2.7", "sambanova-minimax");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 10,
        completionTokens: 5,
        modelId: "MiniMax-M2.7",
      }),
    );

    await port.generateText({ taskType: "test", prompt: "hi", maxOutputTokens: 50 });

    const firstCall = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      max_completion_tokens: number;
    };
    expect(firstCall.max_completion_tokens).toBe(500);
  });

  it("Non-reasoning model: first call uses caller-supplied budget verbatim", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: {
        "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
      },
    });
    const port = adapter.createLLMPort("gpt-4o-mini", "openai-mini");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "ok", promptTokens: 10, completionTokens: 5 }),
    );

    await port.generateText({ taskType: "test", prompt: "hi", maxOutputTokens: 100 });

    const firstCall = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      max_completion_tokens: number;
    };
    expect(firstCall.max_completion_tokens).toBe(100);
  });

  it("User pricingOverrides.capabilities still override the catalog", async () => {
    // User explicitly disables reasoningModel for a model the catalog would seed
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.clarifai.com/v2/ext/openai/v1",
      pricingOverrides: {
        "Qwen3_6-35B-A3B-FP8": {
          inputPer1M: 1,
          outputPer1M: 4,
          capabilities: { reasoningModel: false },
        },
      },
    });
    const port = adapter.createLLMPort("Qwen3_6-35B-A3B-FP8", "clarifai-qwen-override");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 10,
        completionTokens: 5,
        modelId: "Qwen3_6-35B-A3B-FP8",
      }),
    );

    await port.generateText({ taskType: "test", prompt: "hi", maxOutputTokens: 100 });

    const firstCall = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      max_completion_tokens: number;
    };
    // User override wins: no multiplier
    expect(firstCall.max_completion_tokens).toBe(100);
  });
});
