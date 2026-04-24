import { describe, expect, it } from "vitest";
import {
  extractText,
  isStringContent,
  toBlocks,
  tryCollapseToText,
  type ContentBlock,
} from "../src/index.js";

describe("content normalization", () => {
  it("isStringContent identifies the string sugar form", () => {
    expect(isStringContent("hello")).toBe(true);
    expect(isStringContent([{ type: "text", text: "hello" }])).toBe(false);
  });

  it("toBlocks converts string sugar to a single TextBlock", () => {
    expect(toBlocks("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("toBlocks passes through ContentBlock arrays unchanged", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "describe the image" },
      { type: "image", source: { kind: "url", url: "https://example.com/cat.jpg" } },
    ];
    expect(toBlocks(blocks)).toBe(blocks);
  });

  it("tryCollapseToText joins text-only blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ];
    expect(tryCollapseToText(blocks)).toBe("hello world");
  });

  it("tryCollapseToText returns null when non-text blocks are present", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "look at this" },
      { type: "image", source: { kind: "url", url: "https://example.com/cat.jpg" } },
    ];
    expect(tryCollapseToText(blocks)).toBeNull();
  });

  it("extractText flattens text content and ignores non-text blocks", () => {
    expect(extractText("plain string")).toBe("plain string");
    expect(
      extractText([
        { type: "text", text: "describe " },
        { type: "image", source: { kind: "url", url: "https://example.com/cat.jpg" } },
        { type: "text", text: "this image" },
      ]),
    ).toBe("describe this image");
  });
});
