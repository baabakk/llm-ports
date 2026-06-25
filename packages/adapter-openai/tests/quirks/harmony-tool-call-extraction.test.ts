/**
 * ASK 1 — Harmony tool-call extraction (alpha.23+).
 *
 * gpt-oss models from OpenAI use a "harmony" output format where a tool
 * call is encoded as a structured channel:
 *
 *   <|channel|>commentary to=functions.write_file<|constrain|>json<|message|>
 *   {"path":"x.ts","content":"..."}
 *
 * Cerebras and Groq translate harmony channels into standard `tool_calls` on
 * the response. DeepInfra (at time of writing) passes the raw harmony channel
 * through as `message.reasoning_content`, leaving `tool_calls` empty —
 * making the assistant turn look empty to the agentic loop.
 *
 * This test verifies that when `tool_calls` is empty AND `reasoning_content`
 * contains a parseable harmony tool call, the adapter extracts it and the
 * runAgent loop executes it the same way as a standard tool call.
 *
 * The parser must also exit gracefully when reasoning_content is not valid
 * harmony (prose CoT, bare JSON, malformed), letting the zero-tool-call
 * rescue (ASK 2) handle the prose-only case via a corrective retry.
 *
 * Empirical motivation: ADW 2026-06-19 diagnostic.
 * See llm-ports#46 / discussion #50.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildOpenAIChatResponse,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { parseHarmonyToolCalls } from "../../src/content.js";
import { createOpenAIAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("parseHarmonyToolCalls (pure helper)", () => {
  it("extracts a single harmony tool call with name + args", () => {
    const reasoningContent =
      `<|channel|>commentary to=functions.write_file<|constrain|>json<|message|>` +
      `{"path":"hello.ts","content":"export const x = 1;"}`;
    const calls = parseHarmonyToolCalls(reasoningContent);
    expect(calls).not.toBeNull();
    expect(calls!.length).toBe(1);
    expect(calls![0]!.function.name).toBe("write_file");
    expect(JSON.parse(calls![0]!.function.arguments)).toEqual({
      path: "hello.ts",
      content: "export const x = 1;",
    });
    expect(calls![0]!.id).toMatch(/^harmony-/);
    expect(calls![0]!.type).toBe("function");
  });

  it("extracts multiple harmony tool calls in sequence", () => {
    const reasoningContent =
      `<|channel|>commentary to=functions.read_file<|message|>` +
      `{"path":"a.ts"}` +
      `<|channel|>commentary to=functions.write_file<|message|>` +
      `{"path":"b.ts","content":"x"}`;
    const calls = parseHarmonyToolCalls(reasoningContent);
    expect(calls).not.toBeNull();
    expect(calls!.length).toBe(2);
    expect(calls![0]!.function.name).toBe("read_file");
    expect(calls![1]!.function.name).toBe("write_file");
  });

  it("accepts the tool channel marker variant", () => {
    const reasoningContent =
      `<|channel|>tool to=functions.list_files<|message|>` +
      `{"glob":"src/**/*.ts"}`;
    const calls = parseHarmonyToolCalls(reasoningContent);
    expect(calls).not.toBeNull();
    expect(calls![0]!.function.name).toBe("list_files");
  });

  it("returns null for empty input", () => {
    expect(parseHarmonyToolCalls("")).toBeNull();
    expect(parseHarmonyToolCalls(null)).toBeNull();
    expect(parseHarmonyToolCalls(undefined)).toBeNull();
  });

  it("returns null for prose chain-of-thought (no harmony markers)", () => {
    // The mimo-style prose case. The ASK 2 rescue handles this with a
    // corrective retry, not the harmony parser.
    const reasoning =
      "I need to read the contracts file first. Then I'll implement the " +
      "service. Let me start by listing the directory.";
    expect(parseHarmonyToolCalls(reasoning)).toBeNull();
  });

  it("returns null for bare JSON without harmony markers (the Babak probe case)", () => {
    // The empirical case from Babak's 2026-06-19 DeepInfra probe: bare
    // JSON-looking fragment with no channel marker or tool name. Parser
    // can't recover the tool name, so it correctly returns null and the
    // zero-tool-call rescue takes over.
    expect(parseHarmonyToolCalls('{"path": "", "depth": 3}\n')).toBeNull();
  });

  it("returns null for malformed JSON inside a harmony marker", () => {
    const reasoning =
      `<|channel|>commentary to=functions.write_file<|message|>` +
      `{path: "missing-quotes"}`;
    expect(parseHarmonyToolCalls(reasoning)).toBeNull();
  });

  it("does not match a harmony-looking marker without to=functions.NAME", () => {
    const reasoning = `<|channel|>analysis<|message|>{"some":"thought"}`;
    expect(parseHarmonyToolCalls(reasoning)).toBeNull();
  });

  it("generates unique IDs per call", () => {
    const reasoningContent =
      `<|channel|>commentary to=functions.f1<|message|>{}<|channel|>commentary to=functions.f2<|message|>{}`;
    const calls = parseHarmonyToolCalls(reasoningContent);
    expect(calls!.length).toBe(2);
    expect(calls![0]!.id).not.toBe(calls![1]!.id);
  });
});

