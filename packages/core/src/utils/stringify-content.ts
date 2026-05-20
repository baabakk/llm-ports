/**
 * Convert a `MessageContent` (either a plain string or an array of content
 * blocks) into a single string. Used by adapter implementations when they
 * need to log a prompt, fall back from rich content to plain text, or
 * inject a string-shaped prompt into a provider that doesn't accept block
 * arrays for a given message role.
 *
 * Non-text blocks (image, audio, tool_use, tool_result) are rendered as
 * `[block-type ...]` placeholders. This preserves the structural information
 * without producing garbage if the caller later logs the string.
 *
 * Hoisted from per-adapter copies in alpha.3. Every adapter that previously
 * wrote its own `stringifyPrompt(content)` now imports this.
 */

import type { MessageContent } from "../content/blocks.js";

/**
 * Render `MessageContent` as a string. Text blocks contribute their text
 * verbatim; other block types contribute a `[type ...]` placeholder.
 */
export function stringifyContentBlocks(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[image content]";
      if (block.type === "audio") return "[audio content]";
      if (block.type === "tool_use") return `[tool_use ${block.name}]`;
      if (block.type === "tool_result") return `[tool_result for ${block.toolUseId}]`;
      return "[non-text block]";
    })
    .join("\n");
}
