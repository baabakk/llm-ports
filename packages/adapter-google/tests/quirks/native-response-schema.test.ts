/**
 * Gemini native responseSchema constrained-decoding (alpha.5 v0.2-commitment,
 * shipped alpha.9).
 *
 * generateStructured now emits `config.responseSchema` (a JSON Schema
 * OpenAPI 3.0 subset converted from the user's Zod schema) so Gemini
 * constrains decoding to the schema. Zod validation + the alpha.5 repair
 * pass + retry-with-feedback remain the safety net.
 *
 * For schemas containing features Gemini does not accept (oneOf, $ref,
 * allOf, not), the adapter falls back to the prompted-JSON path with a
 * one-time console.warn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGeminiResponse,
  mockGenerateContent,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { z } from "zod";
import {
  _resetSchemaFallbackWarnings,
  createGoogleAdapter,
} from "../../src/index.js";

beforeEach(() => {
  resetMocks();
  _resetSchemaFallbackWarnings();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const adapter = createGoogleAdapter({ apiKey: "test" });
const port = adapter.createLLMPort("gemini-2.5-flash", "test");

describe("generateStructured — native responseSchema", () => {
  it("clean schema: forwards responseSchema to Gemini and skips the prompt suffix", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({
        text: '{"name":"Babak","age":42}',
        promptTokens: 10,
        outputTokens: 8,
      }),
    );

    const schema = z.object({ name: z.string(), age: z.number() });
    const result = await port.generateStructured({
      taskType: "test",
      prompt: "Extract the user from: 'Babak is 42'",
      schema,
    });

    expect(result.data).toEqual({ name: "Babak", age: 42 });
    const callArgs = mockGenerateContent.mock.calls[0]![0] as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      config: { responseSchema?: Record<string, unknown>; responseMimeType?: string };
    };
    expect(callArgs.config.responseSchema).toBeDefined();
    expect(callArgs.config.responseMimeType).toBe("application/json");
    expect(callArgs.config.responseSchema!["type"]).toBe("object");
    // The "Reply with a single JSON object only" suffix should NOT be appended
    // when native responseSchema is in use.
    expect(callArgs.contents[0]!.parts[0]!.text).not.toContain("Reply with a single JSON object only");
  });

  it("strips $schema from the responseSchema before forwarding", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({
        text: '{"x":1}',
        promptTokens: 5,
        outputTokens: 3,
      }),
    );

    const schema = z.object({ x: z.number() });
    await port.generateStructured({
      taskType: "test",
      prompt: "x is 1",
      schema,
    });

    const callArgs = mockGenerateContent.mock.calls[0]![0] as {
      config: { responseSchema?: Record<string, unknown> };
    };
    expect(callArgs.config.responseSchema).toBeDefined();
    expect("$schema" in callArgs.config.responseSchema!).toBe(false);
  });

  it("discriminated union (zod-to-json-schema emits anyOf) stays on the native path", async () => {
    // Gemini accepts anyOf, so discriminated unions should NOT trigger the
    // prompted-JSON fallback. This guards against over-eager detection.
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({
        text: '{"kind":"a","value":42}',
        promptTokens: 10,
        outputTokens: 8,
      }),
    );

    const schema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a"), value: z.number() }),
      z.object({ kind: z.literal("b"), label: z.string() }),
    ]);

    const result = await port.generateStructured({
      taskType: "test",
      prompt: "kind a, value 42",
      schema,
    });

    expect(result.data).toEqual({ kind: "a", value: 42 });
    const callArgs = mockGenerateContent.mock.calls[0]![0] as {
      config: { responseSchema?: Record<string, unknown> };
    };
    expect(callArgs.config.responseSchema).toBeDefined();
    expect(callArgs.config.responseSchema!["anyOf"]).toBeDefined();
  });

  it("intersection schema (allOf, unsupported) falls back to prompted JSON with warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({
        text: '{"a":"foo","b":42}',
        promptTokens: 10,
        outputTokens: 8,
      }),
    );

    // z.intersection emits `allOf` in JSON Schema, which Gemini's
    // responseSchema does not accept. The adapter falls back to the
    // prompted-JSON path and emits a one-time warning.
    const schema = z.intersection(
      z.object({ a: z.string() }),
      z.object({ b: z.number() }),
    );

    const result = await port.generateStructured({
      taskType: "test",
      prompt: "Build a record.",
      schema,
    });

    expect(result.data).toEqual({ a: "foo", b: 42 });
    const callArgs = mockGenerateContent.mock.calls[0]![0] as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      config: { responseSchema?: unknown };
    };
    // Native path NOT used: no responseSchema forwarded
    expect(callArgs.config.responseSchema).toBeUndefined();
    // Prompted-JSON suffix WAS appended
    expect(callArgs.contents[0]!.parts[0]!.text).toContain("Reply with a single JSON object only");
    // And we surfaced a warning naming the unsupported feature
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]![0] as string;
    expect(warnMsg).toContain("allOf");
    expect(warnMsg).toContain("gemini-2.5-flash");
  });

  it("schema fallback warning fires once per (model, feature) pair", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGenerateContent.mockResolvedValue(
      buildGeminiResponse({
        text: '{"a":"x","b":1}',
        promptTokens: 5,
        outputTokens: 5,
      }),
    );

    const schema = z.intersection(
      z.object({ a: z.string() }),
      z.object({ b: z.number() }),
    );

    await port.generateStructured({ taskType: "test", prompt: "x", schema });
    await port.generateStructured({ taskType: "test", prompt: "y", schema });
    await port.generateStructured({ taskType: "test", prompt: "z", schema });

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("structural validation still kicks in when Gemini returns non-conforming JSON", async () => {
    // Gemini returns JSON missing the required `age` field. Zod fails the
    // first attempt; retry-with-feedback runs a second attempt with a
    // correction prompt; the corrected response passes.
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({
        text: '{"name":"Babak"}',
        promptTokens: 10,
        outputTokens: 5,
      }),
    );
    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse({
        text: '{"name":"Babak","age":42}',
        promptTokens: 15,
        outputTokens: 8,
      }),
    );

    const schema = z.object({ name: z.string(), age: z.number() });
    const result = await port.generateStructured({
      taskType: "test",
      prompt: "Extract",
      schema,
    });

    expect(result.data).toEqual({ name: "Babak", age: 42 });
    expect(result.validationAttempts).toBe(2);
  });
});
