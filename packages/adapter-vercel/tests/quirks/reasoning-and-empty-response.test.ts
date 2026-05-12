/**
 * Closes #4 (reasoning-model starvation) and #5 (generateStructured
 * SyntaxError on empty response) for the Vercel adapter.
 *
 * Before: a reasoning model that spent all output tokens on hidden thinking
 * returned empty `text` and the caller had no signal. generateStructured
 * then crashed with `JSON.parse("")` → SyntaxError → wrapped as a generic
 * ProviderUnavailableError, blocking registry fallback routing.
 *
 * After: the adapter retries once with an expanded budget when finishReason
 * is "length" and tokens were consumed. If the retry is still empty,
 * generateStructured throws a typed EmptyResponseError so the registry can
 * route to a fallback model. generateText returns the empty text as-is
 * because empty text is a valid (if unhelpful) result.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EmptyResponseError, type RetryEvent } from "@llm-ports/core";
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

function makeAdapter(onRetry?: (e: RetryEvent) => void) {
  return createVercelAdapter({
    models: { [MODEL_ID]: fakeLanguageModel },
    pricing: { [MODEL_ID]: { inputPer1M: 1, outputPer1M: 4 } },
    ...(onRetry ? { onRetry } : {}),
  });
}

describe("#4 — reasoning-starvation expanded-budget retry", () => {
  it("starved response triggers ONE retry with expanded budget; second call succeeds", async () => {
    const events: RetryEvent[] = [];
    const adapter = makeAdapter((e) => events.push(e));
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
          text: "the actual answer",
          promptTokens: 10,
          completionTokens: 8,
        }),
      );

    const result = await port.generateText({
      taskType: "t",
      prompt: "solve this",
      maxOutputTokens: 50,
    });

    expect(result.text).toBe("the actual answer");
    expect(mockGenerateText).toHaveBeenCalledTimes(2);

    // Second call should have 4x the budget.
    const retryArgs = mockGenerateText.mock.calls[1]?.[0] as { maxTokens: number };
    expect(retryArgs.maxTokens).toBe(200);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "reasoning-starvation",
      attempt: 0,
      modelId: MODEL_ID,
      providerAlias: ALIAS,
      delayMs: 0,
    });
  });

  it("does NOT retry when maxOutputTokens is unset (no way to expand)", async () => {
    const events: RetryEvent[] = [];
    const adapter = makeAdapter((e) => events.push(e));
    const port = adapter.createLLMPort(MODEL_ID, ALIAS);

    // Even with empty text + finish=length, no retry without budget to expand.
    mockGenerateText.mockResolvedValueOnce(
      buildVercelReasoningStarvedResult({
        promptTokens: 10,
        completionTokens: 50,
      }),
    );

    const result = await port.generateText({
      taskType: "t",
      prompt: "solve this",
    });

    expect(result.text).toBe("");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it("does NOT retry on successful empty result with finishReason=stop", async () => {
    const events: RetryEvent[] = [];
    const adapter = makeAdapter((e) => events.push(e));
    const port = adapter.createLLMPort(MODEL_ID, ALIAS);

    // Model legitimately decided to return nothing (finish=stop, not length).
    mockGenerateText.mockResolvedValueOnce(
      buildVercelGenerateTextResult({
        text: "",
        promptTokens: 10,
        completionTokens: 0,
        finishReason: "stop",
      }),
    );

    await port.generateText({
      taskType: "t",
      prompt: "x",
      maxOutputTokens: 50,
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });
});

describe("#5 — generateStructured throws EmptyResponseError instead of SyntaxError", () => {
  it("empty text response after starvation retry → EmptyResponseError, not SyntaxError", async () => {
    const adapter = makeAdapter();
    const port = adapter.createLLMPort(MODEL_ID, ALIAS);

    // Both initial and starvation-retry responses are starved.
    mockGenerateText
      .mockResolvedValueOnce(
        buildVercelReasoningStarvedResult({
          promptTokens: 10,
          completionTokens: 50,
          modelId: MODEL_ID,
        }),
      )
      .mockResolvedValueOnce(
        buildVercelReasoningStarvedResult({
          promptTokens: 10,
          completionTokens: 200,
          modelId: MODEL_ID,
        }),
      );

    await expect(
      port.generateStructured({
        taskType: "t",
        prompt: "classify",
        schema: z.object({ label: z.string() }),
        schemaName: "c",
        maxOutputTokens: 50,
      }),
    ).rejects.toBeInstanceOf(EmptyResponseError);
  });

  it("EmptyResponseError carries alias + modelId so the registry can route to a fallback", async () => {
    const adapter = makeAdapter();
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
        buildVercelReasoningStarvedResult({
          promptTokens: 10,
          completionTokens: 200,
          modelId: MODEL_ID,
        }),
      );

    try {
      await port.generateStructured({
        taskType: "t",
        prompt: "classify",
        schema: z.object({ label: z.string() }),
        schemaName: "c",
        maxOutputTokens: 50,
      });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EmptyResponseError);
      const empty = err as EmptyResponseError;
      expect(empty.alias).toBe(ALIAS);
      expect(empty.modelId).toBe(MODEL_ID);
      expect(empty.hint).toMatch(/maxOutputTokens|fallback/);
    }
  });

  it("starvation retry recovers; valid JSON parses without throwing", async () => {
    const events: RetryEvent[] = [];
    const adapter = makeAdapter((e) => events.push(e));
    const port = adapter.createLLMPort(MODEL_ID, ALIAS);

    // First response: starved. Second: valid JSON.
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
          text: '{"label": "spam"}',
          promptTokens: 10,
          completionTokens: 5,
        }),
      );

    const result = await port.generateStructured({
      taskType: "t",
      prompt: "classify",
      schema: z.object({ label: z.string() }),
      schemaName: "c",
      maxOutputTokens: 50,
    });

    expect(result.data).toEqual({ label: "spam" });
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("reasoning-starvation");
  });

  it("validation-feedback retry fires onRetry hook", async () => {
    const events: RetryEvent[] = [];
    const adapter = makeAdapter((e) => events.push(e));
    const port = adapter.createLLMPort(MODEL_ID, ALIAS);

    // First valid-JSON-but-wrong-schema, second correct. Triggers
    // retry-with-feedback rather than reasoning-starvation.
    mockGenerateText
      .mockResolvedValueOnce(
        buildVercelGenerateTextResult({
          text: '{"wrongField": "no"}',
          promptTokens: 10,
          completionTokens: 5,
        }),
      )
      .mockResolvedValueOnce(
        buildVercelGenerateTextResult({
          text: '{"label": "spam"}',
          promptTokens: 10,
          completionTokens: 5,
        }),
      );

    await port.generateStructured({
      taskType: "t",
      prompt: "classify",
      schema: z.object({ label: z.string() }),
      schemaName: "c",
    });

    expect(events.some((e) => e.reason === "validation-feedback")).toBe(true);
  });
});
