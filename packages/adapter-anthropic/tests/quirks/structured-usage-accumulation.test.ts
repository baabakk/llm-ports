/**
 * generateStructured: usage accumulation across retry-with-feedback rounds
 * (alpha.11).
 *
 * Bug observed in production: validationAttempts correctly reported 2 on a
 * retry-with-feedback path, but the result's `usage` field reported only
 * the FINAL SDK call's tokens — making it look like one call had happened
 * for cost-accounting purposes. The fix accumulates usage across all
 * attempts via `mergeTokenUsage`, matching what runAgent already does.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
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

describe("generateStructured usage accumulation (alpha.11)", () => {
  it("first-attempt success: validationAttempts=1, usage reflects 1 call", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ['{"x":1}'],
        inputTokens: 100,
        outputTokens: 20,
      }),
    );

    const adapter = createAnthropicAdapter({
      apiKey: "test",
      pricingOverrides: { "test-m": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("test-m", "test");

    const result = await port.generateStructured({
      taskType: "t",
      prompt: "p",
      schema: z.object({ x: z.number() }),
    });

    expect(result.validationAttempts).toBe(1);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(20);
    expect(result.usage.totalTokens).toBe(120);
  });

  it("retry-with-feedback success: validationAttempts=2, usage is SUM of both calls", async () => {
    // First call: model returns invalid JSON (wrong type for x).
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ['{"x":"not-a-number"}'],
        inputTokens: 100,
        outputTokens: 25,
      }),
    );
    // Second call (with correction prompt): model returns valid JSON.
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ['{"x":42}'],
        inputTokens: 150,        // longer prompt: original + correction feedback
        outputTokens: 15,
      }),
    );

    const adapter = createAnthropicAdapter({
      apiKey: "test",
      pricingOverrides: { "test-m": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("test-m", "test");

    const result = await port.generateStructured({
      taskType: "t",
      prompt: "p",
      schema: z.object({ x: z.number() }),
    });

    expect(result.data).toEqual({ x: 42 });
    expect(result.validationAttempts).toBe(2);
    // Usage is now accumulated: inputs and outputs from BOTH calls.
    // Pre-alpha.11 bug: this used to be 150/15/165 (only the 2nd call).
    expect(result.usage.inputTokens).toBe(100 + 150);
    expect(result.usage.outputTokens).toBe(25 + 15);
    expect(result.usage.totalTokens).toBe(125 + 165);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("cost computation reflects accumulated usage", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ['{"x":"bad"}'],
        inputTokens: 1000,
        outputTokens: 500,
      }),
    );
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ['{"x":1}'],
        inputTokens: 1500,
        outputTokens: 100,
      }),
    );

    const adapter = createAnthropicAdapter({
      apiKey: "test",
      // $1/1M input, $4/1M output -> easy round numbers
      pricingOverrides: { "test-m": { inputPer1M: 1, outputPer1M: 4 } },
    });
    const port = adapter.createLLMPort("test-m", "test");

    const result = await port.generateStructured({
      taskType: "t",
      prompt: "p",
      schema: z.object({ x: z.number() }),
    });

    // Pre-alpha.11: cost would reflect only call 2: 1500*1 + 100*4 = 1900 microcents
    // alpha.11: cost reflects both: (1000+1500)*1 + (500+100)*4 = 2500 + 2400 = 4900 microcents
    const expectedTotal = (1000 + 1500) / 1_000_000 + ((500 + 100) * 4) / 1_000_000;
    expect(result.cost.totalUSD).toBeCloseTo(expectedTotal, 10);
  });
});
