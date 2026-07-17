/**
 * Phase 8 — failure-mode recovery tests.
 *
 * Many failure-mode rows from TEST-PLAN.md Phase 8 are already covered by
 * Phase 1.5 quirks files (capability rejections, transient 401, error
 * wrapping, tool execution failures, missing pricing, malformed JSON).
 * This file pins the RECOVERY assertions that Phase 8 specifically calls out:
 *
 *   - After a ProviderUnavailableError, the next call can succeed
 *     (state isn't poisoned)
 *   - After a ValidationError, a call with a different schema can succeed
 *   - After capability fallback, subsequent calls don't re-discover the
 *     learned constraint (Phase 1.5 Group B assertion in recovery framing)
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
import { ServiceUnavailableError } from "@llm-ports/core";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("Phase 8: failure-mode recovery", () => {
  it("ServiceUnavailableError on call 1 does not poison state — call 2 succeeds", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // alpha.18: 503 maps to ServiceUnavailableError (the typed base for
    // transient provider failures); ProviderUnavailableError is now
    // reserved for the unknown-status fallback.
    mockChatCompletionsCreate.mockRejectedValueOnce(
      buildOpenAIError({ status: 503, message: "service unavailable" }),
    );
    await expect(
      port.generateText({ taskType: "t", messages: [{ role: "user" as const, content: "x" }], maxOutputTokens: 50 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    // Second call: success — adapter context is reusable
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "recovered", promptTokens: 5, completionTokens: 5 }),
    );
    const r = await port.generateText({ taskType: "t", messages: [{ role: "user" as const, content: "y" }], maxOutputTokens: 50 });
    expect(r.text).toBe("recovered");
  });

  it("ValidationError on schema A does not block subsequent calls with schema B", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      validationStrategy: { kind: "fail-fast" },
    });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // Schema A: model emits invalid output → ValidationError
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"intent": "BOGUS"}',
        promptTokens: 5,
        completionTokens: 5,
      }),
    );
    await expect(
      port.generateStructured({
        taskType: "t",
        messages: [{ role: "user" as const, content: "x" }],
        schema: z.object({ intent: z.enum(["a", "b"]) }),
      }),
    ).rejects.toMatchObject({ name: "ValidationError" });

    // Schema B: model emits valid output → success
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"value": 42}',
        promptTokens: 5,
        completionTokens: 5,
      }),
    );
    const r = await port.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "y" }],
      schema: z.object({ value: z.number() }),
    });
    expect(r.data.value).toBe(42);
  });

  it("after capability rejection learning, subsequent calls skip the fallback round-trip", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-5-nano", "live");

    // Round 1: trigger temperature rejection. Adapter retries, succeeds, learns.
    mockChatCompletionsCreate
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 400,
          code: "unsupported_value",
          param: "temperature",
          message: "no temp",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "r1", promptTokens: 5, completionTokens: 5 }),
      );
    await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      temperature: 0,
      maxOutputTokens: 50,
    });
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(2); // 1 rejected + 1 retry

    // Round 2: same setup, but the adapter should now skip the rejection.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "r2", promptTokens: 5, completionTokens: 5 }),
    );
    const r = await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "y" }],
      temperature: 0,
      maxOutputTokens: 50,
    });
    expect(r.text).toBe("r2");
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(3); // 2 + 1 (no second rejection)

    // The third (round-2-only) SDK call should NOT have temperature in its payload
    const round2Req = mockChatCompletionsCreate.mock.calls[2]?.[0] as {
      temperature?: number;
    };
    expect(round2Req.temperature).toBeUndefined();
  });

  it("missing pricing throws clear error at port creation, not on first call", () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    expect(() => adapter.createLLMPort("totally-unknown-model", "live")).toThrow(
      /No pricing entry for OpenAI model "totally-unknown-model"/,
    );
  });
});