describe("runAgent — harmony tool-call extraction in the loop (alpha.23+)", () => {
  it("when tool_calls is empty and reasoning_content has a harmony call, executes the extracted call", async () => {
    const MODEL = "openai/gpt-oss-120b";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.deepinfra.com/v1/openai",
      pricingOverrides: { [MODEL]: { inputPer1M: 0.15, outputPer1M: 0.6 } },
    });
    const port = adapter.createLLMPort(MODEL, "deepinfra");

    // First call: standard tool_calls is empty, harmony tool call is in reasoning_content.
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
            tool_calls: [],
            reasoning_content:
              `<|channel|>commentary to=functions.echo<|message|>{"value":"hi"}`,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    });

    // Second call: model sees the tool result and emits a normal final response.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "I echoed it.",
        promptTokens: 60,
        completionTokens: 10,
        modelId: MODEL,
      }),
    );

    const executedToolInputs: unknown[] = [];
    const result = await port.runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "echo hi" }],
      tools: {
        echo: {
          name: "echo",
          description: "Echo input",
          inputSchema: { type: "object" as const, properties: { value: { type: "string" as const } }, required: ["value"] },
          execute: async (input: unknown) => {
            executedToolInputs.push(input);
            return "echoed: hi";
          },
        },
      },
      maxSteps: 5,
    });

    // The harmony-extracted tool call must have actually executed.
    expect(executedToolInputs.length).toBe(1);
    expect(executedToolInputs[0]).toEqual({ value: "hi" });
    expect(result.toolCalls?.length).toBe(1);
    expect(result.toolCalls?.[0]!.name).toBe("echo");
    expect(result.text).toBe("I echoed it.");
    expect(result.terminationReason).toBe("completed");
  });

  it("when standard tool_calls is populated, harmony parsing is skipped (regression check)", async () => {
    const MODEL = "gpt-oss-120b";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.cerebras.ai/v1",
      pricingOverrides: { [MODEL]: { inputPer1M: 0.25, outputPer1M: 0.35 } },
    });
    const port = adapter.createLLMPort(MODEL, "cerebras");

    // Cerebras shape: standard tool_calls is populated. reasoning_content is
    // ALSO present (Cerebras emits CoT into the reasoning field). The
    // standard tool_calls must win — we must not extract harmony AND
    // execute the standard call too.
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
            tool_calls: [
              {
                id: "real-1",
                type: "function",
                function: { name: "echo", arguments: '{"value":"standard"}' },
              },
            ],
            reasoning: "User wants echo. I will call the echo tool.",
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 },
    });

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "done",
        promptTokens: 60,
        completionTokens: 5,
        modelId: MODEL,
      }),
    );

    let toolExecutions = 0;
    const result = await port.runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "echo standard" }],
      tools: {
        echo: {
          name: "echo",
          description: "Echo input",
          inputSchema: { type: "object" as const, properties: { value: { type: "string" as const } }, required: ["value"] },
          execute: async () => {
            toolExecutions++;
            return "ok";
          },
        },
      },
      maxSteps: 5,
    });

    expect(toolExecutions).toBe(1); // Standard tool call executed exactly once
    expect(result.toolCalls?.length).toBe(1);
    expect(result.toolCalls?.[0]!.input).toEqual({ value: "standard" });
  });

  it("when both tool_calls and reasoning_content are empty, terminates as completed (case A — handled by ASK 2)", async () => {
    const MODEL = "test-model";
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { [MODEL]: { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort(MODEL, "test");

    // ASK 2 rescue kicks in if the prose case fires. For this test we
    // pre-empt by routing the model into a configuration where the rescue
    // won't double-fire. Just verifying ASK 1 doesn't synthesize anything
    // from absent reasoning_content.
    mockChatCompletionsCreate.mockResolvedValue(
      buildOpenAIChatResponse({
        text: "I would call the tool but I'm choosing not to.",
        promptTokens: 20,
        completionTokens: 10,
        modelId: MODEL,
        finishReason: "stop",
      }),
    );

    let toolExecutions = 0;
    const result = await port.runAgent({
      taskType: "test",
      messages: [{ role: "user", content: "do something" }],
      tools: {
        echo: {
          name: "echo",
          description: "Echo",
          inputSchema: { type: "object" as const, properties: {}, required: [] },
          execute: async () => {
            toolExecutions++;
            return "ok";
          },
        },
      },
      maxSteps: 1, // cap so ASK 2's rescue doesn't cascade more than once
    });

    // ASK 1 didn't synthesize anything. ASK 2 (when shipped) may add a rescue retry
    // but the result is still that no tool was executed because the model still
    // didn't comply on retry in this test.
    expect(toolExecutions).toBe(0);
    expect(result.terminationReason).toBe("completed");
  });

  it("emits onRetry with reason 'harmony-tool-call-extracted' when extraction succeeds (ASK 3)", async () => {
    const MODEL = "openai/gpt-oss-120b";
    const retryEvents: Array<{ reason: string }> = [];
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.deepinfra.com/v1/openai",
      pricingOverrides: { [MODEL]: { inputPer1M: 0.15, outputPer1M: 0.6 } },
      onRetry: (e) => {
        retryEvents.push({ reason: e.reason });
      },
    });
    const port = adapter.createLLMPort(MODEL, "deepinfra");

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
            tool_calls: [],
            reasoning_content:
              `<|channel|>commentary to=functions.echo<|message|>{"value":"hi"}`,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    });

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "done",
        promptTokens: 60,
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
          inputSchema: { type: "object" as const, properties: { value: { type: "string" as const } }, required: ["value"] },
          execute: async () => "ok",
        },
      },
      maxSteps: 5,
    });

    const harmonyEvents = retryEvents.filter((e) => e.reason === "harmony-tool-call-extracted");
    expect(harmonyEvents.length).toBe(1);
  });
});
