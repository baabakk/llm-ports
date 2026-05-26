/**
 * Gemini multi-turn runAgent via tool/function calling (issue #11, alpha.9).
 *
 * v0.1 alpha.5–alpha.8 shipped a single-turn shim. alpha.9 wires the full
 * loop: tools translated to Gemini's functionDeclarations shape, the model
 * emits functionCall parts, the adapter executes the tools and sends back
 * functionResponse parts until the model returns text only (terminationReason
 * "completed") or maxSteps is reached ("max_steps").
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildGeminiResponse,
  mockGenerateContent,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { z } from "zod";
import { createGoogleAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
});

const adapter = createGoogleAdapter({ apiKey: "test" });
const port = adapter.createLLMPort("gemini-2.5-flash", "test");

describe("runAgent — Gemini multi-turn", () => {
  it("single-turn: model returns text only, no tools invoked", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({ text: "The weather is sunny.", promptTokens: 10, outputTokens: 5 }),
    );

    const result = await port.runAgent({
      taskType: "test",
      instructions: "Answer concisely.",
      messages: [{ role: "user", content: "What is the weather?" }],
      tools: {},
    });

    expect(result.text).toBe("The weather is sunny.");
    expect(result.stepsTaken).toBe(1);
    expect(result.terminationReason).toBe("completed");
    expect(result.toolCalls).toHaveLength(0);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it("multi-turn: executes one tool, then returns text", async () => {
    // First call: model emits functionCall
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({
        functionCall: { name: "getWeather", args: { city: "Paris" } },
        promptTokens: 20,
        outputTokens: 10,
      }),
    );
    // Second call: model returns text after seeing the tool result
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({
        text: "It is sunny in Paris.",
        promptTokens: 30,
        outputTokens: 8,
      }),
    );

    const tools = {
      getWeather: {
        name: "getWeather",
        description: "Fetch weather for a city.",
        inputSchema: z.object({ city: z.string() }),
        execute: async (input: { city: string }) => ({ tempC: 22, condition: "sunny", city: input.city }),
      },
    };

    const result = await port.runAgent({
      taskType: "test",
      instructions: "Use tools as needed.",
      messages: [{ role: "user", content: "Weather in Paris?" }],
      tools,
    });

    expect(result.text).toBe("It is sunny in Paris.");
    expect(result.stepsTaken).toBe(2);
    expect(result.terminationReason).toBe("completed");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      name: "getWeather",
      input: { city: "Paris" },
      output: { tempC: 22, condition: "sunny", city: "Paris" },
    });
    // Aggregated usage = sum of both turns
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(18);
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it("forwards tools as Gemini Tool[] shape with functionDeclarations", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({ text: "ok", promptTokens: 5, outputTokens: 2 }),
    );

    const tools = {
      ping: {
        name: "ping",
        description: "Test tool.",
        inputSchema: z.object({ host: z.string() }),
        execute: async () => "pong",
      },
    };

    await port.runAgent({
      taskType: "test",
      instructions: "test",
      messages: [{ role: "user", content: "ping" }],
      tools,
    });

    const callArgs = mockGenerateContent.mock.calls[0]![0] as {
      config: { tools?: Array<{ functionDeclarations: Array<{ name: string }> }> };
    };
    expect(callArgs.config.tools).toBeDefined();
    expect(callArgs.config.tools![0]!.functionDeclarations).toHaveLength(1);
    expect(callArgs.config.tools![0]!.functionDeclarations[0]!.name).toBe("ping");
  });

  it("does NOT forward tools when the tools object is empty", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({ text: "ok", promptTokens: 5, outputTokens: 2 }),
    );

    await port.runAgent({
      taskType: "test",
      instructions: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
    });

    const callArgs = mockGenerateContent.mock.calls[0]![0] as {
      config: { tools?: unknown };
    };
    expect(callArgs.config.tools).toBeUndefined();
  });

  it("terminationReason = max_steps when tool calls exceed the budget", async () => {
    // Three calls in a row, all emitting functionCall; maxSteps=2 stops after 2.
    mockGenerateContent.mockResolvedValue(
      buildGeminiResponse({
        functionCall: { name: "loop", args: { n: 1 } },
        promptTokens: 10,
        outputTokens: 5,
      }),
    );

    const tools = {
      loop: {
        name: "loop",
        description: "Loops forever.",
        inputSchema: z.object({ n: z.number() }),
        execute: async () => "again",
      },
    };

    const result = await port.runAgent({
      taskType: "test",
      instructions: "test",
      messages: [{ role: "user", content: "loop" }],
      tools,
      maxSteps: 2,
    });

    expect(result.stepsTaken).toBe(2);
    expect(result.terminationReason).toBe("max_steps");
    expect(result.toolCalls).toHaveLength(2);
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it("tool execution errors are returned as isError tool_result, loop continues", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({
        functionCall: { name: "explode", args: {} },
        promptTokens: 10,
        outputTokens: 5,
      }),
    );
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({ text: "I see the tool failed.", promptTokens: 15, outputTokens: 6 }),
    );

    const tools = {
      explode: {
        name: "explode",
        description: "Always throws.",
        inputSchema: z.object({}),
        execute: async () => {
          throw new Error("boom");
        },
      },
    };

    const result = await port.runAgent({
      taskType: "test",
      instructions: "test",
      messages: [{ role: "user", content: "trigger" }],
      tools,
    });

    expect(result.text).toBe("I see the tool failed.");
    expect(result.terminationReason).toBe("completed");
    expect(result.stepsTaken).toBe(2);
  });

  it("unknown tool name produces an isError tool_result rather than crashing", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({
        functionCall: { name: "unregistered", args: {} },
        promptTokens: 10,
        outputTokens: 5,
      }),
    );
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({ text: "Sorry, that tool is not available.", promptTokens: 15, outputTokens: 7 }),
    );

    const result = await port.runAgent({
      taskType: "test",
      instructions: "test",
      messages: [{ role: "user", content: "call unknown" }],
      tools: {},
    });

    expect(result.terminationReason).toBe("completed");
    expect(result.toolCalls).toHaveLength(0); // unknown tool — not registered as a successful call
  });
});
