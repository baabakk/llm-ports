/**
 * Group C — transient-401 retry boundary cases.
 *
 * OpenAI sk-proj-* keys briefly return 401 "Incorrect API key" under
 * burst protection even when the key is valid. The adapter retries 401
 * ONLY if a prior request on the same client succeeded — that's the
 * signal we use to distinguish transient burst protection from a real
 * auth failure. These tests pin the boundary cases.
 *
 * Backoff timing in tests: the production retry uses 500ms × 3^attempt
 * exponential backoff. To keep tests fast we use vitest fake timers and
 * advance them manually.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildOpenAIChatResponse,
  buildOpenAIError,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { createOpenAIAdapter, type OpenAIAdapterOptions } from "../../src/index.js";
import { ProviderUnavailableError } from "@llm-ports/core";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

// Tests don't want to wait the production 500ms/1500ms backoff. Inject a
// no-wait backoff function so retries fire immediately.
const NO_BACKOFF: Pick<OpenAIAdapterOptions, "transientAuthBackoffMs"> = {
  transientAuthBackoffMs: () => 0,
};

const burstError = () =>
  buildOpenAIError({
    status: 401,
    code: "invalid_api_key",
    message:
      "Incorrect API key provided: sk-proj-************wrwA. You can find your API key at ...",
  });

describe("Group C: transient-401 retry boundaries", () => {
  it("401 BEFORE any success → propagates immediately, no retry", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test", transientAuthRetries: 5, ...NO_BACKOFF });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockRejectedValueOnce(burstError());

    await expect(
      port.generateText({ taskType: "t", prompt: "x", maxOutputTokens: 10 }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    // Exactly one SDK call — no retry, because hasSucceeded was never true
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
  });

  it("401 AFTER first success → retries with backoff, second attempt succeeds", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test", ...NO_BACKOFF });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // First successful call — sets hasSucceeded
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "hello", promptTokens: 5, completionTokens: 5 }),
    );
    await port.generateText({ taskType: "t", prompt: "1", maxOutputTokens: 10 });

    // Second call: 401 on first SDK attempt, success on retry
    mockChatCompletionsCreate
      .mockRejectedValueOnce(burstError())
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "world", promptTokens: 5, completionTokens: 5 }),
      );

    const result = await port.generateText({
      taskType: "t",
      prompt: "2",
      maxOutputTokens: 10,
    });

    expect(result.text).toBe("world");
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(3); // 1 + 2
  });

  it("401 AFTER first success → retries exhausted → propagates as ProviderUnavailableError", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test", transientAuthRetries: 2, ...NO_BACKOFF });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "first", promptTokens: 5, completionTokens: 5 }),
    );
    await port.generateText({ taskType: "t", prompt: "x", maxOutputTokens: 10 });

    // Now: keep returning 401 for the next 3 attempts (initial + 2 retries)
    mockChatCompletionsCreate
      .mockRejectedValueOnce(burstError())
      .mockRejectedValueOnce(burstError())
      .mockRejectedValueOnce(burstError());

    await expect(
      port.generateText({ taskType: "t", prompt: "y", maxOutputTokens: 10 }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    // 1 first success + 3 attempts (initial + 2 retries) = 4 SDK calls
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(4);
  });

  it("transientAuthRetries: 0 disables retry — single 401 propagates", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test", transientAuthRetries: 0, ...NO_BACKOFF });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "ok", promptTokens: 5, completionTokens: 5 }),
    );
    await port.generateText({ taskType: "t", prompt: "x", maxOutputTokens: 10 });

    mockChatCompletionsCreate.mockRejectedValueOnce(burstError());

    await expect(
      port.generateText({ taskType: "t", prompt: "y", maxOutputTokens: 10 }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(2); // 1 success + 1 fail (no retry)
  });

  it("capability rejection AND transient 401 in same logical operation both fire", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test", ...NO_BACKOFF });
    const port = adapter.createLLMPort("gpt-5-nano", "live");

    // Establish hasSucceeded
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "init", promptTokens: 5, completionTokens: 5 }),
    );
    await port.generateText({ taskType: "t", prompt: "init", maxOutputTokens: 10 });

    // Now a logical call that:
    //   1st SDK attempt: temperature rejection (capability)
    //   2nd SDK attempt: transient 401 (after capability fallback)
    //   3rd SDK attempt: success
    mockChatCompletionsCreate
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 400,
          code: "unsupported_value",
          param: "temperature",
          message: "no temp",
        }),
      )
      .mockRejectedValueOnce(burstError())
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "ok", promptTokens: 5, completionTokens: 5 }),
      );

    const result = await port.generateText({
      taskType: "t",
      prompt: "x",
      temperature: 0,
      maxOutputTokens: 10,
    });
    expect(result.text).toBe("ok");
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(4); // 1 init + 3 (cap + 401 + success)
  });

  it("real revoked key mid-process: spends retry budget then gives up", async () => {
    // Indistinguishable at runtime from burst protection. Adapter spends the
    // full retry budget then propagates. Document the cost.
    const adapter = createOpenAIAdapter({ apiKey: "test", transientAuthRetries: 2, ...NO_BACKOFF });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "before", promptTokens: 5, completionTokens: 5 }),
    );
    await port.generateText({ taskType: "t", prompt: "before", maxOutputTokens: 10 });

    // After this: key is revoked. Same shape as burst protection. Adapter
    // can't tell the difference. Tries 3 times, fails 3 times, gives up.
    for (let i = 0; i < 3; i++) {
      mockChatCompletionsCreate.mockRejectedValueOnce(burstError());
    }

    await expect(
      port.generateText({ taskType: "t", prompt: "after", maxOutputTokens: 10 }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(4);
  });
});
