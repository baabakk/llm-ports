import { ContentBlockUnsupportedError } from "@llm-ports/core";
import { describe, expect, it } from "vitest";
import {
  fromOllamaAssistantMessage,
  toOllamaMessages,
  extractAssistantText,
} from "../src/content.js";

describe("toOllamaMessages", () => {
  it("collapses text blocks into a single content string", () => {
    const out = toOllamaMessages([
      { role: "user", content: [
        { type: "text", text: "hi" },
        { type: "text", text: "world" },
      ]},
    ]);
    expect(out).toEqual([{ role: "user", content: "hi\nworld" }]);
  });

  it("extracts base64 images into the images field", () => {
    const out = toOllamaMessages([
      { role: "user", content: [
        { type: "text", text: "describe" },
        { type: "image", source: { kind: "base64", mediaType: "image/png", data: "deadbeef" } },
      ]},
    ]);
    expect(out[0]).toEqual({
      role: "user",
      content: "describe",
      images: ["deadbeef"],
    });
  });

  it("rejects URL images (Ollama does not fetch URLs)", () => {
    expect(() =>
      toOllamaMessages([
        { role: "user", content: [
          { type: "image", source: { kind: "url", url: "https://example.com/cat.png" } },
        ]},
      ]),
    ).toThrow(ContentBlockUnsupportedError);
  });

  it("rejects audio blocks", () => {
    expect(() =>
      toOllamaMessages([
        { role: "user", content: [
          { type: "audio", source: { kind: "base64", mediaType: "audio/wav", data: "x" } },
        ]},
      ]),
    ).toThrow(ContentBlockUnsupportedError);
  });

  it("preserves system messages", () => {
    expect(
      toOllamaMessages([{ role: "system", content: "you are helpful" }]),
    ).toEqual([{ role: "system", content: "you are helpful" }]);
  });

  it("promotes assistant tool_use blocks into tool_calls with parsed arguments", () => {
    const out = toOllamaMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me search" },
          { type: "tool_use", id: "t1", name: "search", input: { query: "x" } },
        ],
      },
    ]);
    const m = out[0]!;
    expect(m.role).toBe("assistant");
    expect(m.content).toBe("let me search");
    expect(m.tool_calls).toEqual([
      { function: { name: "search", arguments: { query: "x" } } },
    ]);
  });

  it("wraps non-object tool_use input under {value} for Ollama compat", () => {
    const out = toOllamaMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "echo", input: "hello" }],
      },
    ]);
    const m = out[0]!;
    expect(m.tool_calls).toEqual([
      { function: { name: "echo", arguments: { value: "hello" } } },
    ]);
  });

  it("promotes user tool_result blocks to standalone tool messages", () => {
    expect(
      toOllamaMessages([
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "t1", content: "search returned 3" }],
        },
      ]),
    ).toEqual([
      { role: "tool", tool_call_id: "t1", content: "search returned 3" },
    ]);
  });
});

describe("fromOllamaAssistantMessage", () => {
  it("converts text response to a single text block", () => {
    expect(fromOllamaAssistantMessage({ content: "hello" })).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("synthesizes ids for tool_calls (Ollama does not return them)", () => {
    expect(
      fromOllamaAssistantMessage({
        content: "calling tools",
        tool_calls: [
          { function: { name: "search", arguments: { query: "x" } } },
          { function: { name: "compute", arguments: { a: 1 } } },
        ],
      }),
    ).toEqual([
      { type: "text", text: "calling tools" },
      { type: "tool_use", id: "ollama-tool-0", name: "search", input: { query: "x" } },
      { type: "tool_use", id: "ollama-tool-1", name: "compute", input: { a: 1 } },
    ]);
  });

  it("returns empty when content empty and no tool calls", () => {
    expect(fromOllamaAssistantMessage({})).toEqual([]);
  });
});

describe("extractAssistantText", () => {
  it("returns content directly", () => {
    expect(extractAssistantText({ content: "hi" })).toBe("hi");
  });

  it("returns empty string when content is missing", () => {
    expect(extractAssistantText({})).toBe("");
  });
});
