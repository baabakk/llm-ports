/**
 * Helpers for normalizing between string and ContentBlock[] forms.
 *
 * Adapters use these to accept either input shape and emit the canonical
 * ContentBlock[] form that the rest of the system reasons about.
 */

import type { ContentBlock, MessageContent, TextBlock } from "./blocks.js";

/** True if the value is the string-sugar form of MessageContent. */
export function isStringContent(content: MessageContent): content is string {
  return typeof content === "string";
}

/** Convert any MessageContent to its canonical ContentBlock[] form. */
export function toBlocks(content: MessageContent): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

/**
 * Collapse a ContentBlock[] to a single string if and only if every block is text.
 * Returns null if the content includes non-text blocks (caller must keep array form).
 * Useful for adapters whose underlying SDK wants `content: string` for text-only messages.
 */
export function tryCollapseToText(blocks: ContentBlock[]): string | null {
  if (blocks.length === 0) return "";
  if (!blocks.every((b): b is TextBlock => b.type === "text")) return null;
  return blocks.map((b) => b.text).join("");
}

/** Concatenate all text content from a MessageContent, ignoring non-text blocks. */
export function extractText(content: MessageContent): string {
  return toBlocks(content)
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
