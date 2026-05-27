/**
 * useStrictResponseFormat option (alpha.9 base + alpha.14 auto-detect expansion).
 *
 * generateStructured can emit OpenAI / Cerebras / Groq strict-mode
 * `response_format: { type: "json_schema", strict: true }` instead of
 * classic `response_format: { type: "json_object" }`. Auto-enabled when:
 *   - baseURL is unset (OpenAI native) — alpha.14+
 *   - baseURL contains "api.cerebras.ai" — alpha.9
 *   - baseURL contains "api.groq.com" — alpha.14+
 *
 * Stays opt-in for unverified compat providers (SambaNova, Together,
 * Fireworks, Clarifai). Set explicitly via `useStrictResponseFormat`.
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
import { autoDetectStrictResponseFormat, createOpenAIAdapter } from "../../src/index.js";

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

  it("auto-enables when baseURL is unset (OpenAI native — alpha.14+)", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":1}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      // No baseURL: OpenAI native. Strict json_schema has been GA on
      // gpt-4o / gpt-5 / o-series since August 2024 — auto-enabled.
      pricingOverrides: { "gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.2 } },
    });
    const port = adapter.createLLMPort("gpt-5-nano", "openai");

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

  it("auto-enables when baseURL is the Groq endpoint (alpha.14+)", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":1}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.groq.com/openai/v1",
      displayName: "groq",
      pricingOverrides: {
        "openai/gpt-oss-120b": { inputPer1M: 0.15, outputPer1M: 0.6 },
      },
    });
    const port = adapter.createLLMPort("openai/gpt-oss-120b", "groq");

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

  it("auto-enables when baseURL is the SambaNova endpoint (alpha.15+)", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":1}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.sambanova.ai/v1",
      displayName: "sambanova",
      pricingOverrides: {
        "MiniMax-M2.7": { inputPer1M: 0.6, outputPer1M: 2.4 },
      },
    });
    const port = adapter.createLLMPort("MiniMax-M2.7", "sambanova");

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

  it("stays opt-in (json_object default) for unverified compat providers like Together AI", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":1}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.together.xyz/v1",
      displayName: "together",
      pricingOverrides: {
        "meta-llama/Llama-3.3-70B-Instruct-Turbo": { inputPer1M: 0.88, outputPer1M: 0.88 },
      },
    });
    const port = adapter.createLLMPort(
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "together",
    );

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

  it("explicit useStrictResponseFormat=false overrides the OpenAI-native default", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: '{"x":1}',
        promptTokens: 5,
        completionTokens: 3,
      }),
    );

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      // No baseURL: would auto-enable in alpha.14+. Explicit false
      // suppresses the default — important for schemas with z.record()
      // or other open shapes that can't accept additionalProperties: false.
      useStrictResponseFormat: false,
      pricingOverrides: { "gpt-5-nano": { inputPer1M: 1, outputPer1M: 1 } },
    });
    const port = adapter.createLLMPort("gpt-5-nano", "openai");

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

describe("autoDetectStrictResponseFormat", () => {
  it.each([
    // [baseURL, expected]
    [undefined, true],                                            // OpenAI native (alpha.14+)
    ["https://api.openai.com/v1", true],                          // explicit OpenAI host — contains nothing we exclude
    ["https://api.cerebras.ai/v1", true],                         // Cerebras (alpha.9)
    ["https://api.groq.com/openai/v1", true],                     // Groq (alpha.14+)
    ["https://api.sambanova.ai/v1", true],                        // SambaNova (alpha.15+) — empirically verified
    ["https://api.together.xyz/v1", false],                       // Together — unverified
    ["https://api.fireworks.ai/inference/v1", false],             // Fireworks — unverified
    ["https://api.clarifai.com/v2/ext/openai/v1", false],         // Clarifai — unverified
    ["http://localhost:11434/v1", false],                         // Ollama compat-mode — unverified
    ["http://localhost:4000", false],                             // LiteLLM proxy — unverified
  ])("baseURL=%j → strict-default=%s", (baseURL, expected) => {
    expect(autoDetectStrictResponseFormat(baseURL)).toBe(expected);
  });

  it("matches when baseURL contains api.cerebras.ai (substring, not exact-match)", () => {
    expect(autoDetectStrictResponseFormat("https://api.cerebras.ai/v1")).toBe(true);
    expect(autoDetectStrictResponseFormat("https://api.cerebras.ai/v1/")).toBe(true);
  });

  it("matches when baseURL contains api.groq.com (substring, not exact-match)", () => {
    expect(autoDetectStrictResponseFormat("https://api.groq.com/openai/v1")).toBe(true);
    expect(autoDetectStrictResponseFormat("https://api.groq.com/v1")).toBe(true);
  });
});
