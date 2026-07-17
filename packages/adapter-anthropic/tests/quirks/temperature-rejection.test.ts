/**
 * Closes #12. Verifies adapter-anthropic detects Anthropic's "temperature is
 * deprecated for this model" 400, learns the constraint, retries without
 * temperature, and fires onRetry + the click-to-file URL warning.
 *
 * Strategy: mock the SDK, queue an error on first call and a success on
 * retry, inspect what the adapter sent and what onRetry observed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAnthropicResponse,
  mockCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { _resetWarnedState } from "@llm-ports/core";
import { createAnthropicAdapter } from "../../src/index.js";

/** Build the shape of error Anthropic returns when the SDK throws on 400 */
function temperatureRejectionError(): Error & {
  status: number;
  error: { type: string; message: string };
} {
  const err = new Error("400 ...") as Error & {
    status: number;
    error: { type: string; message: string };
  };
  err.status = 400;
  err.error = {
    type: "invalid_request_error",
    message: "`temperature` is deprecated for this model.",
  };
  return err;
}

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
  _resetWarnedState();
});

describe("#12 — adapter-anthropic strips temperature on models that reject it", () => {
  it("first call learns the constraint + retries without temperature + succeeds", async () => {
    const adapter = createAnthropicAdapter({
      apiKey: "test",
      pricingOverrides: {
        "claude-opus-5-imaginary": { inputPer1M: 1, outputPer1M: 4 },
      },
    });
    const port = adapter.createLLMPort("claude-opus-5-imaginary", "live");

    mockCreate.mockRejectedValueOnce(temperatureRejectionError());
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ["ok"],
        inputTokens: 10,
        outputTokens: 5,
        modelId: "claude-opus-5-imaginary",
      }),
    );

    const result = await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "hello" }],
      temperature: 0,
      maxOutputTokens: 50,
    });

    expect(result.text).toBe("ok");
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // First call: temperature included
    const firstCall = mockCreate.mock.calls[0]?.[0] as { temperature?: number };
    expect(firstCall.temperature).toBe(0);

    // Retry: temperature stripped
    const retryCall = mockCreate.mock.calls[1]?.[0] as { temperature?: number };
    expect(retryCall.temperature).toBeUndefined();
  });

  it("second call on the same model skips temperature up front (learned constraint persists)", async () => {
    const adapter = createAnthropicAdapter({
      apiKey: "test",
      pricingOverrides: {
        "claude-opus-5-imaginary": { inputPer1M: 1, outputPer1M: 4 },
      },
    });
    const port = adapter.createLLMPort("claude-opus-5-imaginary", "live");

    // First call: learn the constraint
    mockCreate.mockRejectedValueOnce(temperatureRejectionError());
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ["ok"],
        inputTokens: 10,
        outputTokens: 5,
      }),
    );
    await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "hello" }],
      temperature: 0,
      maxOutputTokens: 50,
    });

    // Second call: should NOT include temperature, no retry
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ["ok2"],
        inputTokens: 10,
        outputTokens: 5,
      }),
    );
    await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "hello again" }],
      temperature: 0,
      maxOutputTokens: 50,
    });

    expect(mockCreate).toHaveBeenCalledTimes(3); // 2 from first call + 1 from second
    const thirdCall = mockCreate.mock.calls[2]?.[0] as { temperature?: number };
    expect(thirdCall.temperature).toBeUndefined();
  });

  it("static catalog: claude-opus-4-5 skips discovery round-trip on first call", async () => {
    const adapter = createAnthropicAdapter({
      apiKey: "test",
      pricingOverrides: {
        "claude-opus-4-5-20251001": { inputPer1M: 1, outputPer1M: 4 },
      },
    });
    const port = adapter.createLLMPort("claude-opus-4-5-20251001", "live");

    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ["ok"],
        inputTokens: 10,
        outputTokens: 5,
      }),
    );

    await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "hello" }],
      temperature: 0,
      maxOutputTokens: 50,
    });

    // Only one call (no retry), and temperature is already stripped
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const firstCall = mockCreate.mock.calls[0]?.[0] as { temperature?: number };
    expect(firstCall.temperature).toBeUndefined();
  });

  it("static catalog: claude-sonnet-4-5 also skips discovery", async () => {
    const adapter = createAnthropicAdapter({
      apiKey: "test",
      pricingOverrides: {
        "claude-sonnet-4-5": { inputPer1M: 1, outputPer1M: 4 },
      },
    });
    const port = adapter.createLLMPort("claude-sonnet-4-5", "live");

    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ["ok"],
        inputTokens: 10,
        outputTokens: 5,
      }),
    );

    await port.generateText({ taskType: "t", messages: [{ role: "user" as const, content: "hi" }], temperature: 0, maxOutputTokens: 10 });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0]?.[0] as { temperature?: number };
    expect(call.temperature).toBeUndefined();
  });

  it("non-temperature 400 errors propagate without retry", async () => {
    const adapter = createAnthropicAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("claude-haiku-4-5", "live");

    const otherErr = new Error("400 max_tokens too low") as Error & {
      status: number;
      error: { type: string; message: string };
    };
    otherErr.status = 400;
    otherErr.error = { type: "invalid_request_error", message: "max_tokens must be at least 1" };

    mockCreate.mockRejectedValueOnce(otherErr);

    await expect(
      port.generateText({
        taskType: "t",
        messages: [{ role: "user" as const, content: "hi" }],
        temperature: 0,
        maxOutputTokens: 50,
      }),
    ).rejects.toThrow(/max_tokens/);

    // Should NOT have retried
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("fires onRetry hook with reason=capability-fallback and capability=temperatureLocked", async () => {
    const events: Array<{ reason: string; capability?: string; modelId: string }> = [];
    const adapter = createAnthropicAdapter({
      apiKey: "test",
      pricingOverrides: {
        "claude-opus-5-imaginary": { inputPer1M: 1, outputPer1M: 4 },
      },
      onRetry: (e) => {
        events.push({ reason: e.reason, capability: e.capability, modelId: e.modelId });
      },
    });
    const port = adapter.createLLMPort("claude-opus-5-imaginary", "live");

    mockCreate.mockRejectedValueOnce(temperatureRejectionError());
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({ textBlocks: ["ok"], inputTokens: 10, outputTokens: 5 }),
    );

    await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "hi" }],
      temperature: 0,
      maxOutputTokens: 50,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("capability-fallback");
    expect(events[0]?.capability).toBe("temperatureLocked");
    expect(events[0]?.modelId).toBe("claude-opus-5-imaginary");
  });

  it("fires console.warn with click-to-file URL on first learning, only once per model+capability", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = createAnthropicAdapter({
      apiKey: "test",
      pricingOverrides: {
        "claude-opus-5-imaginary": { inputPer1M: 1, outputPer1M: 4 },
      },
    });
    const port = adapter.createLLMPort("claude-opus-5-imaginary", "live");

    mockCreate.mockRejectedValueOnce(temperatureRejectionError());
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({ textBlocks: ["ok"], inputTokens: 10, outputTokens: 5 }),
    );

    await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "hi" }],
      temperature: 0,
      maxOutputTokens: 50,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMessage = warnSpy.mock.calls[0]?.[0];
    expect(warnMessage).toContain("@llm-ports/adapter-anthropic");
    expect(warnMessage).toContain("claude-opus-5-imaginary");
    expect(warnMessage).toContain("temperatureLocked");
    expect(warnMessage).toContain("https://github.com/baabakk/llm-ports/issues/new");

    warnSpy.mockRestore();
  });

  it("user-supplied capabilities (via pricingOverrides) skip discovery entirely", async () => {
    const adapter = createAnthropicAdapter({
      apiKey: "test",
      pricingOverrides: {
        "claude-future-imaginary": {
          inputPer1M: 1,
          outputPer1M: 4,
          capabilities: { temperatureLocked: true },
        },
      },
    });
    const port = adapter.createLLMPort("claude-future-imaginary", "live");

    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ["ok"],
        inputTokens: 10,
        outputTokens: 5,
      }),
    );

    await port.generateText({
      taskType: "t",
      messages: [{ role: "user" as const, content: "hi" }],
      temperature: 0,
      maxOutputTokens: 50,
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0]?.[0] as { temperature?: number };
    expect(call.temperature).toBeUndefined();
  });
});
