/**
 * Closes #3. Verifies the onRetry observability hook fires exactly once
 * per retry, with the right reason, attempt index, and provider/model info.
 *
 * Covers all four reasons the adapter retries for:
 *   - transient-auth          (project-key burst-protection 401)
 *   - capability-fallback     (model rejected temperature/json_object/system)
 *   - reasoning-starvation    (model used full budget on hidden reasoning)
 *   - validation-feedback     (generateStructured: response failed schema)
 *
 * Also asserts that hook errors don't cancel the retry — observability only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RetryEvent } from "@llm-ports/core";
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

describe("#3 — onRetry observability hook", () => {
  it("fires for transient-auth retry with the right shape", async () => {
    const events: RetryEvent[] = [];
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      onRetry: (e) => {
        events.push(e);
      },
      ...NO_BACKOFF,
    });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // First, a successful call so the client is marked hasSucceeded
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "hi", promptTokens: 5, completionTokens: 5 }),
    );
    await port.generateText({ taskType: "t", messages: [{ role: "user" as const, content: "1" }], maxOutputTokens: 10 });

    // Now 401 burst-protection + success on retry
    mockChatCompletionsCreate
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 401,
          code: "invalid_api_key",
          message: "Incorrect API key provided: sk-proj-***wrwA",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "ok", promptTokens: 5, completionTokens: 5 }),
      );

    await port.generateText({ taskType: "t", messages: [{ role: "user" as const, content: "2" }], maxOutputTokens: 10 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "transient-auth",
      attempt: 0,
      providerAlias: "live",
      modelId: "gpt-4o",
      delayMs: 0,
    });
    expect(events[0]?.cause).toBeDefined();
  });

  it("fires for capability-fallback retry", async () => {
    const events: RetryEvent[] = [];
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      onRetry: (e) => {
        events.push(e);
      },
      ...NO_BACKOFF,
    });
    const port = adapter.createLLMPort("gpt-5-nano", "live");

    // First attempt: temperature rejection → adapter learns + retries without temperature
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
      messages: [{ role: "user" as const, content: "x" }],
      temperature: 0,
      maxOutputTokens: 10,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "capability-fallback",
      providerAlias: "live",
      modelId: "gpt-5-nano",
      delayMs: 0,
    });
  });

  it("fires for reasoning-starvation retry", async () => {
    const events: RetryEvent[] = [];
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      onRetry: (e) => {
        events.push(e);
      },
      ...NO_BACKOFF,
    });
    const port = adapter.createLLMPort("gpt-5-nano", "live");

    // First response: starved (empty content, finish=length, reasoning_tokens>0).
    // Second response: same call retried with expanded budget — succeeds.
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
      messages: [{ role: "user" as const, content: "x" }],
      maxOutputTokens: 50,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "reasoning-starvation",
      attempt: 0,
      providerAlias: "live",
      modelId: "gpt-5-nano",
      delayMs: 0,
    });
    // reasoning-starvation isn't an error-triggered retry, so cause is undefined.
    expect(events[0]?.cause).toBeUndefined();
  });

  it("fires for validation-feedback retry in generateStructured", async () => {
    const events: RetryEvent[] = [];
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      onRetry: (e) => {
        events.push(e);
      },
      ...NO_BACKOFF,
    });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // First attempt: invalid JSON shape. Second: valid.
    mockChatCompletionsCreate
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({
          text: '{"wrongField": "nope"}',
          promptTokens: 10,
          completionTokens: 5,
          modelId: "gpt-4o",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({
          text: '{"label": "spam"}',
          promptTokens: 10,
          completionTokens: 5,
          modelId: "gpt-4o",
        }),
      );

    await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "classify this" }],
      schema: z.object({ label: z.string() }),
      schemaName: "classification",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "validation-feedback",
      attempt: 0,
      providerAlias: "live",
      modelId: "gpt-4o",
      delayMs: 0,
    });
    expect(events[0]?.cause).toBeDefined();
  });

  it("hook errors do NOT cancel the retry (observability only)", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      onRetry: () => {
        throw new Error("hook exploded");
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
          message: "does not support temperature",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "ok", promptTokens: 5, completionTokens: 5 }),
      );

    const result = await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      temperature: 0,
      maxOutputTokens: 10,
    });

    expect(result.text).toBe("ok");
  });

  it("hook is called fire-and-forget; async hooks don't block retries", async () => {
    const calls: string[] = [];
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      onRetry: async () => {
        // Resolve on next microtask but record we ran.
        await Promise.resolve();
        calls.push("hook");
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
          message: "does not support temperature",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "ok", promptTokens: 5, completionTokens: 5 }),
      );

    await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      temperature: 0,
      maxOutputTokens: 10,
    });

    // Wait one microtask cycle so the fire-and-forget async hook can resolve.
    await vi.waitFor(() => expect(calls).toEqual(["hook"]));
  });
});
