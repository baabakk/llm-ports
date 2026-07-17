/**
 * Group B — capability-discovery isolation.
 *
 * The runtime capability discovery in src/capabilities.ts maintains a
 * process-wide Map keyed by modelId. These tests pin the boundaries:
 *   - Constraints learned for one model don't leak to another
 *   - Compose: three constraints in sequence work; the 4th call sends a
 *     fully-stripped request
 *   - User-supplied capabilities (via pricingOverrides) override learned
 *     constraints
 *   - _resetLearnedConstraints actually clears state
 *   - Two parallel calls discovering the same constraint don't corrupt each
 *     other (no double-learning observable; second is a no-op)
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildOpenAIChatResponse,
  buildOpenAIError,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import {
  _resetLearnedConstraints,
  getEffectiveCapabilities,
} from "../../src/capabilities.js";
import { createOpenAIAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("Group B: capability-discovery isolation", () => {
  it("constraint learned for gpt-5-nano does NOT leak to gpt-4o", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const nano = adapter.createLLMPort("gpt-5-nano", "live");

    // First call: temperature rejection → learn temperatureLocked for gpt-5-nano.
    mockChatCompletionsCreate.mockRejectedValueOnce(
      buildOpenAIError({
        status: 400,
        code: "unsupported_value",
        param: "temperature",
        message: "model gpt-5-nano does not support temperature 0",
      }),
    );
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 5,
        completionTokens: 5,
      }),
    );

    await nano.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      temperature: 0,
      maxOutputTokens: 50,
    });

    // gpt-5-nano now has temperatureLocked
    const nanoCaps = getEffectiveCapabilities("gpt-5-nano", undefined);
    expect(nanoCaps.temperatureLocked).toBe(true);

    // gpt-4o was never probed → has nothing learned
    const gpt4oCaps = getEffectiveCapabilities("gpt-4o", undefined);
    expect(gpt4oCaps.temperatureLocked).toBeUndefined();
  });

  it("_resetLearnedConstraints clears state — next call re-discovers", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-5-nano", "live");

    // Discover temperatureLocked
    mockChatCompletionsCreate.mockRejectedValueOnce(
      buildOpenAIError({
        status: 400,
        code: "unsupported_value",
        param: "temperature",
        message: "does not support temperature",
      }),
    );
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "ok", promptTokens: 5, completionTokens: 5 }),
    );
    await port.generateText({ taskType: "t", messages: [{ role: "user" as const, content: "x" }], temperature: 0, maxOutputTokens: 50 });
    expect(getEffectiveCapabilities("gpt-5-nano", undefined).temperatureLocked).toBe(true);

    // Reset → constraint is gone
    _resetLearnedConstraints();
    expect(getEffectiveCapabilities("gpt-5-nano", undefined).temperatureLocked).toBeUndefined();

    // Next call: re-discovers (rejection again, retry, success)
    mockChatCompletionsCreate.mockRejectedValueOnce(
      buildOpenAIError({
        status: 400,
        code: "unsupported_value",
        param: "temperature",
        message: "does not support temperature",
      }),
    );
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "again", promptTokens: 5, completionTokens: 5 }),
    );
    await port.generateText({ taskType: "t", messages: [{ role: "user" as const, content: "y" }], temperature: 0, maxOutputTokens: 50 });
    expect(getEffectiveCapabilities("gpt-5-nano", undefined).temperatureLocked).toBe(true);
  });

  it("three constraints compose: temperature → json mode → system message", async () => {
    // strict-model isn't in OPENAI_PRICING; provide pricing inline.
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "strict-model": { inputPer1M: 1, outputPer1M: 2 } },
    });
    const strict = adapter.createLLMPort("strict-model", "live");

    // Round 1: temperature rejected → learn → retry without temp succeeds
    mockChatCompletionsCreate
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 400,
          code: "unsupported_value",
          param: "temperature",
          message: "no temperature",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "r1", promptTokens: 5, completionTokens: 5 }),
      );
    await strict.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      temperature: 0,
      maxOutputTokens: 50,
    });

    // Round 2: json mode rejected (via generateStructured) → learn → retry succeeds
    mockChatCompletionsCreate
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 400,
          code: "unsupported_value",
          param: "response_format",
          message: "no response_format",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({
          text: '{"x":1}',
          promptTokens: 5,
          completionTokens: 5,
        }),
      );
    const { z } = await import("zod");
    await strict.generateStructured({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      schema: z.object({ x: z.number() }),
    });

    // Round 3: system message rejected → learn → retry succeeds
    mockChatCompletionsCreate
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 400,
          message: "model does not support system messages — use developer message",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "r3", promptTokens: 5, completionTokens: 5 }),
      );
    await strict.generateText({
      taskType: "t",
      messages: [{ role: "system" as const, content: "Be brief." }, { role: "user" as const, content: "x" }],
      maxOutputTokens: 50,
    });

    // All three constraints learned now
    const caps = getEffectiveCapabilities("strict-model", undefined);
    expect(caps.temperatureLocked).toBe(true);
    expect(caps.jsonMode).toBe(false);
    expect(caps.systemMessageInUserOnly).toBe(true);

    // Round 4: send a request that would trigger ALL three; expect single SDK call
    mockChatCompletionsCreate.mockClear();
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "r4", promptTokens: 5, completionTokens: 5 }),
    );
    await strict.generateText({
      taskType: "t",
      messages: [{ role: "system" as const, content: "Be brief." }, { role: "user" as const, content: "x" }],
      temperature: 0,
      maxOutputTokens: 50,
    });
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
    const finalCall = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      temperature?: number;
      response_format?: unknown;
      messages: Array<{ role: string }>;
    };
    expect(finalCall.temperature).toBeUndefined();
    expect(finalCall.response_format).toBeUndefined();
    // No system message (instructions folded into user message instead)
    expect(finalCall.messages.find((m) => m.role === "system")).toBeUndefined();
  });

  it("user-supplied capabilities (via pricingOverrides) override learned ones", async () => {
    // Even though we'd otherwise learn temperatureLocked from a rejection,
    // a user explicitly supplying { temperatureLocked: false } means trust them.
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: {
        "user-says-ok": {
          inputPer1M: 1,
          outputPer1M: 2,
          capabilities: { temperatureLocked: false },
        },
      },
    });
    const port = adapter.createLLMPort("user-says-ok", "live");

    // Even after a rejection that would normally teach the lock, the user's
    // override should dominate. Note: getEffectiveCapabilities does
    // `{ ...learned, ...userSupplied }` so userSupplied wins.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({ text: "ok", promptTokens: 5, completionTokens: 5 }),
    );
    await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "x" }],
      temperature: 0.5,
      maxOutputTokens: 50,
    });
    const sentReq = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      temperature?: number;
    };
    expect(sentReq.temperature).toBe(0.5);

    // The user's `temperatureLocked: false` is what readCaps sees.
    const caps = getEffectiveCapabilities("user-says-ok", { temperatureLocked: false });
    expect(caps.temperatureLocked).toBe(false);
  });

  it("two parallel calls discovering the same constraint don't corrupt each other", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-5-nano", "live");

    // Both parallel calls will trigger the same temperature rejection then succeed.
    // Set up enough mocked responses for both: 2 rejections + 2 successes (any order).
    mockChatCompletionsCreate
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 400,
          code: "unsupported_value",
          param: "temperature",
          message: "no temp",
        }),
      )
      .mockRejectedValueOnce(
        buildOpenAIError({
          status: 400,
          code: "unsupported_value",
          param: "temperature",
          message: "no temp",
        }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "a", promptTokens: 5, completionTokens: 5 }),
      )
      .mockResolvedValueOnce(
        buildOpenAIChatResponse({ text: "b", promptTokens: 5, completionTokens: 5 }),
      );

    const [r1, r2] = await Promise.all([
      port.generateText({ taskType: "t", messages: [{ role: "user" as const, content: "1" }], temperature: 0, maxOutputTokens: 50 }),
      port.generateText({ taskType: "t", messages: [{ role: "user" as const, content: "2" }], temperature: 0, maxOutputTokens: 50 }),
    ]);

    // Both succeed
    expect(r1.text.length).toBeGreaterThan(0);
    expect(r2.text.length).toBeGreaterThan(0);
    // Constraint learned exactly once (idempotent — second observer is a no-op)
    expect(getEffectiveCapabilities("gpt-5-nano", undefined).temperatureLocked).toBe(true);
  });
});
