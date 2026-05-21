/**
 * Content translation between ContentBlock[] and Gemini Part[].
 */

import { describe, expect, it } from "vitest";
import {
  extractGeminiText,
  fromGeminiCandidate,
  toGeminiParts2,
  toGeminiRequest,
} from "../src/content.js";

describe("toGeminiParts2", () => {
  it("converts plain string to a single text part", () => {
    expect(toGeminiParts2("hello")).toEqual([{ text: "hello" }]);
  });

  it("converts a text block to a Gemini text part", () => {
    expect(toGeminiParts2([{ type: "text", text: "hi" }])).toEqual([{ text: "hi" }]);
  });

  it("converts base64 image to inlineData", () => {
    expect(
      toGeminiParts2([
        {
          type: "image",
          source: { kind: "base64", mediaType: "image/png", data: "abc" },
        },
      ]),
    ).toEqual([{ inlineData: { mimeType: "image/png", data: "abc" } }]);
  });

  it("converts URL image to fileData", () => {
    const result = toGeminiParts2([
      { type: "image", source: { kind: "url", url: "https://example.com/x.png" } },
    ]);
    expect(result).toEqual([
      { fileData: { mimeType: "image/jpeg", fileUri: "https://example.com/x.png" } },
    ]);
  });

  it("converts mixed text + image", () => {
    expect(
      toGeminiParts2([
        { type: "text", text: "what is this?" },
        { type: "image", source: { kind: "base64", mediaType: "image/jpeg", data: "xyz" } },
      ]),
    ).toEqual([
      { text: "what is this?" },
      { inlineData: { mimeType: "image/jpeg", data: "xyz" } },
    ]);
  });

  it("converts tool_use to functionCall", () => {
    expect(
      toGeminiParts2([
        { type: "tool_use", id: "t1", name: "search", input: { q: "weather" } },
      ]),
    ).toEqual([{ functionCall: { name: "search", args: { q: "weather" } } }]);
  });

  it("converts tool_result to functionResponse with name=toolUseId", () => {
    expect(
      toGeminiParts2([
        { type: "tool_result", toolUseId: "t1", content: "sunny, 72F" },
      ]),
    ).toEqual([{ functionResponse: { name: "t1", response: { result: "sunny, 72F" } } }]);
  });
});

describe("toGeminiRequest", () => {
  it("hoists system messages to systemInstruction", () => {
    expect(
      toGeminiRequest([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi." },
      ]),
    ).toEqual({
      systemInstruction: "You are helpful.",
      contents: [{ role: "user", parts: [{ text: "Hi." }] }],
    });
  });

  it("concatenates multiple system messages with blank lines", () => {
    expect(
      toGeminiRequest([
        { role: "system", content: "Be brief." },
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Hi." },
      ]),
    ).toEqual({
      systemInstruction: "Be brief.\n\nBe helpful.",
      contents: [{ role: "user", parts: [{ text: "Hi." }] }],
    });
  });

  it("maps assistant role to model", () => {
    expect(
      toGeminiRequest([
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ]),
    ).toEqual({
      contents: [
        { role: "user", parts: [{ text: "Hi" }] },
        { role: "model", parts: [{ text: "Hello!" }] },
      ],
    });
  });

  it("maps tool role to function", () => {
    expect(
      toGeminiRequest([
        { role: "tool", content: "result" },
      ]),
    ).toEqual({
      contents: [{ role: "function", parts: [{ text: "result" }] }],
    });
  });

  it("returns no systemInstruction key when no system messages", () => {
    const result = toGeminiRequest([{ role: "user", content: "hi" }]);
    expect("systemInstruction" in result).toBe(false);
  });
});

describe("extractGeminiText", () => {
  it("joins all text parts", () => {
    expect(extractGeminiText([{ text: "a" }, { text: "b" }])).toBe("ab");
  });

  it("ignores non-text parts", () => {
    expect(
      extractGeminiText([
        { text: "hello" },
        { inlineData: { mimeType: "image/png", data: "x" } },
        { text: " world" },
      ]),
    ).toBe("hello world");
  });

  it("returns empty string for undefined or empty input", () => {
    expect(extractGeminiText(undefined)).toBe("");
    expect(extractGeminiText([])).toBe("");
  });
});

describe("fromGeminiCandidate", () => {
  it("decodes text parts to text ContentBlocks", () => {
    expect(
      fromGeminiCandidate({
        content: { parts: [{ text: "hello" }] },
      }),
    ).toEqual([{ type: "text", text: "hello" }]);
  });

  it("decodes functionCall parts to tool_use ContentBlocks", () => {
    const result = fromGeminiCandidate({
      content: {
        parts: [{ functionCall: { name: "search", args: { q: "weather" } } }],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "tool_use",
      name: "search",
      input: { q: "weather" },
    });
  });

  it("decodes inlineData image parts back to ImageBlocks", () => {
    expect(
      fromGeminiCandidate({
        content: {
          parts: [{ inlineData: { mimeType: "image/png", data: "xyz" } }],
        },
      }),
    ).toEqual([
      { type: "image", source: { kind: "base64", mediaType: "image/png", data: "xyz" } },
    ]);
  });

  it("silently drops unknown-media-type inlineData", () => {
    expect(
      fromGeminiCandidate({
        content: {
          parts: [
            { text: "ok" },
            { inlineData: { mimeType: "image/svg+xml", data: "x" } },
          ],
        },
      }),
    ).toEqual([{ type: "text", text: "ok" }]);
  });
});
