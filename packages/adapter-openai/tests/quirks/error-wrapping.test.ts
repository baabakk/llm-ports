/**
 * Group D — error-wrapping idempotence.
 *
 * `wrapError` is called from multiple layers (executeChatRequest, runAgent's
 * outer catch, embeddings ports). The pattern must be: framework errors that
 * are already typed (`ProviderUnavailableError`, `ValidationError`) pass
 * through unchanged. Generic Errors get wrapped exactly once.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildOpenAIChatResponse,
  buildOpenAIError,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { createOpenAIAdapter } from "../../src/index.js";
import { ProviderUnavailableError, ServiceUnavailableError } from "@llm-ports/core";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("Group D: error-wrapping idempotence", () => {
  it("ServiceUnavailableError thrown from executeChatRequest is NOT double-wrapped by runAgent's outer catch", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // First call inside runAgent throws a generic 500 error.
    // executeChatRequest wraps it as ServiceUnavailableError (alpha.18:
    // 5xx maps to ServiceUnavailableError; ProviderUnavailableError is
    // reserved as the unknown-status fallback).
    // runAgent's outer try/catch sees the typed error and must NOT wrap
    // it again.
    mockChatCompletionsCreate.mockRejectedValueOnce(
      buildOpenAIError({ status: 500, message: "internal server error" }),
    );

    let caught: unknown;
    try {
      await port.runAgent({
        taskType: "t",
        instructions: "x",
        messages: [{ role: "user", content: "test" }],
        tools: {},
        maxSteps: 2,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableError);
    // The cause is the original SDK error, not a nested typed error
    const cause = (caught as ServiceUnavailableError).cause;
    expect(cause).not.toBeInstanceOf(ServiceUnavailableError);
  });

  it("non-Error thrown values (string, plain object, null, undefined, BigInt) wrap cleanly", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    const cases: unknown[] = [
      "plain string",
      { code: "WEIRD", detail: "object thrown" },
      null,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-loss-of-precision
      BigInt(42),
    ];

    for (const thrown of cases) {
      mockChatCompletionsCreate.mockRejectedValueOnce(thrown);
      let caught: unknown;
      try {
        await port.generateText({ taskType: "t", prompt: "x", maxOutputTokens: 10 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderUnavailableError);
      // Cause is always an Error object, never the raw thrown value
      const cause = (caught as ProviderUnavailableError).cause;
      expect(cause).toBeInstanceOf(Error);
    }
  });

  it("ValidationError from generateStructured is NOT wrapped as ProviderUnavailableError", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      validationStrategy: { kind: "fail-fast" },
    });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // Model returns invalid JSON; with fail-fast strategy, a ValidationError fires.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"intent": "BOGUS_VALUE"}',
        promptTokens: 5,
        completionTokens: 5,
      }),
    );

    let caught: unknown;
    try {
      await port.generateStructured({
        taskType: "t",
        prompt: "x",
        schema: z.object({ intent: z.enum(["a", "b"]) }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(ProviderUnavailableError);
    expect((caught as Error).name).toBe("ValidationError");
  });

  it("repeated wrapping yields the same final shape (idempotent under composition)", async () => {
    // Two-layer test: induce an error inside generateText, which goes through
    // wrapError once. Then call again in a path that re-catches and would wrap
    // a second time. Verify the final caught error has exactly one layer of
    // typed error, not nested.
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockRejectedValueOnce(
      buildOpenAIError({ status: 503, message: "service unavailable" }),
    );

    let caught: unknown;
    try {
      await port.generateText({ taskType: "t", prompt: "x", maxOutputTokens: 10 });
    } catch (err) {
      caught = err;
    }
    // alpha.18: 503 maps to ServiceUnavailableError (the base), not
    // ProviderUnavailableError (which is now reserved for the
    // unknown-status fallback).
    expect(caught).toBeInstanceOf(ServiceUnavailableError);

    // If we re-throw and re-catch in a hypothetical outer layer that ALSO
    // calls wrapError, the result must be the same instance — that's the
    // contract that prevents nested wrapping anywhere in the call chain.
    // We can't easily import wrapError (it's not exported), but we can simulate
    // by re-throwing inside another generateText call's mock and confirming
    // the cause chain stays one deep.
    mockChatCompletionsCreate.mockRejectedValueOnce(caught);
    let caught2: unknown;
    try {
      await port.generateText({ taskType: "t", prompt: "y", maxOutputTokens: 10 });
    } catch (err) {
      caught2 = err;
    }
    // alpha.18: idempotence test — the 503 produced a ServiceUnavailableError
    // on the first round; wrapping it again yields the same instance because
    // wrapProviderError passes LLMPortError subclasses through unchanged.
    expect(caught2).toBeInstanceOf(ServiceUnavailableError);
    expect(caught2).toBe(caught);
  });
});
