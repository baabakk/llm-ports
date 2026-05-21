/**
 * Tests for the adapter-boundary image validator.
 *
 * Covers gap 4 (ImageTooLargeError) and gap 6 (InvalidImageUrlError) from
 * the alpha.4 image-pipeline audit.
 */

import { describe, expect, it } from "vitest";
import { ImageTooLargeError, InvalidImageUrlError } from "../src/errors.js";
import {
  validateImageBlocks,
  validateImageUrl,
} from "../src/utils/validate-image.js";
import type { ContentBlock } from "../src/content/blocks.js";

describe("validateImageBlocks: size validation (gap 4 / issue #19)", () => {
  // 4 chars of base64 → 3 bytes
  const onePixel = "iVBO"; // ~3 bytes
  const bigPayload = "x".repeat(20 * 1024 * 1024); // ~15MB base64 → ~11MB raw

  it("passes when base64 image is under the limit", () => {
    const blocks: ContentBlock[] = [
      { type: "image", source: { kind: "base64", mediaType: "image/png", data: onePixel } },
    ];
    expect(() =>
      validateImageBlocks(blocks, { alias: "test", limitBytes: 1024 }),
    ).not.toThrow();
  });

  it("throws ImageTooLargeError when base64 image exceeds the limit", () => {
    const blocks: ContentBlock[] = [
      { type: "image", source: { kind: "base64", mediaType: "image/png", data: bigPayload } },
    ];
    expect(() =>
      validateImageBlocks(blocks, { alias: "test", limitBytes: 5 * 1024 * 1024 }),
    ).toThrow(ImageTooLargeError);
  });

  it("error carries alias + imageIndex + byteSize + limitBytes", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "describe" },
      { type: "image", source: { kind: "base64", mediaType: "image/png", data: bigPayload } },
    ];
    try {
      validateImageBlocks(blocks, { alias: "anthropic", limitBytes: 5 * 1024 * 1024 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ImageTooLargeError);
      const e = err as ImageTooLargeError;
      expect(e.alias).toBe("anthropic");
      expect(e.imageIndex).toBe(1);
      expect(e.limitBytes).toBe(5 * 1024 * 1024);
      expect(e.byteSize).toBeGreaterThan(e.limitBytes);
    }
  });

  it("skips size validation when limitBytes is undefined", () => {
    const blocks: ContentBlock[] = [
      { type: "image", source: { kind: "base64", mediaType: "image/png", data: bigPayload } },
    ];
    expect(() => validateImageBlocks(blocks, { alias: "ollama" })).not.toThrow();
  });

  it("recursively validates images inside tool_result blocks", () => {
    const blocks: ContentBlock[] = [
      {
        type: "tool_result",
        toolUseId: "abc",
        content: [
          { type: "text", text: "screenshot:" },
          { type: "image", source: { kind: "base64", mediaType: "image/png", data: bigPayload } },
        ],
      },
    ];
    expect(() =>
      validateImageBlocks(blocks, { alias: "anthropic", limitBytes: 5 * 1024 * 1024 }),
    ).toThrow(ImageTooLargeError);
  });
});

describe("validateImageBlocks: URL validation (gap 6 / issue #21)", () => {
  it("accepts https URLs", () => {
    const blocks: ContentBlock[] = [
      { type: "image", source: { kind: "url", url: "https://example.com/cat.png" } },
    ];
    expect(() => validateImageBlocks(blocks, { alias: "test" })).not.toThrow();
  });

  it("accepts http URLs", () => {
    const blocks: ContentBlock[] = [
      { type: "image", source: { kind: "url", url: "http://example.com/cat.png" } },
    ];
    expect(() => validateImageBlocks(blocks, { alias: "test" })).not.toThrow();
  });

  it("rejects data: URIs in url form", () => {
    const blocks: ContentBlock[] = [
      {
        type: "image",
        source: { kind: "url", url: "data:image/png;base64,iVBO" },
      },
    ];
    expect(() => validateImageBlocks(blocks, { alias: "test" })).toThrow(
      InvalidImageUrlError,
    );
  });

  it("rejects file:// URLs by default", () => {
    const blocks: ContentBlock[] = [
      { type: "image", source: { kind: "url", url: "file:///tmp/cat.png" } },
    ];
    expect(() => validateImageBlocks(blocks, { alias: "test" })).toThrow(
      InvalidImageUrlError,
    );
  });

  it("allows file:// URLs when allowFileUrl=true", () => {
    const blocks: ContentBlock[] = [
      { type: "image", source: { kind: "url", url: "file:///tmp/cat.png" } },
    ];
    expect(() =>
      validateImageBlocks(blocks, { alias: "test", allowFileUrl: true }),
    ).not.toThrow();
  });

  it("rejects URLs without scheme", () => {
    const blocks: ContentBlock[] = [
      { type: "image", source: { kind: "url", url: "cat.png" } },
    ];
    expect(() => validateImageBlocks(blocks, { alias: "test" })).toThrow(
      InvalidImageUrlError,
    );
  });

  it("rejects empty URLs", () => {
    const blocks: ContentBlock[] = [
      { type: "image", source: { kind: "url", url: "" } },
    ];
    expect(() => validateImageBlocks(blocks, { alias: "test" })).toThrow(
      InvalidImageUrlError,
    );
  });

  it("rejects other schemes (ftp:, javascript:, etc.)", () => {
    expect(() => validateImageUrl("ftp://example.com/x", "test", false)).toThrow(
      InvalidImageUrlError,
    );
    expect(() => validateImageUrl("javascript:alert(1)", "test", false)).toThrow(
      InvalidImageUrlError,
    );
  });

  it("error carries url + reason", () => {
    try {
      validateImageUrl("file:///tmp/x.png", "anthropic", false);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidImageUrlError);
      const e = err as InvalidImageUrlError;
      expect(e.alias).toBe("anthropic");
      expect(e.url).toBe("file:///tmp/x.png");
      expect(e.reason).toMatch(/file:\/\//);
    }
  });
});

describe("validateImageBlocks: skips non-image blocks", () => {
  it("ignores text blocks", () => {
    const blocks: ContentBlock[] = [{ type: "text", text: "hello" }];
    expect(() => validateImageBlocks(blocks, { alias: "test" })).not.toThrow();
  });

  it("ignores audio blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "audio", source: { kind: "base64", mediaType: "audio/wav", data: "x" } },
    ];
    expect(() => validateImageBlocks(blocks, { alias: "test" })).not.toThrow();
  });

  it("ignores tool_use blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", id: "abc", name: "search", input: {} },
    ];
    expect(() => validateImageBlocks(blocks, { alias: "test" })).not.toThrow();
  });
});
