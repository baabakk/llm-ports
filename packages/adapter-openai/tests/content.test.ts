import { ContentBlockUnsupportedError, type ContentBlock } from "@llm-ports/core";
import { describe, expect, it } from "vitest";
import {
  fromOpenAIAssistantMessage,
  toOpenAIMessages,
  toOpenAIUserContent,
  extractAssistantText,
} from "../src/content.js";

describe("toOpenAIUserContent", () => {
  it("passes through string content", () => {
    expect(toOpenAIUserContent("hello")).toBe("hello");
  });

  it("collapses text-only blocks to a single string", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "hi " },
      { type: "text", text: "world" },
    ];
    expect(toOpenAIUserContent(blocks)).toBe("hi world");
  });

  it("converts URL image to image_url part", () => {
    expect(
      toOpenAIUserContent([
        { type: "text", text: "describe" },
        { type: "image", source: { kind: "url", url: "https://example.com/cat.png" } },
      ]),
    ).toEqual([
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
    ]);
  });

  it("converts base64 image to data: URL", () => {
    expect(
      toOpenAIUserContent([
        {
          type: "image",
          source: { kind: "base64", mediaType: "image/png", data: "deadbeef" },
        },
      ]),
    ).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,deadbeef" } },
    ]);
  });

  it("converts base64 audio (wav/mp3) to input_audio part", () => {
    expect(
      toOpenAIUserContent([
        { type: "audio", source: { kind: "base64", mediaType: "audio/wav", data: "dat" } },
      ]),
    ).toEqual([{ type: "input_audio", input_audio: { data: "dat", format: "wav" } }]);
  });

  it("rejects URL audio (OpenAI requires base64)", () => {
    expect(() =>
      toOpenAIUserContent([
        { type: "audio", source: { kind: "url", url: "https://example.com/a.wav" } },
      ]),
    ).toThrow(ContentBlockUnsupportedError);
  });

  it("rejects audio/ogg (OpenAI does not support ogg)", () => {
    expect(() =>
      toOpenAIUserContent([
        { type: "audio", source: { kind: "base64", mediaType: "audio/ogg", data: "x" } },
      ]),
    ).toThrow(ContentBlockUnsupportedError);
  });
});

describe("toOpenAIMessages", () => {
  it("preserves system messages as-is", () => {
    const out = toOpenAIMessages([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
    expect(out[0]).toEqual({ role: "system", content: "you are helpful" });
    expect(out[1]).toEqual({ role: "user", content: "hi" });
  });

  it("promotes assistant tool_use blocks into tool_calls", () => {
    const out = toOpenAIMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me search" },
          { type: "tool_use", id: "t1", name: "search", input: { query: "x" } },
        ],
      },
    ]);
    const m = out[0] as { role: "assistant"; content: string | null; tool_calls?: unknown[] };
    expect(m.role).toBe("assistant");
    expect(m.content).toBe("let me search");
    expect(m.tool_calls).toEqual([
      { id: "t1", type: "function", function: { name: "search", arguments: '{"query":"x"}' } },
    ]);
  });

  it("emits assistant message with content=null when only tool_calls present", () => {
    const out = toOpenAIMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "fetch", input: { url: "x" } }],
      },
    ]);
    const m = out[0] as { role: "assistant"; content: string | null };
    expect(m.content).toBeNull();
  });

  it("promotes user tool_result blocks to standalone tool messages", () => {
    const out = toOpenAIMessages([
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "t1", content: "search done" }],
      },
    ]);
    expect(out).toEqual([
      { role: "tool", tool_call_id: "t1", content: "search done" },
    ]);
  });

  it("handles mixed user content with both tool_results and a follow-up text", () => {
    const out = toOpenAIMessages([
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: "found 3 items" },
          { type: "text", text: "now summarize" },
        ],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: "tool", tool_call_id: "t1", content: "found 3 items" });
    const userMsg = out[1] as { role: "user"; content: string };
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toBe("now summarize");
  });

  it("strigifies non-string tool_use input as JSON arguments", () => {
    const out = toOpenAIMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "calc",
            input: { a: 1, b: 2 },
          },
        ],
      },
    ]);
    const m = out[0] as { tool_calls: Array<{ function: { arguments: string } }> };
    expect(JSON.parse(m.tool_calls[0]!.function.arguments)).toEqual({ a: 1, b: 2 });
  });
});

describe("fromOpenAIAssistantMessage", () => {
  it("converts text-only response to a single text block", () => {
    expect(fromOpenAIAssistantMessage({ content: "hello" })).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("converts response with tool_calls into text + tool_use blocks", () => {
    expect(
      fromOpenAIAssistantMessage({
        content: "let me look",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "search", arguments: '{"query":"x"}' },
          },
        ],
      }),
    ).toEqual([
      { type: "text", text: "let me look" },
      { type: "tool_use", id: "t1", name: "search", input: { query: "x" } },
    ]);
  });

  it("handles tool_calls with non-JSON arguments by passing through as string", () => {
    const blocks = fromOpenAIAssistantMessage({
      content: null,
      tool_calls: [
        {
          id: "t1",
          type: "function",
          function: { name: "echo", arguments: "not-json" },
        },
      ],
    });
    expect(blocks).toEqual([
      { type: "tool_use", id: "t1", name: "echo", input: "not-json" },
    ]);
  });

  it("returns empty when content is null and no tool_calls", () => {
    expect(fromOpenAIAssistantMessage({ content: null })).toEqual([]);
  });
});

describe("extractAssistantText", () => {
  it("returns string content directly", () => {
    expect(extractAssistantText({ content: "hi" })).toBe("hi");
  });

  it("returns empty when content is null", () => {
    expect(extractAssistantText({ content: null })).toBe("");
  });

  it("joins text parts when content is array form", () => {
    expect(
      extractAssistantText({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
  });
});
