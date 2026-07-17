/**
 * Runtime reasoning-detection broadening (alpha.22+).
 *
 * Two changes to the runtime detection path:
 *
 * 1. `learnFromResponse` now also reads `message.reasoning_content`
 *    (DeepInfra's harmony field), not just `message.reasoning` and
 *    `usage.completion_tokens_details.reasoning_tokens`.
 *
 * 2. `reasoningStarvedResponse` no longer requires `finish_reason === "length"`.
 *    The DeepInfra-gpt-oss empirical case returns `finish_reason: "stop"` with
 *    empty content + non-empty reasoning_content. Relaxed to accept either
 *    "length" or "stop" when the noVisibleOutput + reasoning-signal
 *    conjunction holds.
 *
 * Empirical motivation: ADW 2026-06-19 raw 2-turn probe against DeepInfra's
 * openai/gpt-oss-120b. See llm-ports#46 / discussion #49.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildDeepInfraHarmonyResponse,
  buildOpenAIChatResponse,
  buildOpenAIReasoningResponse,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints, getEffectiveCapabilities } from "../../src/capabilities.js";
import { createOpenAIAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("learnFromResponse — reasoning_content field detection (alpha.22+)", () => {
  it("marks model as reasoning after observing non-empty reasoning_content (DeepInfra harmony)", async () => {
    const MODEL = "openai/gpt-oss-120b";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.deepinfra.com/v1/openai",
      pricingOverrides: { [MODEL]: { inputPer1M: 0.15, outputPer1M: 0.6 } },
    });
    const port = adapter.createLLMPort(MODEL, "deepinfra");

    // DeepInfra responds with the harmony shape: empty content, reasoning_content populated.
    // The adapter retries once with expanded budget; for the test the retry returns a
    // normal response to let the original call complete.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildDeepInfraHarmonyResponse({
        reasoningContent: '{"path": "hello.txt", "content": "hi"}\n',
        promptTokens: 30,
        completionTokens: 46,
        modelId: MODEL,
        finishReason: "stop",
      }),
    );
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 30,
        completionTokens: 5,
        modelId: MODEL,
      }),
    );

    await port.generateText({
      taskType: "test",
      messages: [{ role: "user" as const, content: "hi" }],
      maxOutputTokens: 100,
    });

    // After the call, the learner should have recorded that this model is a reasoning model.
    expect(getEffectiveCapabilities(MODEL, undefined).reasoningModel).toBe(true);
  });

  it("does NOT mark a model as reasoning when reasoning_content is absent/empty (regression)", async () => {
    const MODEL = "gpt-4o-mini";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 0.15, outputPer1M: 0.6 } },
    });
    const port = adapter.createLLMPort(MODEL, "openai");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "normal response",
        promptTokens: 30,
        completionTokens: 5,
      }),
    );

    await port.generateText({
      taskType: "test",
      messages: [{ role: "user" as const, content: "hi" }],
      maxOutputTokens: 100,
    });

    expect(getEffectiveCapabilities(MODEL, undefined).reasoningModel).toBeFalsy();
  });
});

describe("reasoningStarvedResponse — finish_reason: stop now triggers rescue (alpha.22+)", () => {
  it("DeepInfra gpt-oss starvation (finish=stop + empty content + reasoning_content) triggers retry-with-expanded-budget", async () => {
    const MODEL = "openai/gpt-oss-120b";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.deepinfra.com/v1/openai",
      pricingOverrides: { [MODEL]: { inputPer1M: 0.15, outputPer1M: 0.6 } },
    });
    const port = adapter.createLLMPort(MODEL, "deepinfra");

    // First call: starved (DeepInfra harmony). content="", reasoning_content populated, finish=stop.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildDeepInfraHarmonyResponse({
        reasoningContent: '{"path": "", "depth": 3}\n',
        promptTokens: 100,
        completionTokens: 46,
        modelId: MODEL,
        finishReason: "stop",
      }),
    );
    // Retry: model has the bigger budget now, returns visible content.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "Here is the answer.",
        promptTokens: 100,
        completionTokens: 20,
        modelId: MODEL,
      }),
    );

    const result = await port.generateText({
      taskType: "test",
      messages: [{ role: "user" as const, content: "Build something" }],
      maxOutputTokens: 64,
    });

    // Two HTTP calls happened — the alpha.22 broadening triggered the
    // starvation rescue (where pre-alpha.22 the finish=stop guard would
    // have silently let the empty response through). The model IS already
    // pre-seeded as reasoning (post-normalization of `openai/gpt-oss-120b`),
    // so the budget multiplier was applied to BOTH calls; the rescue's
    // value here is observability + a chance for the model to produce
    // visible output on a retry, not a budget escalation.
    expect(mockChatCompletionsCreate.mock.calls.length).toBe(2);
    // Returned text is the visible content from the retry, not the reasoning blob.
    expect(result.text).toBe("Here is the answer.");
    // The first call was the starved attempt; the second is the rescue retry.
    const firstCall = mockChatCompletionsCreate.mock.calls[0]![0] as { max_completion_tokens?: number; max_tokens?: number };
    const secondCall = mockChatCompletionsCreate.mock.calls[1]![0] as { max_completion_tokens?: number; max_tokens?: number };
    // Reasoning multiplier is applied at materialize-request time, so both
    // calls share the same expanded budget. The rescue retries with the
    // same shape; if the provider returns a stable response on retry,
    // the loop closes successfully.
    const firstBudget = firstCall.max_completion_tokens ?? firstCall.max_tokens ?? 0;
    const secondBudget = secondCall.max_completion_tokens ?? secondCall.max_tokens ?? 0;
    expect(firstBudget).toBeGreaterThanOrEqual(640); // 64 * default reasoning multiplier
    expect(secondBudget).toBeGreaterThanOrEqual(640);
  });

  it("starvation rescue still fires for OpenAI o-series shape (finish=length + reasoning_tokens > 0)", async () => {
    // Regression: the alpha.22 broadening must not break the original
    // OpenAI-native reasoning path.
    const MODEL = "future-reasoning-model";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 0.5, outputPer1M: 2.0 } },
    });
    const port = adapter.createLLMPort(MODEL, "openai");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIReasoningResponse({
        promptTokens: 50,
        reasoningTokens: 60,
        modelId: MODEL,
      }),
    );
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "visible output",
        promptTokens: 50,
        completionTokens: 10,
        modelId: MODEL,
      }),
    );

    const result = await port.generateText({
      taskType: "test",
      messages: [{ role: "user" as const, content: "test" }],
      maxOutputTokens: 64,
    });

    expect(mockChatCompletionsCreate.mock.calls.length).toBe(2);
    expect(result.text).toBe("visible output");
  });

  it("does NOT trigger rescue when content is non-empty (no starvation, regression check)", async () => {
    const MODEL = "openai/gpt-oss-120b";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.deepinfra.com/v1/openai",
      pricingOverrides: { [MODEL]: { inputPer1M: 0.15, outputPer1M: 0.6 } },
    });
    const port = adapter.createLLMPort(MODEL, "deepinfra");

    // Model emitted both reasoning_content AND a real answer in content.
    // Despite the reasoning signal, there's no starvation; one call only.
    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here is the answer in content.",
            reasoning_content: "Some thinking happened here.",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });

    const result = await port.generateText({
      taskType: "test",
      messages: [{ role: "user" as const, content: "test" }],
      maxOutputTokens: 100,
    });

    expect(mockChatCompletionsCreate.mock.calls.length).toBe(1);
    expect(result.text).toBe("Here is the answer in content.");
  });

  it("does NOT trigger rescue when no reasoning signal is present (genuine empty completion, regression check)", async () => {
    const MODEL = "gpt-4o-mini";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 0.15, outputPer1M: 0.6 } },
    });
    const port = adapter.createLLMPort(MODEL, "openai");

    // The adapter's empty-response detection (EmptyResponseError) wraps the
    // "no content + no tool_calls + no reasoning signal" case in its OWN
    // single retry. To test "no spurious starvation rescue", we use a
    // response that has SOME visible content but no reasoning signal — the
    // starvation rescue must not fire.
    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 1, total_tokens: 51 },
    });

    const result = await port.generateText({
      taskType: "test",
      messages: [{ role: "user" as const, content: "test" }],
      maxOutputTokens: 100,
    });

    expect(mockChatCompletionsCreate.mock.calls.length).toBe(1);
    expect(result.text).toBe("ok");
  });

  it("does NOT trigger rescue when tool_calls is present (model successfully called a tool)", async () => {
    const MODEL = "openai/gpt-oss-120b";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.deepinfra.com/v1/openai",
      pricingOverrides: { [MODEL]: { inputPer1M: 0.15, outputPer1M: 0.6 } },
    });
    const port = adapter.createLLMPort(MODEL, "deepinfra");

    // Empty content + reasoning_content set + non-empty tool_calls = success.
    // Even though reasoning_content is present, the tool_call IS executable
    // output. Should not trigger starvation rescue.
    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            reasoning_content: "Thinking about which tool to call",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "write_file", arguments: '{"path":"a.txt","content":"hi"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    await port.generateText({
      taskType: "test",
      messages: [{ role: "user" as const, content: "test" }],
      maxOutputTokens: 100,
    });

    // Only one HTTP call should have happened.
    expect(mockChatCompletionsCreate.mock.calls.length).toBe(1);
  });
});
