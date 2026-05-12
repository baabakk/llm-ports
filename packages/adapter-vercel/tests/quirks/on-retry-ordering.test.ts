/**
 * Vercel-side hook-ordering pin. Mirrors the adapter-openai test.
 *
 * Contract: onRetry fires BEFORE the retried generateText/SDK call,
 * not after. We assert by recording `mockGenerateText.mock.calls.length`
 * at hook-fire time and comparing to the final count.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildVercelGenerateTextResult,
  buildVercelReasoningStarvedResult,
  mockGenerateText,
  resetMocks,
} from "../helpers/fake-vercel-model.js";
import { createVercelAdapter } from "../../src/index.js";

const MODEL_ID = "fake-reasoning-model";
const ALIAS = "live";
const fakeLanguageModel = { specificationVersion: "v2" } as never;

beforeEach(() => {
  resetMocks();
});

describe("onRetry timing — hook MUST fire BEFORE the retried sdk call", () => {
  it("reasoning-starvation: hook fires before the retry sdk-call", async () => {
    let callsAtHookTime = -1;
    const adapter = createVercelAdapter({
      models: { [MODEL_ID]: fakeLanguageModel },
      pricing: { [MODEL_ID]: { inputPer1M: 1, outputPer1M: 4 } },
      onRetry: () => {
        callsAtHookTime = mockGenerateText.mock.calls.length;
      },
    });
    const port = adapter.createLLMPort(MODEL_ID, ALIAS);

    mockGenerateText
      .mockResolvedValueOnce(
        buildVercelReasoningStarvedResult({
          promptTokens: 10,
          completionTokens: 50,
          modelId: MODEL_ID,
        }),
      )
      .mockResolvedValueOnce(
        buildVercelGenerateTextResult({
          text: "the answer",
          promptTokens: 10,
          completionTokens: 5,
          modelId: MODEL_ID,
        }),
      );

    await port.generateText({
      taskType: "t",
      prompt: "x",
      maxOutputTokens: 50,
    });

    expect(mockGenerateText.mock.calls.length).toBe(2);
    // Hook should fire at calls=1 (after starved attempt, before retry).
    expect(callsAtHookTime).toBe(1);
  });

  it("validation-feedback: hook fires before the retry sdk-call", async () => {
    let callsAtHookTime = -1;
    const adapter = createVercelAdapter({
      models: { [MODEL_ID]: fakeLanguageModel },
      pricing: { [MODEL_ID]: { inputPer1M: 1, outputPer1M: 4 } },
      onRetry: () => {
        callsAtHookTime = mockGenerateText.mock.calls.length;
      },
    });
    const port = adapter.createLLMPort(MODEL_ID, ALIAS);

    mockGenerateText
      .mockResolvedValueOnce(
        buildVercelGenerateTextResult({
          text: '{"wrongField":"x"}',
          promptTokens: 10,
          completionTokens: 5,
          modelId: MODEL_ID,
        }),
      )
      .mockResolvedValueOnce(
        buildVercelGenerateTextResult({
          text: '{"label":"spam"}',
          promptTokens: 10,
          completionTokens: 5,
          modelId: MODEL_ID,
        }),
      );

    await port.generateStructured({
      taskType: "t",
      prompt: "classify",
      schema: z.object({ label: z.string() }),
      schemaName: "c",
    });

    expect(mockGenerateText.mock.calls.length).toBe(2);
    expect(callsAtHookTime).toBe(1);
  });
});
