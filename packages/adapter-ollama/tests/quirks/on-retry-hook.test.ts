/**
 * onRetry observability hook (alpha.17 parity; TD-LLMPORTS-ALPHA17-CLOSEOUT).
 *
 * Verifies the hook fires exactly once per validation-feedback retry with
 * the right shape (reason, attempt index, model, provider). Ollama only
 * has the validation-feedback retry path (no transient-auth or
 * reasoning-starvation paths — local daemons don't 401 or have hidden
 * reasoning budgets), so this is the sole retry trigger to test.
 *
 * Also asserts hook errors don't cancel the retry — observability only.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { RetryEvent } from "@llm-ports/core";
import {
  buildOllamaChatResponse,
  mockChat,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { createOllamaAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
});

describe("onRetry observability hook (validation-feedback)", () => {
  it("fires for validation-feedback retry with the right shape", async () => {
    const events: RetryEvent[] = [];
    const adapter = createOllamaAdapter({
      autoPull: false,
      onRetry: (e) => {
        events.push(e);
      },
    });
    const port = adapter.createLLMPort("llama3.2", "local");

    const Schema = z.object({
      intent: z.enum(["question", "request"]),
    });

    // First attempt: returns invalid enum value, triggering retry-with-feedback.
    mockChat
      .mockResolvedValueOnce(
        buildOllamaChatResponse({
          text: '{"intent":"WRONG_VALUE"}',
          modelId: "llama3.2",
          promptEvalCount: 10,
          evalCount: 5,
        }),
      )
      .mockResolvedValueOnce(
        buildOllamaChatResponse({
          text: '{"intent":"request"}',
          modelId: "llama3.2",
          promptEvalCount: 10,
          evalCount: 5,
        }),
      );

    const result = await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "classify this" }],
      schema: Schema,
      schemaName: "Test",
    });

    expect(result.data).toEqual({ intent: "request" });
    expect(result.validationAttempts).toBe(2);

    // Exactly one retry event fired.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "validation-feedback",
      attempt: 0,
      modelId: "llama3.2",
      providerAlias: "local",
      delayMs: 0,
    });
    // The Zod error is attached as cause for adapter-side debugging.
    expect(events[0]?.cause).toBeDefined();
  });

  it("does not fire when first attempt succeeds (no retry needed)", async () => {
    const events: RetryEvent[] = [];
    const adapter = createOllamaAdapter({
      autoPull: false,
      onRetry: (e) => events.push(e),
    });
    const port = adapter.createLLMPort("llama3.2", "local");

    const Schema = z.object({ intent: z.enum(["question", "request"]) });

    mockChat.mockResolvedValueOnce(
      buildOllamaChatResponse({
        text: '{"intent":"request"}',
        modelId: "llama3.2",
        promptEvalCount: 10,
        evalCount: 5,
      }),
    );

    await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      schema: Schema,
      schemaName: "Test",
    });

    expect(events).toHaveLength(0);
  });

  it("hook errors do NOT cancel the retry (observability only)", async () => {
    const adapter = createOllamaAdapter({
      autoPull: false,
      onRetry: () => {
        throw new Error("hook should not break the call");
      },
    });
    const port = adapter.createLLMPort("llama3.2", "local");

    const Schema = z.object({ intent: z.enum(["question", "request"]) });

    mockChat
      .mockResolvedValueOnce(
        buildOllamaChatResponse({
          text: '{"intent":"WRONG"}',
          modelId: "llama3.2",
          promptEvalCount: 10,
          evalCount: 5,
        }),
      )
      .mockResolvedValueOnce(
        buildOllamaChatResponse({
          text: '{"intent":"request"}',
          modelId: "llama3.2",
          promptEvalCount: 10,
          evalCount: 5,
        }),
      );

    // The retry SHOULD succeed even though the hook throws.
    const result = await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      schema: Schema,
      schemaName: "Test",
    });

    expect(result.data).toEqual({ intent: "request" });
    expect(result.validationAttempts).toBe(2);
  });

  it("supports async onRetry handlers (fire-and-forget)", async () => {
    const events: RetryEvent[] = [];
    const adapter = createOllamaAdapter({
      autoPull: false,
      onRetry: async (e) => {
        await Promise.resolve();
        events.push(e);
      },
    });
    const port = adapter.createLLMPort("llama3.2", "local");

    const Schema = z.object({ intent: z.enum(["question", "request"]) });

    mockChat
      .mockResolvedValueOnce(
        buildOllamaChatResponse({
          text: '{"intent":"WRONG"}',
          modelId: "llama3.2",
          promptEvalCount: 10,
          evalCount: 5,
        }),
      )
      .mockResolvedValueOnce(
        buildOllamaChatResponse({
          text: '{"intent":"request"}',
          modelId: "llama3.2",
          promptEvalCount: 10,
          evalCount: 5,
        }),
      );

    const result = await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      schema: Schema,
      schemaName: "Test",
    });

    expect(result.data).toEqual({ intent: "request" });
    // Async hook fires fire-and-forget; need a microtask flush.
    await Promise.resolve();
    expect(events).toHaveLength(1);
  });

  it("is silent (no errors) when onRetry is not configured", async () => {
    const adapter = createOllamaAdapter({ autoPull: false });
    const port = adapter.createLLMPort("llama3.2", "local");

    const Schema = z.object({ intent: z.enum(["question", "request"]) });

    mockChat
      .mockResolvedValueOnce(
        buildOllamaChatResponse({
          text: '{"intent":"WRONG"}',
          modelId: "llama3.2",
          promptEvalCount: 10,
          evalCount: 5,
        }),
      )
      .mockResolvedValueOnce(
        buildOllamaChatResponse({
          text: '{"intent":"request"}',
          modelId: "llama3.2",
          promptEvalCount: 10,
          evalCount: 5,
        }),
      );

    const result = await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      schema: Schema,
      schemaName: "Test",
    });

    expect(result.validationAttempts).toBe(2);
  });
});
