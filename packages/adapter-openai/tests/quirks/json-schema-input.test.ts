/**
 * A caller may supply a JSON Schema instead of a Zod schema.
 *
 * Adapters convert a Zod schema to JSON Schema before sending it, so a
 * consumer holding a wire-delivered schema previously converted it backwards
 * into Zod for this library to convert forwards again. An OpenAI-compatible
 * HTTP surface receives exactly that shape from its clients.
 *
 * **The trade is the interesting part, and these tests pin it.** This library
 * carries no JSON Schema validator, so the response cannot be checked
 * locally: the schema reaches the provider, whose strict mode enforces it, and
 * the decoded JSON comes back unvalidated with one reported attempt. Anything
 * that claimed otherwise would be overstating what was verified.
 *
 * Alpha.35, from `TD-LLMPORTS-STRUCTURED-OUTPUT-IS-ZOD-ONLY`.
 */

import { ConfigError } from "@llm-ports/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildOpenAIChatResponse, mockChatCompletionsCreate, resetMocks } from "../helpers/mock-sdk.js";
import { createOpenAIAdapter } from "../../src/index.js";

const MODEL = "gpt-5";

/** The shape a client would send over the wire. */
const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "urgency"],
  properties: {
    intent: { type: "string", enum: ["question", "request"] },
    urgency: { type: "string", enum: ["low", "high"] },
  },
} as const;

function port() {
  return createOpenAIAdapter({ apiKey: "test", useStrictResponseFormat: true }).createLLMPort(
    MODEL,
    "openai",
  );
}

function respondWith(data: unknown): void {
  mockChatCompletionsCreate.mockResolvedValueOnce(
    buildOpenAIChatResponse({
      text: JSON.stringify(data),
      promptTokens: 20,
      completionTokens: 8,
      modelId: MODEL,
    }),
  );
}

beforeEach(() => {
  resetMocks();
});

describe("generateStructured with a JSON Schema", () => {
  it("sends the schema verbatim, without a Zod round trip", async () => {
    respondWith({ intent: "request", urgency: "high" });

    await port().generateStructured<{ intent: string; urgency: string }>({
      taskType: "classify",
      messages: [{ role: "user", content: "classify this" }],
      jsonSchema: JSON_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "Triage",
    });

    const sent = mockChatCompletionsCreate.mock.calls[0]![0] as {
      response_format?: { json_schema?: { name?: string; schema?: unknown } };
    };
    // The caller's own object reaches the provider unchanged. Converting it
    // through Zod and back is exactly what this option removes.
    expect(sent.response_format?.json_schema?.schema).toEqual(JSON_SCHEMA);
    expect(sent.response_format?.json_schema?.name).toBe("Triage");
  });

  it("returns the decoded data and reports one attempt", async () => {
    respondWith({ intent: "request", urgency: "high" });

    const result = await port().generateStructured<{ intent: string; urgency: string }>({
      taskType: "classify",
      messages: [{ role: "user", content: "classify this" }],
      jsonSchema: JSON_SCHEMA as unknown as Record<string, unknown>,
    });

    expect(result.data).toEqual({ intent: "request", urgency: "high" });
    // One attempt is the honest number: no validation round ran, so claiming
    // more would overstate what was checked.
    expect(result.validationAttempts).toBe(1);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.cost).toBeDefined();
  });

  it("does not validate locally, and does not pretend to", async () => {
    // A response that violates the schema comes back as-is, because nothing
    // here can check it. This is the documented cost of the option, and a test
    // asserting a rejection would be asserting a capability we do not have.
    respondWith({ intent: "NOT_AN_INTENT" });

    const result = await port().generateStructured<Record<string, unknown>>({
      taskType: "classify",
      messages: [{ role: "user", content: "classify this" }],
      jsonSchema: JSON_SCHEMA as unknown as Record<string, unknown>,
    });

    expect(result.data).toEqual({ intent: "NOT_AN_INTENT" });
    expect(result.validationAttempts).toBe(1);
    // And only one provider call: without a validator there is nothing to
    // retry against, so no retry-with-feedback round is attempted.
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
  });
});

describe("what the caller must not do", () => {
  it("refuses both schema forms at once", async () => {
    await expect(
      port().generateStructured({
        taskType: "classify",
        messages: [{ role: "user", content: "x" }],
        schema: z.object({ intent: z.string() }),
        jsonSchema: JSON_SCHEMA as unknown as Record<string, unknown>,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("refuses neither", async () => {
    await expect(
      port().generateStructured({
        taskType: "classify",
        messages: [{ role: "user", content: "x" }],
      } as never),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("the Zod path is untouched", () => {
  it("still validates and still retries with feedback", async () => {
    const Schema = z.object({
      intent: z.enum(["question", "request"]),
      urgency: z.enum(["low", "high"]),
    });
    respondWith({ intent: "WRONG", urgency: "high" });
    respondWith({ intent: "request", urgency: "high" });

    const result = await port().generateStructured({
      taskType: "classify",
      messages: [{ role: "user", content: "classify this" }],
      schema: Schema,
    });

    expect(result.data).toEqual({ intent: "request", urgency: "high" });
    // Two attempts: the validator caught the first response and the retry
    // carried the feedback. This is what the JSON Schema path gives up.
    expect(result.validationAttempts).toBe(2);
  });
});
