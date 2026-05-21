/**
 * Adapter-boundary validation for `ImageBlock` content.
 *
 * Catches two classes of errors before the SDK call so the caller sees a
 * typed error instead of an opaque provider 4xx wrapped as
 * `ProviderUnavailableError`:
 *
 *   - **Size**: base64-encoded image exceeds the provider's documented limit.
 *     Throws `ImageTooLargeError` carrying the byte size + the limit.
 *
 *   - **URL shape**: URL-form image with a `file://`, `data:`, or
 *     no-scheme URL. Throws `InvalidImageUrlError` carrying the offending
 *     URL + reason.
 *
 * Each adapter calls `validateImageBlocks(blocks, opts)` on every outgoing
 * `ContentBlock[]` before constructing the provider-native payload.
 *
 * Limits and behavior are intentionally adapter-tunable: Anthropic ships
 * with a 5MB default, OpenAI with 20MB, Ollama with no enforced limit (model-
 * dependent; caller responsibility). Each adapter wires its own default
 * through `validateImageBlocks({ limitBytes })`.
 */

import type { ContentBlock } from "../content/blocks.js";
import { ImageTooLargeError, InvalidImageUrlError } from "../errors.js";

export interface ValidateImageOptions {
  /** Provider alias for error messages. */
  alias: string;
  /**
   * Maximum bytes per base64 image. If undefined, size validation is skipped
   * (use this for Ollama where the limit is model-dependent).
   */
  limitBytes?: number;
  /**
   * Whether to allow `file://` URLs. Default false — file URLs almost always
   * indicate a caller mistake (the file is on the caller's machine; the
   * provider can't reach it).
   */
  allowFileUrl?: boolean;
}

/**
 * Validate every ImageBlock in a ContentBlock array. Throws on the first
 * violation with a typed error.
 *
 * Non-image blocks are skipped. Recursively descends into ToolResult blocks
 * since those can carry nested ImageBlocks.
 */
export function validateImageBlocks(
  blocks: ReadonlyArray<ContentBlock>,
  opts: ValidateImageOptions,
): void {
  blocks.forEach((block, index) => validateBlock(block, index, opts));
}

function validateBlock(
  block: ContentBlock,
  index: number,
  opts: ValidateImageOptions,
): void {
  if (block.type === "tool_result") {
    if (typeof block.content !== "string") {
      validateImageBlocks(block.content, opts);
    }
    return;
  }
  if (block.type !== "image") return;

  // URL-form validation
  if (block.source.kind === "url") {
    validateImageUrl(block.source.url, opts.alias, opts.allowFileUrl === true);
    return;
  }

  // base64-form size validation
  if (opts.limitBytes !== undefined) {
    const byteSize = base64ByteSize(block.source.data);
    if (byteSize > opts.limitBytes) {
      throw new ImageTooLargeError(opts.alias, index, byteSize, opts.limitBytes);
    }
  }
}

/**
 * Validate an image URL's shape. Rejects `file://`, `data:`, and
 * no-scheme strings. Accepts `http://` and `https://`. Use `allowFileUrl`
 * to override (test environments may want it).
 */
export function validateImageUrl(
  url: string,
  alias: string,
  allowFileUrl: boolean,
): void {
  const trimmed = url.trim();

  if (trimmed.length === 0) {
    throw new InvalidImageUrlError(alias, url, "URL is empty");
  }

  if (trimmed.startsWith("data:")) {
    throw new InvalidImageUrlError(
      alias,
      url,
      "data: URI passed as URL; use kind: 'base64' with the raw data + mediaType instead",
    );
  }

  if (trimmed.startsWith("file://")) {
    if (!allowFileUrl) {
      throw new InvalidImageUrlError(
        alias,
        url,
        "file:// URLs are not fetchable by remote providers; pass the file contents as kind: 'base64' instead",
      );
    }
    return;
  }

  // Must have an http(s) scheme. Anything else (relative paths, ftp://, etc.)
  // is almost certainly a caller mistake.
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new InvalidImageUrlError(
      alias,
      url,
      "URL must start with http:// or https://",
    );
  }
}

/**
 * Compute the byte size of a base64-encoded payload. Base64 encodes every 3
 * bytes as 4 chars, padded to a multiple of 4 with `=`. So decoded byte size
 * = ceil(len * 3 / 4) - padding. We approximate as `(len * 3) / 4` which is
 * accurate to within 2 bytes; close enough for provider-limit comparison.
 */
function base64ByteSize(data: string): number {
  return Math.floor((data.length * 3) / 4);
}
