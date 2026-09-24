/**
 * A provider that refuses a feature with an unexplained 400 is learned once.
 *
 * Alpha.35 item 8, from alpha.28 item 5. ADW's probe of 2026-06-18 is the
 * specification: Cerebras rejected a strict-schema request with a 400 carrying
 * no usable body, so the existing rescue, which reads a reason out of the
 * error, never fired. Every call re-discovered the same rejection and paid for
 * it.
 *
 * **The design being tested is an experiment, not a guess.** An unexplained
 * 400 on a request that carried a `response_format` buys one retry with that
 * field removed. Only if the retry succeeds is the constraint remembered. If
 * it fails, the 400 was about something else, nothing is learned, and the
 * model is marked so no later call repeats the probe. Those outcomes are what
 * the tests below pin, because the failure case is where a guess would have
 * done real damage: a wrongly learned constraint silently disables strict
 * schemas for a model that supports them, and the only symptom is worse
 * structured-output reliability much later.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildOpenAIChatResponse,
  buildOpenAIError,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import {
  _resetLearnedConstraints,
  getEffectiveCapabilities,
  isOpaqueBadRequest,
} from "../../src/capabilities.js";
import { createOpenAIAdapter } from "../../src/index.js";

const MODEL = "gpt-oss-120b";
const Schema = z.object({ intent: z.string() });
const ANSWER = JSON.stringify({ intent: "request" });

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

function port() {
  return createOpenAIAdapter({
    apiKey: "test",
    baseURL: "https://api.cerebras.ai/v1",
    useStrictResponseFormat: true,
  }).createLLMPort(MODEL, "cerebras");
}

/** The shape ADW recorded: a 400 that names no field and no reason code. */
function bodylessBadRequest(): Error {
  return buildOpenAIError({ status: 400, message: "Bad Request" });
}

function answers(text: string = ANSWER): void {
  mockChatCompletionsCreate.mockResolvedValueOnce(
    buildOpenAIChatResponse({ text, promptTokens: 10, completionTokens: 4, modelId: MODEL }),
  );
}

/** Did the request that went out on call `n` carry a response_format? */
function sentResponseFormat(n: number): boolean {
  const body = mockChatCompletionsCreate.mock.calls[n]?.[0] as { response_format?: unknown };
  return body?.response_format !== undefined;
}

describe("the classifier", () => {
  it("treats a 400 with no code and no param as unexplained", () => {
    expect(isOpaqueBadRequest(bodylessBadRequest())).toBe(true);
  });

  it("leaves an explained 400 to the classifiers that can read it", () => {
    // This one names the field, so the existing rescue handles it and this
    // check must not also claim it. Two rescues firing on one error would mean
    // the learned constraint depended on which ran first.
    const explained = buildOpenAIError({
      status: 400,
      code: "unsupported_value",
      param: "response_format",
      message: "model does not support response_format",
    });
    expect(isOpaqueBadRequest(explained)).toBe(false);
  });

  it("ignores anything that is not a 400", () => {
    expect(isOpaqueBadRequest(buildOpenAIError({ status: 500, message: "Internal" }))).toBe(false);
    expect(isOpaqueBadRequest(buildOpenAIError({ status: 429, message: "Slow down" }))).toBe(false);
    expect(isOpaqueBadRequest(new Error("no status at all"))).toBe(false);
  });
});

describe("when the feature really was the problem", () => {
  it("retries without the schema and answers", async () => {
    mockChatCompletionsCreate.mockRejectedValueOnce(bodylessBadRequest());
    answers();

    const result = await port().generateStructured({
      taskType: "classify",
      messages: [{ role: "user", content: "classify this" }],
      schema: Schema,
    });

    expect(result.data).toEqual({ intent: "request" });
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(2);
    // The first request carried the strict schema and the retry did not. That
    // difference is the whole experiment.
    expect(sentResponseFormat(0)).toBe(true);
    expect(sentResponseFormat(1)).toBe(false);
  });

  it("remembers the constraint, so the next call does not probe again", async () => {
    mockChatCompletionsCreate.mockRejectedValueOnce(bodylessBadRequest());
    answers();
    const p = port();
    await p.generateStructured({
      taskType: "classify",
      messages: [{ role: "user", content: "one" }],
      schema: Schema,
    });

    // Proven by a successful downgraded call, so it is now a learned fact.
    expect(getEffectiveCapabilities(MODEL, undefined).jsonMode).toBe(false);

    answers();
    await p.generateStructured({
      taskType: "classify",
      messages: [{ role: "user", content: "two" }],
      schema: Schema,
    });

    // One request for the second call, not two: it took the fallback path up
    // front instead of re-probing, which is the cost this item removes.
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(3);
    expect(sentResponseFormat(2)).toBe(false);
  });

  it("does not leak the constraint to another model", async () => {
    mockChatCompletionsCreate.mockRejectedValueOnce(bodylessBadRequest());
    answers();
    await port().generateStructured({
      taskType: "classify",
      messages: [{ role: "user", content: "x" }],
      schema: Schema,
    });

    expect(getEffectiveCapabilities(MODEL, undefined).jsonMode).toBe(false);
    // A different model was never probed and keeps its default.
    expect(getEffectiveCapabilities("gpt-4o", undefined).jsonMode).not.toBe(false);
  });
});

describe("when the 400 was about something else", () => {
  it("learns nothing and surfaces the original failure", async () => {
    // Both the original and the downgraded request fail, which is what an
    // unrelated cause looks like from here.
    mockChatCompletionsCreate.mockRejectedValueOnce(bodylessBadRequest());
    mockChatCompletionsCreate.mockRejectedValueOnce(bodylessBadRequest());

    await expect(
      port().generateStructured({
        taskType: "classify",
        messages: [{ role: "user", content: "x" }],
        schema: Schema,
      }),
    ).rejects.toThrow();

    // The important assertion in this file: no constraint was recorded from a
    // failed experiment.
    expect(getEffectiveCapabilities(MODEL, undefined).jsonMode).not.toBe(false);
  });

  it("does not repeat the failed experiment on later calls", async () => {
    mockChatCompletionsCreate.mockRejectedValueOnce(bodylessBadRequest());
    mockChatCompletionsCreate.mockRejectedValueOnce(bodylessBadRequest());
    const p = port();
    await expect(
      p.generateStructured({
        taskType: "classify",
        messages: [{ role: "user", content: "one" }],
        schema: Schema,
      }),
    ).rejects.toThrow();
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(2);

    // A model that already refused to be rescued this way is not probed again,
    // so a persistent unrelated 400 costs one wasted request in the process
    // rather than one on every call.
    mockChatCompletionsCreate.mockRejectedValueOnce(bodylessBadRequest());
    await expect(
      p.generateStructured({
        taskType: "classify",
        messages: [{ role: "user", content: "two" }],
        schema: Schema,
      }),
    ).rejects.toThrow();
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(3);
    // And the schema was still sent, because nothing was learned about it.
    expect(sentResponseFormat(2)).toBe(true);
  });
});

describe("what the probe must not touch", () => {
  it("leaves a plain text call alone, since it sent no response_format", async () => {
    mockChatCompletionsCreate.mockRejectedValueOnce(bodylessBadRequest());

    await expect(
      port().generateText({
        taskType: "chat",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow();

    // One request only. There is no feature to remove from a call that asked
    // for nothing special, so retrying it would just double the failure.
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
  });
});
