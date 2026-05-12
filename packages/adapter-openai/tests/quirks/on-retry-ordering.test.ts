/**
 * Pins onRetry hook timing. The contract is: emit the hook BEFORE the
 * retried network call goes out (so observability sees "we're about to
 * retry"), not after the retried call returns. This prevents future
 * regressions where someone moves the emit() to the wrong side of the
 * await and observability lags by one round-trip.
 *
 * Test strategy: when the hook fires, record `mockChatCompletionsCreate.mock.calls.length`.
 * If the hook fires BEFORE the retry SDK call, that count equals "calls made so far,
 * not yet including the retry". After the test, total calls equals "the count at hook
 * time + the retry". So `hook-time count == final count - 1` proves ordering.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildOpenAIChatResponse,
  buildOpenAIError,
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

const NO_BACKOFF = { transientAuthBackoffMs: () => 0 };

describe("onRetry timing — hook MUST fire BEFORE the retried sdk call", () => {
  it("transient-auth: hook fires before the retry sdk-call", async () => {
    let callsAtHookTime = -1;
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      onRetry: () => {
        callsAtHookTime = mockChatCompletionsCreate.mock.calls.length;
      },
      ...NO_BACKOFF,
    });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // Prime hasSucceeded with a successful first call.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "ok", promptTokens: 5, completionTokens: 5 }),
    );
    await port.generateText({ taskType: "t", prompt: "0", maxOutputTokens: 10 });
    const callsAfterPrime = mockChatCompletionsCreate.mock.calls.length;

    // Now: 401 then success on retry.
    mockChatCompletionsCreate
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 401,
          code: "invalid_api_key",
          message: "Incorrect API key provided: sk-proj-***",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "ok2", promptTokens: 5, completionTokens: 5 }),
      );

    await port.generateText({ taskType: "t", prompt: "1", maxOutputTokens: 10 });

    // For this call we made 2 sdk calls total (failed + retry).
    // Hook should have fired at +1 (after the failed call, before the retry).
    const callsTotal = mockChatCompletionsCreate.mock.calls.length;
    expect(callsTotal - callsAfterPrime).toBe(2);
    expect(callsAtHookTime - callsAfterPrime).toBe(1);
  });

  it("capability-fallback: hook fires before the retry sdk-call", async () => {
    let callsAtHookTime = -1;
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      onRetry: () => {
        callsAtHookTime = mockChatCompletionsCreate.mock.calls.length;
      },
      ...NO_BACKOFF,
    });
    const port = adapter.createLLMPort("gpt-5-nano", "live");

    mockChatCompletionsCreate
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 400,
          code: "unsupported_value",
          param: "temperature",
          message: "model gpt-5-nano does not support temperature 0",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "ok", promptTokens: 5, completionTokens: 5 }),
      );

    await port.generateText({
      taskType: "t",
      prompt: "x",
      temperature: 0,
      maxOutputTokens: 10,
    });

    expect(mockChatCompletionsCreate.mock.calls.length).toBe(2);
    // Hook must have fired BEFORE the retry, i.e. at calls=1.
    expect(callsAtHookTime).toBe(1);
  });

  it("reasoning-starvation: hook fires before the retry sdk-call", async () => {
    let callsAtHookTime = -1;
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      onRetry: () => {
        callsAtHookTime = mockChatCompletionsCreate.mock.calls.length;
      },
      ...NO_BACKOFF,
    });
    const port = adapter.createLLMPort("gpt-5-nano", "live");

    mockChatCompletionsCreate
      .mockResolvedValueOnce(
        buildOpenAIReasoningResponse({
          promptTokens: 10,
          completionTokens: 50,
          reasoningTokens: 50,
          finishReason: "length",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "ok", promptTokens: 10, completionTokens: 5 }),
      );

    await port.generateText({
      taskType: "t",
      prompt: "x",
      maxOutputTokens: 50,
    });

    expect(mockChatCompletionsCreate.mock.calls.length).toBe(2);
    expect(callsAtHookTime).toBe(1);
  });

  it("validation-feedback: hook fires before the retry sdk-call", async () => {
    let callsAtHookTime = -1;
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      onRetry: () => {
        callsAtHookTime = mockChatCompletionsCreate.mock.calls.length;
      },
      ...NO_BACKOFF,
    });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({
          text: '{"wrongField":"nope"}',
          promptTokens: 10,
          completionTokens: 5,
          modelId: "gpt-4o",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({
          text: '{"label":"spam"}',
          promptTokens: 10,
          completionTokens: 5,
          modelId: "gpt-4o",
        }),
      );

    await port.generateStructured({
      taskType: "t",
      prompt: "classify",
      schema: z.object({ label: z.string() }),
      schemaName: "c",
    });

    expect(mockChatCompletionsCreate.mock.calls.length).toBe(2);
    expect(callsAtHookTime).toBe(1);
  });
});
