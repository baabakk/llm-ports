/**
 * Group E — streaming edge cases.
 *
 * Verifies streamText and streamStructured behave correctly at boundaries:
 *   - Empty stream
 *   - Mid-stream error
 *   - Capability rejection at stream-creation time → fallback retry
 *   - Transient 401 at stream-creation time → fallback retry
 *   - streamStructured: root-array JSON
 *   - streamStructured: brief invalid JSON during streaming
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildOpenAIChatStream,
  buildOpenAIError,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { createOpenAIAdapter } from "../../src/index.js";
import { AuthenticationError } from "@llm-ports/core";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("Group E: streaming edges", () => {
  it("stream yields 0 chunks → consumer's loop completes; no hang", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(buildOpenAIChatStream([]));

    const chunks: string[] = [];
    for await (const chunk of port.streamText({
      taskType: "t",
      prompt: "x",
      maxOutputTokens: 10,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);
  });

  it("stream yields 3 chunks then errors mid-flight → consumer sees first 3 then catches error", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // Custom iterator that yields 3 chunks then throws
    const errorStream: AsyncIterable<{
      choices: Array<{ delta?: { content?: string } }>;
    }> = {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "one " } }] };
        yield { choices: [{ delta: { content: "two " } }] };
        yield { choices: [{ delta: { content: "three" } }] };
        throw new Error("network reset mid-stream");
      },
    };
    mockChatCompletionsCreate.mockResolvedValueOnce(errorStream);

    const collected: string[] = [];
    let caught: unknown;
    try {
      for await (const chunk of port.streamText({
        taskType: "t",
        prompt: "x",
        maxOutputTokens: 50,
      })) {
        collected.push(chunk);
      }
    } catch (err) {
      caught = err;
    }
    expect(collected).toEqual(["one ", "two ", "three"]);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("network reset");
  });

  it("capability rejection at stream-creation → fallback retry succeeds", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-5-nano", "live");

    // First attempt: temperature rejection. Second attempt: success.
    mockChatCompletionsCreate
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 400,
          code: "unsupported_value",
          param: "temperature",
          message: "no temperature",
        }),
      )
      .mockResolvedValueOnce(buildOpenAIChatStream(["a", "b", "c"]));

    const collected: string[] = [];
    for await (const chunk of port.streamText({
      taskType: "t",
      prompt: "x",
      temperature: 0,
      maxOutputTokens: 50,
    })) {
      collected.push(chunk);
    }
    expect(collected).toEqual(["a", "b", "c"]);
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(2);
  });

  it("transient 401 at stream-creation (after prior success) → retried, succeeds", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      transientAuthBackoffMs: () => 0,
    });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // Establish hasSucceeded with a non-stream call first.
    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o",
      choices: [
        { index: 0, message: { role: "assistant", content: "init" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
    await port.generateText({ taskType: "t", prompt: "init", maxOutputTokens: 10 });

    // Now: stream creation fails with burst 401, then succeeds on retry.
    mockChatCompletionsCreate
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 401,
          code: "invalid_api_key",
          message: "Incorrect API key",
        }),
      )
      .mockResolvedValueOnce(buildOpenAIChatStream(["ok"]));

    const chunks: string[] = [];
    for await (const c of port.streamText({
      taskType: "t",
      prompt: "stream",
      maxOutputTokens: 10,
    })) {
      chunks.push(c);
    }
    expect(chunks).toEqual(["ok"]);
  });

  it("transient 401 at stream-creation BEFORE any success → propagates immediately", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      transientAuthBackoffMs: () => 0,
    });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockRejectedValueOnce(
      buildOpenAIError({
        status: 401,
        code: "invalid_api_key",
        message: "Incorrect API key",
      }),
    );

    let caught: unknown;
    try {
      for await (const _ of port.streamText({
        taskType: "t",
        prompt: "x",
        maxOutputTokens: 10,
      })) {
        void _;
      }
    } catch (err) {
      caught = err;
    }
    // alpha.18: 401 maps to AuthenticationError (not the generic
    // ProviderUnavailableError) so consumers can distinguish credential
    // problems from transient provider failures.
    expect(caught).toBeInstanceOf(AuthenticationError);
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1); // no retry
  });

  it("streamStructured: progressively-yielded JSON object reaches final parsed shape", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // Send the full JSON in chunks so parser sees progressively completer object
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatStream([
        '{"greeting"',
        ': "hi"',
        ', "count"',
        ": 5}",
      ]),
    );

    const partials: Array<Partial<{ greeting: string; count: number }>> = [];
    for await (const partial of port.streamStructured({
      taskType: "t",
      prompt: "x",
      schema: z.object({ greeting: z.string(), count: z.number() }),
    })) {
      partials.push(partial);
    }
    expect(partials.length).toBeGreaterThan(0);
    const final = partials[partials.length - 1];
    expect(final?.greeting).toBe("hi");
    expect(final?.count).toBe(5);
  });
});
