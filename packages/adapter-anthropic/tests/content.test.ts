import { ContentBlockUnsupportedError, type ContentBlock } from "@llm-ports/core";
import { describe, expect, it } from "vitest";
import {
  fromAnthropicContent,
  toAnthropicContent,
  toAnthropicMessages,
  extractAssistantText,
} from "../src/content.js";

describe("toAnthropicContent", () => {
  it("passes through string content unchanged", () => {
    expect(toAnthropicContent("hello")).toBe("hello");
  });

  it("converts a text block to Anthropic text shape", () => {
    expect(toAnthropicContent([{ type: "text", text: "hi" }])).toEqual([
      { type: "text", text: "hi" },
    ]);
  });

  it("converts base64 image to Anthropic media_type shape", () => {
    const blocks: ContentBlock[] = [
      {
        type: "image",
        source: { kind: "base64", mediaType: "image/png", data: "deadbeef" },
      },
    ];
    expect(toAnthropicContent(blocks)).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "deadbeef" },
      },
    ]);
  });

  it("converts URL image to Anthropic url shape", () => {
    expect(
      toAnthropicContent([
        { type: "image", source: { kind: "url", url: "https://example.com/cat.png" } },
      ]),
    ).toEqual([
      {
        type: "image",
        source: { type: "url", url: "https://example.com/cat.png" },
      },
    ]);
  });

  it("converts tool_use blocks", () => {
    expect(
      toAnthropicContent([
        { type: "tool_use", id: "t1", name: "search", input: { query: "x" } },
      ]),
    ).toEqual([{ type: "tool_use", id: "t1", name: "search", input: { query: "x" } }]);
  });

  it("converts tool_result blocks with isError flag", () => {
    expect(
      toAnthropicContent([
        { type: "tool_result", toolUseId: "t1", content: "fail", isError: true },
      ]),
    ).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "fail", is_error: true },
    ]);
  });

  it("throws ContentBlockUnsupportedError for audio blocks", () => {
    expect(() =>
      toAnthropicContent([
        {
          type: "audio",
          source: { kind: "base64", mediaType: "audio/mp3", data: "x" },
        },
      ]),
    ).toThrow(ContentBlockUnsupportedError);
  });
});

describe("toAnthropicMessages", () => {
  it("extracts a single system message into the system field", () => {
    const out = toAnthropicMessages([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
    expect(out.system).toBe("you are helpful");
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("concatenates multiple system messages with blank lines", () => {
    const out = toAnthropicMessages([
      { role: "system", content: "first" },
      { role: "system", content: "second" },
      { role: "user", content: "go" },
    ]);
    expect(out.system).toBe("first\n\nsecond");
  });

  it("maps tool role to user (Anthropic does not support standalone tool role)", () => {
    const out = toAnthropicMessages([
      { role: "tool", content: "result text" },
    ]);
    expect(out.messages[0]?.role).toBe("user");
  });

  it("preserves user/assistant alternation", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
    ]);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("fromAnthropicContent", () => {
  it("converts string responses to a text block", () => {
    expect(fromAnthropicContent("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("round-trips text blocks", () => {
    expect(fromAnthropicContent([{ type: "text", text: "hi" }])).toEqual([
      { type: "text", text: "hi" },
    ]);
  });

  it("normalizes Anthropic image source back to ContentBlock kind", () => {
    expect(
      fromAnthropicContent([
        { type: "image", source: { type: "base64", media_type: "image/png", data: "d" } },
      ]),
    ).toEqual([
      {
        type: "image",
        source: { kind: "base64", mediaType: "image/png", data: "d" },
      },
    ]);
  });
});

describe("extractAssistantText", () => {
  it("joins text blocks ignoring tool_use blocks", () => {
    expect(
      extractAssistantText([
        { type: "text", text: "before " },
        { type: "tool_use", id: "t1", name: "search", input: {} },
        { type: "text", text: "after" },
      ]),
    ).toBe("before after");
  });

  it("returns string content directly", () => {
    expect(extractAssistantText("plain")).toBe("plain");
  });
});
