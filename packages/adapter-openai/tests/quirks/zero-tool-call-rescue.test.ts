/**
 * ASK 2 — Zero-tool-call corrective rescue (alpha.23+).
 *
 * When the request includes a tools array but the model emits prose without
 * making any tool calls (finish_reason: "stop" or "length", content has text,
 * tool_calls empty, reasoning_content absent), retry once with a corrective
 * system message asking the model to use the standard tool_calls format.
 *
 * Empirical motivation: ADW 2026-06-19 — mimo-parasail in the multi-team
 * agentic build loop returned ~69 tokens of prose, zero tool_calls,
 * terminated as "completed" — false success because the orchestration
 * had no way to know the model SHOULD have called writeFile 8 times.
 *
 * Discriminator from reasoning starvation: prose case has non-empty
 * content; starvation case has empty content + reasoning signal.
 *
 * Discriminator from ASK 1 harmony case: prose case has empty
 * reasoning_content; harmony case has populated reasoning_content
 * (and gets handled by ASK 1 extraction first, in runAgent).
 *
 * Single-shot retry only — if the retry also returns prose, the
 * consumer's orchestration is responsible for handling it (e.g., ADW's
 * "0 files written → failure" guard).
 */

import { beforeEach, describe, expect, it } from "vitest";
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

