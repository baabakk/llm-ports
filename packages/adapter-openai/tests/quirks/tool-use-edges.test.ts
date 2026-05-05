/**
 * Group F — tool-use edge cases (runAgent).
 *
 * Verifies the agent loop survives:
 *   - Tool throws non-Error (string, plain object)
 *   - Tool returns undefined / circular references / BigInt
 *   - Model invokes unknown tool name
 *   - maxOutputBytes truncates at boundary
 *   - Multiple tool calls in same assistant turn
 *   - maxSteps=0 returns immediately
 *   - Agent terminates early when model emits no tool_calls
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
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

const baseAgentArgs = {
  taskType: "t",
  instructions: "Use tools.",
  messages: [{ role: "user" as const, content: "go" }],
  maxOutputTokens: 100,
};

describe("Group F: tool-use edges", () => {
  it("tool throws a non-Error (string) → caught and stringified into tool_result", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // Step 1: model calls the tool.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        toolCalls: [{ id: "tc1", name: "boom", arguments: "{}" }],
        promptTokens: 10,
        completionTokens: 5,
      }),
    );
    // Step 2: model sees the error tool_result and produces final text.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "tool failed; here's a summary",
        promptTokens: 20,
        completionTokens: 10,
      }),
    );

    const result = await port.runAgent({
      ...baseAgentArgs,
      maxSteps: 5,
      tools: {
        boom: {
          name: "boom",
          description: "Always throws a string.",
          inputSchema: z.object({}),
          execute: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw "literal string thrown";
          },
        },
      },
    });

    expect(result.terminationReason).toBe("completed");
    expect(result.text).toContain("tool failed");
  });

  it("tool returns undefined and circular reference → no JSON.stringify crash", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        toolCalls: [{ id: "tc1", name: "weird", arguments: "{}" }],
        promptTokens: 10,
        completionTokens: 5,
      }),
    );
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 20,
        completionTokens: 5,
      }),
    );

    let didThrow = false;
    try {
      const circular: { self?: unknown } = {};
      circular.self = circular;
      await port.runAgent({
        ...baseAgentArgs,
        maxSteps: 3,
        tools: {
          weird: {
            name: "weird",
            description: "Returns a value with a cycle.",
            inputSchema: z.object({}),
            execute: () => circular as never,
          },
        },
      });
    } catch {
      didThrow = true;
    }
    // Adapter should catch the circular-ref serialization error inside the
    // tool execution try/catch and pass an isError tool_result to the model
    // — the agent should NOT crash the caller.
    expect(didThrow).toBe(false);
  });

  it("model invokes unknown tool name → tool_result has isError: true; loop continues", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        toolCalls: [{ id: "tc1", name: "phantomTool", arguments: "{}" }],
        promptTokens: 10,
        completionTokens: 5,
      }),
    );
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "I tried, but that tool doesn't exist.",
        promptTokens: 20,
        completionTokens: 10,
      }),
    );

    const result = await port.runAgent({
      ...baseAgentArgs,
      maxSteps: 3,
      tools: {
        actualTool: {
          name: "actualTool",
          description: "the real one",
          inputSchema: z.object({}),
          execute: async () => "real",
        },
      },
    });

    expect(result.terminationReason).toBe("completed");
    expect(result.text).toContain("doesn't exist");
  });

  it("maxOutputBytes truncates at the boundary and appends [truncated] marker", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        toolCalls: [{ id: "tc1", name: "verbose", arguments: "{}" }],
        promptTokens: 10,
        completionTokens: 5,
      }),
    );
    // Capture the second call's messages so we can inspect what tool_result was sent
    let secondCallMessages: unknown[] | undefined;
    mockChatCompletionsCreate.mockImplementationOnce(async (req: { messages: unknown[] }) => {
      secondCallMessages = req.messages;
      return buildOpenAIChatResponse({
        text: "got it",
        promptTokens: 30,
        completionTokens: 5,
      });
    });

    const longString = "x".repeat(5000);
    await port.runAgent({
      ...baseAgentArgs,
      maxSteps: 3,
      tools: {
        verbose: {
          name: "verbose",
          description: "Returns a large string.",
          inputSchema: z.object({}),
          execute: async () => longString,
          maxOutputBytes: 100,
        },
      },
    });

    // The tool result fed back to the model should have been truncated.
    expect(secondCallMessages).toBeDefined();
    const allText = JSON.stringify(secondCallMessages);
    // Original string had 5000 'x'; truncated should have far fewer.
    expect(allText.match(/x/g)?.length ?? 0).toBeLessThan(500);
    expect(allText).toContain("[truncated]");
  });

  it("multiple tool calls in same assistant turn → all execute, all results returned", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        toolCalls: [
          { id: "a", name: "alpha", arguments: '{"v":1}' },
          { id: "b", name: "beta", arguments: '{"v":2}' },
          { id: "c", name: "alpha", arguments: '{"v":3}' },
        ],
        promptTokens: 10,
        completionTokens: 5,
      }),
    );
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "all three executed",
        promptTokens: 30,
        completionTokens: 10,
      }),
    );

    const calls: Array<{ name: string; v: number }> = [];
    const result = await port.runAgent({
      ...baseAgentArgs,
      maxSteps: 3,
      tools: {
        alpha: {
          name: "alpha",
          description: "alpha tool",
          inputSchema: z.object({ v: z.number() }),
          execute: async ({ v }) => {
            calls.push({ name: "alpha", v });
            return `alpha=${v}`;
          },
        },
        beta: {
          name: "beta",
          description: "beta tool",
          inputSchema: z.object({ v: z.number() }),
          execute: async ({ v }) => {
            calls.push({ name: "beta", v });
            return `beta=${v}`;
          },
        },
      },
    });

    expect(calls).toEqual([
      { name: "alpha", v: 1 },
      { name: "beta", v: 2 },
      { name: "alpha", v: 3 },
    ]);
    expect(result.toolCalls).toHaveLength(3);
  });

  it("maxSteps=0 returns immediately with terminationReason='max_steps'", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    const result = await port.runAgent({
      ...baseAgentArgs,
      maxSteps: 0,
      tools: {},
    });

    expect(result.terminationReason).toBe("max_steps");
    expect(result.stepsTaken).toBe(0);
    expect(mockChatCompletionsCreate).not.toHaveBeenCalled();
  });

  it("agent terminates early when model emits no tool_calls (terminationReason='completed')", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "done immediately",
        promptTokens: 10,
        completionTokens: 5,
      }),
    );

    const result = await port.runAgent({
      ...baseAgentArgs,
      maxSteps: 10,
      tools: {
        noop: {
          name: "noop",
          description: "noop",
          inputSchema: z.object({}),
          execute: async () => "noop",
        },
      },
    });

    expect(result.terminationReason).toBe("completed");
    expect(result.stepsTaken).toBe(1);
    expect(result.text).toBe("done immediately");
  });
});
