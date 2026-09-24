/**
 * `generateChat`: tool calls surfaced, never executed, without streaming.
 *
 * The shape that had no implementation path before alpha.35. `runAgent` takes
 * tools and runs the loop itself; `streamChat` surfaces calls without running
 * them but only as a stream. A request with tools and no streaming, which is
 * the default for most agent frameworks and for an OpenAI-compatible HTTP
 * surface, could only be faked by draining a stream.
 *
 * The assertions that matter most are the ones about what must NOT happen:
 * a tool's `execute` must never run, and a malformed argument string must not
 * fail the turn.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildOpenAIChatResponse, mockChatCompletionsCreate, resetMocks } from "../helpers/mock-sdk.js";
import { createOpenAIAdapter } from "../../src/index.js";

const MODEL = "gpt-5";

function port() {
  return createOpenAIAdapter({ apiKey: "test" }).createLLMPort(MODEL, "openai");
}

/** A response carrying tool calls, in the shape the OpenAI API returns. */
function responseWithToolCalls(
  calls: Array<{ id: string; name: string; args: string }>,
  opts: { content?: string | null; finishReason?: string } = {},
): unknown {
  const base = buildOpenAIChatResponse({
    text: opts.content ?? "",
    promptTokens: 12,
    completionTokens: 5,
    modelId: MODEL,
  }) as {
    choices: Array<{ message: Record<string, unknown>; finish_reason?: string }>;
  };
  base.choices[0]!.message.content = opts.content ?? null;
  base.choices[0]!.message.tool_calls = calls.map((c) => ({
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: c.args },
  }));
  base.choices[0]!.finish_reason = opts.finishReason ?? "tool_calls";
  return base;
}

const weatherTool = {
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: vi.fn(async () => ({ tempC: 20 })),
};

describe("generateChat", () => {
  it("returns the assembled tool calls and never executes them", async () => {
    resetMocks();
    weatherTool.execute.mockClear();
    mockChatCompletionsCreate.mockResolvedValueOnce(
      responseWithToolCalls([{ id: "call_1", name: "get_weather", args: '{"city":"Lisbon"}' }]),
    );

    const result = await port().generateChat!({
      taskType: "chat",
      messages: [{ role: "user", content: "weather in Lisbon?" }],
      tools: { get_weather: weatherTool },
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.toolName).toBe("get_weather");
    expect(result.toolCalls[0]!.args).toEqual({ city: "Lisbon" });
    expect(result.toolCalls[0]!.toolCallId).toBe("call_1");
    // The whole reason this method exists rather than reusing runAgent.
    expect(weatherTool.execute).not.toHaveBeenCalled();
  });

  it("reports the provider's stop reason, so a tool turn is distinguishable from a finished answer", async () => {
    resetMocks();
    mockChatCompletionsCreate.mockResolvedValueOnce(
      responseWithToolCalls([{ id: "c1", name: "get_weather", args: "{}" }], {
        finishReason: "tool_calls",
      }),
    );
    const toolTurn = await port().generateChat!({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
      tools: { get_weather: weatherTool },
    });
    expect(toolTurn.stopReason).toBe("tool_calls");

    resetMocks();
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "It is sunny.", promptTokens: 3, completionTokens: 4, modelId: MODEL }),
    );
    const answered = await port().generateChat!({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(answered.text).toBe("It is sunny.");
    expect(answered.toolCalls).toHaveLength(0);
    expect(answered.stopReason).not.toBe("tool_calls");
  });

  it("keeps a malformed argument string instead of failing the turn", async () => {
    resetMocks();
    mockChatCompletionsCreate.mockResolvedValueOnce(
      responseWithToolCalls([{ id: "c1", name: "get_weather", args: '{"city": "Lis' }]),
    );

    const result = await port().generateChat!({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
      tools: { get_weather: weatherTool },
    });

    // One malformed call must not kill the turn: report it and move on.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.args).toBeUndefined();
    expect(result.toolCalls[0]!.rawArguments).toBe('{"city": "Lis');
  });

  it("reports usage and cost like every other method", async () => {
    resetMocks();
    mockChatCompletionsCreate.mockResolvedValueOnce(
      responseWithToolCalls([{ id: "c1", name: "get_weather", args: "{}" }]),
    );
    const result = await port().generateChat!({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
      tools: { get_weather: weatherTool },
    });
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.cost).toBeDefined();
    expect(result.modelId).toBe(MODEL);
    expect(result.providerAlias).toBe("openai");
  });

  it("sends the tools to the provider, and the tool-choice hint with them", async () => {
    resetMocks();
    mockChatCompletionsCreate.mockResolvedValueOnce(
      responseWithToolCalls([{ id: "c1", name: "get_weather", args: "{}" }]),
    );
    await port().generateChat!({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
      tools: { get_weather: weatherTool },
      toolChoice: "required",
    });

    const sent = mockChatCompletionsCreate.mock.calls[0]![0] as {
      tools?: unknown[];
      tool_choice?: string;
      stream?: boolean;
    };
    expect(sent.tools).toHaveLength(1);
    expect(sent.tool_choice).toBe("required");
    // Not a stream: that is the entire distinction from streamChat.
    expect(sent.stream).not.toBe(true);
  });

  it("works with no tools at all, which is just a chat turn", async () => {
    resetMocks();
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "hello", promptTokens: 1, completionTokens: 1, modelId: MODEL }),
    );
    const result = await port().generateChat!({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("hello");
    expect(result.toolCalls).toEqual([]);
  });
});
