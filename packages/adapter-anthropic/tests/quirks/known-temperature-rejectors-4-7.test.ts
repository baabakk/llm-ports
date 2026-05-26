/**
 * Static-catalog coverage for the Claude 4.5+ family (alpha.10).
 *
 * `KNOWN_TEMPERATURE_REJECTORS` must seed `temperatureLocked: true` BEFORE
 * the first call to claude-opus-4-7 / claude-sonnet-4-6 / etc. so that:
 *
 *   1. Non-streaming methods skip the wasted "send temperature, get 400,
 *      retry" round-trip.
 *   2. Streaming methods (which can't mid-stream retry) don't hard-fail
 *      with a 400. The catalog is the ONLY mechanism that prevents
 *      streaming failures here.
 *
 * Filed after BEPA observed `temperature is deprecated for this model`
 * on a claude-opus-4-7 call where the static catalog only covered 4-5.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildAnthropicResponse,
  mockCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { _resetWarnedState } from "@llm-ports/core";
import { createAnthropicAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
  _resetWarnedState();
});

const TEMPERATURE_LOCKED_MODELS = [
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-7-20251220",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6-20250514",
];

const STILL_ACCEPTS_TEMPERATURE = [
  "claude-opus-4", // bare 4 predates the deprecation
  "claude-sonnet-4",
  "claude-haiku-4-5", // haiku family still accepts temperature
  "claude-haiku-4-5-20251001",
];

describe("KNOWN_TEMPERATURE_REJECTORS catalog (alpha.10)", () => {
  it.each(TEMPERATURE_LOCKED_MODELS)(
    "%s: first call omits temperature (seeded by static catalog, no wasted 400)",
    async (modelId) => {
      const adapter = createAnthropicAdapter({
        apiKey: "test",
        pricingOverrides: { [modelId]: { inputPer1M: 1, outputPer1M: 1 } },
      });
      const port = adapter.createLLMPort(modelId, "live");

      mockCreate.mockResolvedValueOnce(
        buildAnthropicResponse({
          textBlocks: ["ok"],
          inputTokens: 10,
          outputTokens: 5,
          modelId,
        }),
      );

      const result = await port.generateText({
        taskType: "t",
        prompt: "hi",
        temperature: 0.7,
        maxOutputTokens: 50,
      });

      expect(result.text).toBe("ok");
      // Exactly one SDK call (no retry round-trip needed).
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const firstCall = mockCreate.mock.calls[0]?.[0] as { temperature?: number };
      expect(firstCall.temperature).toBeUndefined();
    },
  );

  it.each(STILL_ACCEPTS_TEMPERATURE)(
    "%s: first call DOES forward temperature (catalog does NOT over-match)",
    async (modelId) => {
      const adapter = createAnthropicAdapter({
        apiKey: "test",
        pricingOverrides: { [modelId]: { inputPer1M: 1, outputPer1M: 1 } },
      });
      const port = adapter.createLLMPort(modelId, "live");

      mockCreate.mockResolvedValueOnce(
        buildAnthropicResponse({
          textBlocks: ["ok"],
          inputTokens: 10,
          outputTokens: 5,
          modelId,
        }),
      );

      await port.generateText({
        taskType: "t",
        prompt: "hi",
        temperature: 0.7,
        maxOutputTokens: 50,
      });

      const firstCall = mockCreate.mock.calls[0]?.[0] as { temperature?: number };
      expect(firstCall.temperature).toBe(0.7);
    },
  );

  it("streamText against claude-opus-4-7 also omits temperature on first call", async () => {
    // Streaming path: client.messages.stream returns an async iterable.
    // We don't need the iteration to succeed, just the request shape.
    const adapter = createAnthropicAdapter({
      apiKey: "test",
      pricingOverrides: { "claude-opus-4-7": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("claude-opus-4-7", "live");

    // Stream mocked to yield nothing — we only care about the request shape.
    const { mockStream } = await import("../helpers/mock-sdk.js");
    mockStream.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        // empty stream
      },
    } as unknown as ReturnType<typeof mockStream>);

    const iter = port.streamText({
      taskType: "t",
      prompt: "hi",
      temperature: 0.7,
    });
    for await (const _ of iter) {
      // drain
    }

    const firstCall = mockStream.mock.calls[0]?.[0] as { temperature?: number };
    expect(firstCall.temperature).toBeUndefined();
  });
});
