/**
 * Group A — provider response-shape variants for reasoning models.
 *
 * Every shape we've ever observed in production where a reasoning model
 * returns "empty visible output but I was thinking" gets a regression test
 * here. The Cerebras gpt-oss `message.reasoning` shape is what we observed
 * 2026-05-04; the others are documented variants we want to be defended
 * against before we ever see them in the wild.
 *
 * For each shape, asserts:
 *   1. The model is marked `reasoningModel: true` after the first response
 *   2. A starved response (empty text + finish=length) triggers auto-retry
 *      with the headroom multiplier applied
 *   3. The returned `text` is the visible-content portion only (never CoT)
 *   4. `reasoningTokens` is populated correctly when the provider reports it
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCerebrasReasoningResponse,
  buildOpenAIChatResponse,
  buildOpenAIReasoningResponse,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { createOpenAIAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

// ─── Cerebras gpt-oss shape ──────────────────────────────────────────

describe("Group A: Cerebras gpt-oss-style reasoning (message.reasoning, no content)", () => {
  it("starved first call → auto-retry with expanded budget → returns visible content", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "gpt-oss-120b": { inputPer1M: 0.65, outputPer1M: 0.85 } },
    });
    const port = adapter.createLLMPort("gpt-oss-120b", "live-cerebras");

    // First call: starved. Cerebras puts CoT in message.reasoning, omits content,
    // reports finish=length and reasoning_tokens=0 in usage.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildCerebrasReasoningResponse({
        reasoning: "User asks: 'Say pong and nothing else.' So we should respond with",
        promptTokens: 75,
        completionTokens: 20,
        finishReason: "length",
      }),
    );
    // Second call (auto-retry with multiplier): adapter sends max=200, model
    // produces visible content this time.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildCerebrasReasoningResponse({
        reasoning: "User wants 'pong'. Comply.",
        content: "pong",
        promptTokens: 75,
        completionTokens: 30,
        finishReason: "stop",
      }),
    );

    const result = await port.generateText({
      taskType: "test",
      prompt: "Say 'pong' and nothing else.",
      maxOutputTokens: 20,
    });

    expect(result.text).toBe("pong");
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(2);

    // First call should have been sent with the user-supplied budget
    const firstCall = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      max_completion_tokens: number;
    };
    expect(firstCall.max_completion_tokens).toBe(20);

    // Second call (after learning) should have been expanded by the
    // default 10x reasoning headroom multiplier
    const secondCall = mockChatCompletionsCreate.mock.calls[1]?.[0] as {
      max_completion_tokens: number;
    };
    expect(secondCall.max_completion_tokens).toBe(200);
  });

  it("subsequent generateText calls reuse the learned reasoningModel constraint up front", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "gpt-oss-120b": { inputPer1M: 0.65, outputPer1M: 0.85 } },
    });
    const port = adapter.createLLMPort("gpt-oss-120b", "live-cerebras");

    // First call: starved → triggers learn + retry (2 SDK calls).
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildCerebrasReasoningResponse({
        reasoning: "thinking",
        promptTokens: 10,
        completionTokens: 20,
        finishReason: "length",
      }),
    );
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildCerebrasReasoningResponse({
        reasoning: "still thinking",
        content: "first",
        promptTokens: 10,
        completionTokens: 30,
        finishReason: "stop",
      }),
    );
    // Second logical call: adapter has already learned this model is reasoning,
    // so it sends max=200 on the FIRST attempt; only ONE SDK call needed.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildCerebrasReasoningResponse({
        reasoning: "thinking again",
        content: "second",
        promptTokens: 10,
        completionTokens: 30,
        finishReason: "stop",
      }),
    );

    await port.generateText({ taskType: "t", prompt: "first", maxOutputTokens: 20 });
    await port.generateText({ taskType: "t", prompt: "second", maxOutputTokens: 20 });

    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(3); // 2 + 1
    const thirdCall = mockChatCompletionsCreate.mock.calls[2]?.[0] as {
      max_completion_tokens: number;
    };
    expect(thirdCall.max_completion_tokens).toBe(200);
  });

  it("text field is the visible-content portion only — never the CoT reasoning", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "gpt-oss-120b": { inputPer1M: 0.65, outputPer1M: 0.85 } },
    });
    const port = adapter.createLLMPort("gpt-oss-120b", "live-cerebras");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildCerebrasReasoningResponse({
        reasoning: "INTERNAL THOUGHTS THAT MUST NEVER LEAK TO THE CALLER",
        content: "visible answer",
        promptTokens: 10,
        completionTokens: 30,
        finishReason: "stop",
      }),
    );

    const result = await port.generateText({
      taskType: "t",
      prompt: "x",
      maxOutputTokens: 200,
    });

    expect(result.text).toBe("visible answer");
    expect(result.text).not.toContain("INTERNAL");
  });
});

// ─── OpenAI o-series / gpt-5-nano shape ──────────────────────────────

describe("Group A: OpenAI o-series-style reasoning (usage.reasoning_tokens > 0)", () => {
  it("starved first call → auto-retry with expanded budget → returns visible content", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-5-nano", "live-openai");

    // First call: empty content, finish=length, reasoning_tokens=20 (all budget burned thinking).
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIReasoningResponse({
        promptTokens: 20,
        completionTokens: 20,
        reasoningTokens: 20,
        finishReason: "length",
      }),
    );
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIReasoningResponse({
        content: "pong",
        promptTokens: 20,
        completionTokens: 50,
        reasoningTokens: 45,
        finishReason: "stop",
      }),
    );

    const result = await port.generateText({
      taskType: "t",
      prompt: "Say pong",
      maxOutputTokens: 20,
    });

    expect(result.text).toBe("pong");
    expect(result.usage.reasoningTokens).toBe(45);
    expect(result.usage.outputTokens).toBe(50); // includes the reasoning tokens
  });

  it("populates reasoningTokens in returned TokenUsage when the provider reports them", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-5-nano", "live-openai");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIReasoningResponse({
        content: "ok",
        promptTokens: 5,
        completionTokens: 100,
        reasoningTokens: 90,
        finishReason: "stop",
      }),
    );

    const result = await port.generateText({
      taskType: "t",
      prompt: "x",
      maxOutputTokens: 200,
    });

    expect(result.usage.reasoningTokens).toBe(90);
    expect(result.usage.outputTokens).toBe(100);
  });

  it("does NOT populate reasoningTokens when provider reports 0", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live-openai");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIReasoningResponse({
        content: "hello",
        promptTokens: 5,
        completionTokens: 10,
        reasoningTokens: 0,
        finishReason: "stop",
      }),
    );

    const result = await port.generateText({
      taskType: "t",
      prompt: "x",
      maxOutputTokens: 50,
    });

    expect(result.usage.reasoningTokens).toBeUndefined();
  });
});

// ─── Mixed: content + reasoning both present ─────────────────────────

describe("Group A: mixed shape (content present AND message.reasoning populated)", () => {
  it("returns content as text, ignores reasoning field for output", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "gpt-oss-120b": { inputPer1M: 0.65, outputPer1M: 0.85 } },
    });
    const port = adapter.createLLMPort("gpt-oss-120b", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildCerebrasReasoningResponse({
        reasoning: "Long internal CoT with secrets",
        content: "Hello, world!",
        promptTokens: 10,
        completionTokens: 50,
        finishReason: "stop",
      }),
    );

    const result = await port.generateText({
      taskType: "t",
      prompt: "x",
      maxOutputTokens: 100,
    });

    expect(result.text).toBe("Hello, world!");
    // Adapter still recognizes this as a reasoning model (for future-call optimization)
    // but doesn't trigger starved-retry because content is present.
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
  });
});

// ─── Non-reasoning baseline (control) ────────────────────────────────

describe("Group A: standard chat model (control case)", () => {
  it("does NOT trigger reasoning-starved retry on a normal short response", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live-openai");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "hi",
        promptTokens: 5,
        completionTokens: 5,
        finishReason: "stop",
      }),
    );

    const result = await port.generateText({
      taskType: "t",
      prompt: "x",
      maxOutputTokens: 20,
    });

    expect(result.text).toBe("hi");
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
  });

  it("does NOT trigger retry on empty-content response when there's no reasoning signal", async () => {
    // finish=length but no reasoning_tokens, no message.reasoning → just a
    // genuinely truncated normal response. Don't waste a retry.
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live-openai");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "",
        promptTokens: 5,
        completionTokens: 5,
        finishReason: "length",
      }),
    );

    const result = await port.generateText({
      taskType: "t",
      prompt: "x",
      maxOutputTokens: 20,
    });

    expect(result.text).toBe("");
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
  });
});