describe("zero-tool-call prose rescue (alpha.23+)", () => {
  it("retries with corrective system message when model emits prose with tools available", async () => {
    const MODEL = "test-model";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort(MODEL, "test");

    // First call: model emits prose, no tool calls
    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I would call the echo tool with value 'hi' to handle this.",
            tool_calls: [],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 },
    });
    // Retry: model emits actual tool call after corrective system message
    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-2",
      object: "chat.completion",
      created: 2,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "echo", arguments: '{"value":"hi"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
    });
    // Final: tool result fed back, model wraps up
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "done",
        promptTokens: 90,
        completionTokens: 5,
        modelId: MODEL,
      }),
    );

    let toolExecutions = 0;
    const result = await port.runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "echo hi" }],
      tools: {
        echo: {
          name: "echo",
          description: "Echo input",
          inputSchema: {
            type: "object" as const,
            properties: { value: { type: "string" as const } },
            required: ["value"],
          },
          execute: async () => {
            toolExecutions++;
            return "ok";
          },
        },
      },
      maxSteps: 5,
    });

    // The rescue retry's tool call must have actually executed.
    expect(toolExecutions).toBe(1);
    expect(result.toolCalls?.length).toBe(1);
    expect(result.text).toBe("done");
    // 3 chat completions happened: original, rescue retry, follow-up.
    expect(mockChatCompletionsCreate.mock.calls.length).toBe(3);
  });

  it("rescue retry's request includes the corrective system message", async () => {
    const MODEL = "test-model";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort(MODEL, "test");

    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "I would echo it.", tool_calls: [] },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 50,
        completionTokens: 5,
        modelId: MODEL,
      }),
    );

    await port.runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "echo hi" }],
      tools: {
        echo: {
          name: "echo",
          description: "Echo",
          inputSchema: {
            type: "object" as const,
            properties: { value: { type: "string" as const } },
            required: ["value"],
          },
          execute: async () => "ok",
        },
      },
      maxSteps: 3,
    });

    // The rescue retry must have included the corrective system message
    expect(mockChatCompletionsCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
    const retryRequest = mockChatCompletionsCreate.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMessages = retryRequest.messages.filter((m) => m.role === "system");
    const correctiveExists = systemMessages.some((m) =>
      m.content.includes("did not include a tool call"),
    );
    expect(correctiveExists).toBe(true);
  });

  it("does NOT rescue when the request had NO tools (regression check)", async () => {
    const MODEL = "test-model";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort(MODEL, "test");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "Just a prose response.",
        promptTokens: 50,
        completionTokens: 5,
        modelId: MODEL,
      }),
    );

    await port.generateText({
      taskType: "test",
      prompt: "Tell me something",
    });

    // No tools → text response is the correct shape → no rescue
    expect(mockChatCompletionsCreate.mock.calls.length).toBe(1);
  });

  it("does NOT rescue when the model actually called tools (regression check)", async () => {
    const MODEL = "test-model";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort(MODEL, "test");

    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "tc", type: "function", function: { name: "echo", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 50,
        completionTokens: 5,
        modelId: MODEL,
      }),
    );

    await port.runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "do something" }],
      tools: {
        echo: {
          name: "echo",
          description: "Echo",
          inputSchema: { type: "object" as const, properties: {}, required: [] },
          execute: async () => "ok",
        },
      },
      maxSteps: 3,
    });

    // 2 calls (tool call + follow-up), no rescue
    expect(mockChatCompletionsCreate.mock.calls.length).toBe(2);
  });

  it("does NOT rescue when reasoning_content is populated (harmony case, handled by ASK 1)", async () => {
    const MODEL = "test-model";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort(MODEL, "test");

    // Response with prose content AND reasoning_content. ASK 2 must skip
    // because the harmony case is ASK 1's domain (even if no harmony tool
    // call is parseable, ASK 1 falls through to runAgent's empty-tool-calls
    // termination; ASK 2 here would over-fire).
    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I thought about it.",
            tool_calls: [],
            reasoning_content: "Some chain-of-thought went here.",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    await port.runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "do something" }],
      tools: {
        echo: {
          name: "echo",
          description: "Echo",
          inputSchema: { type: "object" as const, properties: {}, required: [] },
          execute: async () => "ok",
        },
      },
      maxSteps: 1,
    });

    // Only 1 call — ASK 2 didn't fire because reasoning_content present
    expect(mockChatCompletionsCreate.mock.calls.length).toBe(1);
  });

  it("does NOT rescue when content is empty (reasoning starvation case, handled by ASK reasoning rescue)", async () => {
    const MODEL = "test-model";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort(MODEL, "test");

    // Empty content + no reasoning signal + no tool_calls → genuine empty
    // response. Not a prose-rescue case; either reasoning starvation (if
    // signal present) or genuine empty (which the empty-response handler
    // catches separately).
    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "", tool_calls: [] },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 1, total_tokens: 51 },
    });

    await port.runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "do something" }],
      tools: {
        echo: {
          name: "echo",
          description: "Echo",
          inputSchema: { type: "object" as const, properties: {}, required: [] },
          execute: async () => "ok",
        },
      },
      maxSteps: 1,
    });

    // Only 1 call — ASK 2 didn't fire because content was empty
    expect(mockChatCompletionsCreate.mock.calls.length).toBe(1);
  });

  it("rescue is single-shot — if retry also returns prose, no second retry", async () => {
    const MODEL = "test-model";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort(MODEL, "test");

    // Both initial and retry return prose
    mockChatCompletionsCreate.mockResolvedValue({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "I would do that.", tool_calls: [] },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    const result = await port.runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "do it" }],
      tools: {
        echo: {
          name: "echo",
          description: "Echo",
          inputSchema: { type: "object" as const, properties: {}, required: [] },
          execute: async () => "ok",
        },
      },
      maxSteps: 1,
    });

    // Exactly 2 calls: original + one rescue retry. NOT 3+.
    expect(mockChatCompletionsCreate.mock.calls.length).toBe(2);
    expect(result.terminationReason).toBe("completed");
  });

  it("emits onRetry with reason 'zero-tool-call-prose-retry' on rescue (ASK 3)", async () => {
    const MODEL = "test-model";
    const retryEvents: Array<{ reason: string }> = [];
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 1, outputPer1M: 1 } },
      onRetry: (e) => retryEvents.push({ reason: e.reason }),
    });
    const port = adapter.createLLMPort(MODEL, "test");

    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "I would do that.", tool_calls: [] },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 50,
        completionTokens: 5,
        modelId: MODEL,
      }),
    );

    await port.runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "do it" }],
      tools: {
        echo: {
          name: "echo",
          description: "Echo",
          inputSchema: { type: "object" as const, properties: {}, required: [] },
          execute: async () => "ok",
        },
      },
      maxSteps: 3,
    });

    const proseRetryEvents = retryEvents.filter((e) => e.reason === "zero-tool-call-prose-retry");
    expect(proseRetryEvents.length).toBe(1);
  });
});
