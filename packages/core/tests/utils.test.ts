/**
 * Tests for the shared adapter utilities hoisted in alpha.3.
 *
 *   - wrapProviderError(alias, err)
 *   - stringifyContentBlocks(content)
 *   - extractJSON(raw)
 *   - tryParsePartialJSON(buffer)
 *   - mergeTokenUsage(a, b)
 */

import { describe, it, expect } from "vitest";
import {
  wrapProviderError,
  stringifyContentBlocks,
  extractJSON,
  tryParsePartialJSON,
  mergeTokenUsage,
  ProviderUnavailableError,
  EmptyResponseError,
  ValidationError,
  type TokenUsage,
  type MessageContent,
} from "../src/index.js";

describe("wrapProviderError", () => {
  it("passes ProviderUnavailableError through unchanged", () => {
    const inner = new ProviderUnavailableError("alias", new Error("orig"));
    expect(wrapProviderError("alias", inner)).toBe(inner);
  });

  it("passes EmptyResponseError through unchanged", () => {
    const inner = new EmptyResponseError("alias", "model-x", "hint");
    expect(wrapProviderError("alias", inner)).toBe(inner);
  });

  it("passes ValidationError through unchanged", () => {
    const inner = new ValidationError([], 1);
    expect(wrapProviderError("alias", inner)).toBe(inner);
  });

  it("wraps a plain Error as ProviderUnavailableError", () => {
    const err = new Error("boom");
    const wrapped = wrapProviderError("alias", err);
    expect(wrapped).toBeInstanceOf(ProviderUnavailableError);
    expect((wrapped as ProviderUnavailableError).alias).toBe("alias");
    expect((wrapped as ProviderUnavailableError).cause).toBe(err);
  });

  it("stringifies non-Error values before wrapping", () => {
    const wrapped = wrapProviderError("alias", "string error");
    expect(wrapped).toBeInstanceOf(ProviderUnavailableError);
    expect((wrapped as ProviderUnavailableError).cause.message).toBe("string error");
  });

  it("handles undefined gracefully", () => {
    const wrapped = wrapProviderError("alias", undefined);
    expect(wrapped).toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("stringifyContentBlocks", () => {
  it("returns string input unchanged", () => {
    expect(stringifyContentBlocks("hello")).toBe("hello");
  });

  it("joins text blocks with newlines", () => {
    const content: MessageContent = [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ];
    expect(stringifyContentBlocks(content)).toBe("line one\nline two");
  });

  it("renders image block as [image content]", () => {
    const content: MessageContent = [
      {
        type: "image",
        source: { type: "url", url: "https://example.com/img.png" },
      },
    ];
    expect(stringifyContentBlocks(content)).toBe("[image content]");
  });

  it("renders audio block as [audio content]", () => {
    const content: MessageContent = [
      {
        type: "audio",
        source: {
          type: "base64",
          mediaType: "audio/wav",
          data: "abc",
        },
      },
    ];
    expect(stringifyContentBlocks(content)).toBe("[audio content]");
  });

  it("renders tool_use block with name", () => {
    const content: MessageContent = [
      { type: "tool_use", id: "call-1", name: "lookupOrder", input: { id: "X" } },
    ];
    expect(stringifyContentBlocks(content)).toBe("[tool_use lookupOrder]");
  });

  it("renders tool_result block with toolUseId", () => {
    const content: MessageContent = [
      { type: "tool_result", toolUseId: "call-1", content: "ok" },
    ];
    expect(stringifyContentBlocks(content)).toBe("[tool_result for call-1]");
  });

  it("mixes block types", () => {
    const content: MessageContent = [
      { type: "text", text: "before" },
      { type: "image", source: { type: "url", url: "x" } },
      { type: "text", text: "after" },
    ];
    expect(stringifyContentBlocks(content)).toBe("before\n[image content]\nafter");
  });
});

describe("extractJSON", () => {
  it("parses a plain JSON object", () => {
    expect(extractJSON('{"a": 1}')).toEqual({ a: 1 });
  });

  it("strips ```json ``` fences", () => {
    expect(extractJSON('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("strips ``` ``` fences", () => {
    expect(extractJSON('```\n{"a": 2}\n```')).toEqual({ a: 2 });
  });

  it("extracts JSON with surrounding prose", () => {
    expect(extractJSON('here it is: {"x": "y"} done')).toEqual({ x: "y" });
  });

  it("throws on invalid JSON", () => {
    expect(() => extractJSON("not even json")).toThrow();
  });
});

describe("tryParsePartialJSON", () => {
  it("returns null when no { yet", () => {
    expect(tryParsePartialJSON("just text")).toBeNull();
  });

  it("parses a complete object", () => {
    expect(tryParsePartialJSON('{"a": 1}')).toEqual({ a: 1 });
  });

  it("balances open braces in incomplete object", () => {
    const result = tryParsePartialJSON('{"a": 1') as { a: number };
    expect(result.a).toBe(1);
  });

  it("trims trailing commas before balancing", () => {
    const result = tryParsePartialJSON('{"a": 1, "b": 2,') as { a: number; b: number };
    expect(result.a).toBe(1);
    expect(result.b).toBe(2);
  });

  it("balances incomplete arrays", () => {
    const result = tryParsePartialJSON('{"items": [1, 2, 3') as { items: number[] };
    expect(result.items).toEqual([1, 2, 3]);
  });

  it("returns null on unsalvageable input", () => {
    expect(tryParsePartialJSON('{"a": {{"broken')).toBeNull();
  });
});

describe("mergeTokenUsage", () => {
  it("adds inputTokens, outputTokens, totalTokens", () => {
    const a: TokenUsage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    const b: TokenUsage = { inputTokens: 5, outputTokens: 15, totalTokens: 20 };
    expect(mergeTokenUsage(a, b)).toEqual({
      inputTokens: 15,
      outputTokens: 35,
      totalTokens: 50,
    });
  });

  it("preserves cacheReadTokens when set on either side", () => {
    const a: TokenUsage = { inputTokens: 10, outputTokens: 0, totalTokens: 10, cacheReadTokens: 5 };
    const b: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    expect(mergeTokenUsage(a, b).cacheReadTokens).toBe(5);
  });

  it("sums cacheReadTokens when both have it", () => {
    const a: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 3 };
    const b: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 7 };
    expect(mergeTokenUsage(a, b).cacheReadTokens).toBe(10);
  });

  it("preserves cacheWriteTokens when set", () => {
    const a: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheWriteTokens: 2 };
    const b: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    expect(mergeTokenUsage(a, b).cacheWriteTokens).toBe(2);
  });

  it("preserves reasoningTokens when set", () => {
    const a: TokenUsage = { inputTokens: 0, outputTokens: 50, totalTokens: 50, reasoningTokens: 40 };
    const b: TokenUsage = { inputTokens: 0, outputTokens: 30, totalTokens: 30, reasoningTokens: 25 };
    expect(mergeTokenUsage(a, b).reasoningTokens).toBe(65);
  });

  it("omits optional fields when neither side has them", () => {
    const a: TokenUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const b: TokenUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const merged = mergeTokenUsage(a, b);
    expect(merged.cacheReadTokens).toBeUndefined();
    expect(merged.cacheWriteTokens).toBeUndefined();
    expect(merged.reasoningTokens).toBeUndefined();
  });
});
