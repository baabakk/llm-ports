/**
 * useStrictResponseFormat option (alpha.9).
 *
 * generateStructured can emit OpenAI / Cerebras strict-mode
 * `response_format: { type: "json_schema", strict: true }` instead of
 * classic `response_format: { type: "json_object" }`. Auto-enabled when
 * baseURL contains "api.cerebras.ai"; can be set explicitly.
 *
 * Strict mode constrains decoding to the schema before tokens are
 * produced — so invalid JSON or missing fields are impossible (modulo
 * provider bugs).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildOpenAIChatResponse,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { createOpenAIAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
});

describe("useStrictResponseFormat", () => {
  it("emits json_schema response_format when explicitly enabled", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"name":"Babak","age":42}',
        promptTokens: 10,
        completionTokens: 5,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      useStrictResponseFormat: true,
      pricingOverrides: { "test-model": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("test-model", "test");

    const schema = z.object({ name: z.string(), age: z.number() });
    const result = await port.generateStructured({
      taskType: "test",
      prompt: "Extract.",
      schema,
      schemaName: "person",
    });

    expect(result.data).toEqual({ name: "Babak", age: 42 });
    const callArgs = mockChatCompletionsCreate.mock.calls[0]![0] as {
      response_format?: {
        type: string;
        json_schema?: { name: string; schema: Record<string, unknown>; strict: boolean };
      };
    };
    expect(callArgs.response_format?.type).toBe("json_schema");
    expect(callArgs.response_format?.json_schema?.name).toBe("person");
    expect(callArgs.response_format?.json_schema?.strict).toBe(true);
    expect(callArgs.response_format?.json_schema?.schema["type"]).toBe("object");
    // Strict mode requires additionalProperties: false on every nested object
    expect(callArgs.response_format?.json_schema?.schema["additionalProperties"]).toBe(false);
  });

  it("auto-enables when baseURL is the Cerebras endpoint", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":1}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.cerebras.ai/v1",
      pricingOverrides: { "gpt-oss-120b": { inputPer1M: 0.25, outputPer1M: 0.35 } },
    });
    const port = adapter.createLLMPort("gpt-oss-120b", "cerebras");

    await port.generateStructured({
      taskType: "test",
      prompt: "x is 1",
      schema: z.object({ x: z.number() }),
    });

    const callArgs = mockChatCompletionsCreate.mock.calls[0]![0] as {
      response_format?: { type: string };
    };
    expect(callArgs.response_format?.type).toBe("json_schema");
  });

  it("falls back to classic json_object when the option is omitted (non-Cerebras)", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":1}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "test-model": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("test-model", "test");

    await port.generateStructured({
      taskType: "test",
      prompt: "x is 1",
      schema: z.object({ x: z.number() }),
    });

    const callArgs = mockChatCompletionsCreate.mock.calls[0]![0] as {
      response_format?: { type: string };
    };
    expect(callArgs.response_format?.type).toBe("json_object");
  });

  it("explicit useStrictResponseFormat=false overrides Cerebras auto-detect", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":1}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.cerebras.ai/v1",
      useStrictResponseFormat: false,
      pricingOverrides: { "gpt-oss-120b": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("gpt-oss-120b", "cerebras");

    await port.generateStructured({
      taskType: "test",
      prompt: "x is 1",
      schema: z.object({ x: z.number() }),
    });

    const callArgs = mockChatCompletionsCreate.mock.calls[0]![0] as {
      response_format?: { type: string };
    };
    expect(callArgs.response_format?.type).toBe("json_object");
  });

  it("recursively applies additionalProperties: false on nested objects", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"user":{"name":"x","address":{"city":"y"}}}',
        promptTokens: 5,
        completionTokens: 10,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      useStrictResponseFormat: true,
      pricingOverrides: { "test-model": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("test-model", "test");

    const schema = z.object({
      user: z.object({
        name: z.string(),
        address: z.object({ city: z.string() }),
      }),
    });
    await port.generateStructured({
      taskType: "test",
      prompt: "Build a user.",
      schema,
    });

    const callArgs = mockChatCompletionsCreate.mock.calls[0]![0] as {
      response_format: {
        json_schema: {
          schema: {
            additionalProperties: boolean;
            properties: { user: { additionalProperties: boolean; properties: { address: { additionalProperties: boolean } } } };
          };
        };
      };
    };
    const root = callArgs.response_format.json_schema.schema;
    expect(root.additionalProperties).toBe(false);
    expect(root.properties.user.additionalProperties).toBe(false);
    expect(root.properties.user.properties.address.additionalProperties).toBe(false);
  });
});
