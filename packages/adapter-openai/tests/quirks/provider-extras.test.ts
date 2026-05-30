/**
 * `providerExtras` option threading (alpha.16, closes the gap for vLLM
 * `chat_template_kwargs`, SGLang `regex`, Together `repetition_penalty`,
 * and any other provider-specific request field not modeled on the port).
 *
 * The adapter shallow-merges `providerExtras` into the SDK request body
 * AFTER the typed port fields are set, so a caller can override the
 * typed defaults (e.g. `providerExtras: { reasoning_effort: "high" }`
 * overrides whatever `reasoningEffort` was set to).
 *
 * The port does not validate; field semantics are provider-specific.
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

describe("providerExtras option", () => {
  it("forwards a single provider-specific field on generateText", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 5,
        completionTokens: 2,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "http://localhost:8000/v1",
      displayName: "vllm",
      pricingOverrides: {
        "Qwen/Qwen3-235B-A22B-Thinking": { inputPer1M: 0, outputPer1M: 0 },
      },
    });
    const port = adapter.createLLMPort("Qwen/Qwen3-235B-A22B-Thinking", "vllm");

    await port.generateText({
      taskType: "reason",
      prompt: "think hard",
      providerExtras: { chat_template_kwargs: { enable_thinking: true } },
    });

    const args = mockChatCompletionsCreate.mock.calls[0]![0] as {
      chat_template_kwargs?: { enable_thinking?: boolean };
    };
    expect(args.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("shallow-merges multiple provider-specific fields", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 5,
        completionTokens: 2,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "m": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("m", "compat");

    await port.generateText({
      taskType: "t",
      prompt: "x",
      providerExtras: {
        repetition_penalty: 1.1,
        guided_json: { type: "object" },
        regex: "[0-9]+",
      },
    });

    const args = mockChatCompletionsCreate.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(args.repetition_penalty).toBe(1.1);
    expect(args.guided_json).toEqual({ type: "object" });
    expect(args.regex).toBe("[0-9]+");
  });

  it("merges AFTER typed fields so caller can override the typed default", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 5,
        completionTokens: 2,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: {
        "openai/gpt-oss-120b": { inputPer1M: 0.15, outputPer1M: 0.6 },
      },
    });
    const port = adapter.createLLMPort("openai/gpt-oss-120b", "groq");

    await port.generateText({
      taskType: "t",
      prompt: "x",
      reasoningEffort: "low",
      providerExtras: { reasoning_effort: "high" },
    });

    const args = mockChatCompletionsCreate.mock.calls[0]![0] as {
      reasoning_effort?: string;
    };
    expect(args.reasoning_effort).toBe("high");
  });

  it("does NOT include extra fields when providerExtras is omitted", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 5,
        completionTokens: 2,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "m": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("m", "openai");

    await port.generateText({ taskType: "t", prompt: "x" });

    const args = mockChatCompletionsCreate.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect("chat_template_kwargs" in args).toBe(false);
    expect("repetition_penalty" in args).toBe(false);
    expect("guided_json" in args).toBe(false);
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
      baseURL: "http://localhost:30000/v1",
      displayName: "sglang",
      pricingOverrides: { "Qwen/Qwen3-30B-A3B": { inputPer1M: 0, outputPer1M: 0 } },
    });
    const port = adapter.createLLMPort("Qwen/Qwen3-30B-A3B", "sglang");

    await port.generateStructured({
      taskType: "t",
      prompt: "x is 1",
      schema: z.object({ x: z.number() }),
      providerExtras: { regex: "\\{\"x\":\\d+\\}" },
    });

    const args = mockChatCompletionsCreate.mock.calls[0]![0] as { regex?: string };
    expect(args.regex).toBe('\\{"x":\\d+\\}');
  });

  it("forwards on runAgent (every step in the loop)", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "done",
        promptTokens: 10,
        completionTokens: 5,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "m": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("m", "vllm");

    await port.runAgent({
      taskType: "agent",
      instructions: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      providerExtras: { chat_template_kwargs: { enable_thinking: true } },
    });

    const args = mockChatCompletionsCreate.mock.calls[0]![0] as {
      chat_template_kwargs?: { enable_thinking?: boolean };
    };
    expect(args.chat_template_kwargs).toEqual({ enable_thinking: true });
  });
});
