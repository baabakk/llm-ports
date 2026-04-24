/**
 * Convert llm-ports ContentBlock[] to/from Anthropic's content shape.
 *
 * Anthropic's Messages API content format is similar but not identical:
 *   - Text: { type: "text", text: string }
 *   - Image: { type: "image", source: { type: "base64", media_type, data } | { type: "url", url } }
 *   - Tool use: { type: "tool_use", id, name, input }
 *   - Tool result: { type: "tool_result", tool_use_id, content, is_error }
 *
 * Audio: NOT supported by Anthropic's chat API. Adapter throws ContentBlockUnsupportedError.
 */

import {
  ContentBlockUnsupportedError,
  type ContentBlock,
  type LLMMessage,
  type MessageContent,
  type MessageRole,
} from "@llm-ports/core";

const ADAPTER_NAME = "anthropic";

// ─── Anthropic-side type shapes (just enough for translation) ────────

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

// ─── Outgoing: ContentBlock[] → Anthropic ─────────────────────────────

export function toAnthropicContent(content: MessageContent): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  return content.map(toAnthropicBlock);
}

function toAnthropicBlock(block: ContentBlock): AnthropicContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source:
          block.source.kind === "base64"
            ? { type: "base64", media_type: block.source.mediaType, data: block.source.data }
            : { type: "url", url: block.source.url },
      };
    case "audio":
      throw new ContentBlockUnsupportedError(ADAPTER_NAME, "audio");
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content:
          typeof block.content === "string"
            ? block.content
            : (block.content.map(toAnthropicBlock) as AnthropicContentBlock[]),
        ...(block.isError !== undefined ? { is_error: block.isError } : {}),
      };
  }
}

/** Filter system messages out (Anthropic uses a top-level `system` parameter). */
export function toAnthropicMessages(messages: LLMMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  let system: string | undefined;
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : extractTextOnly(msg.content);
      system = system === undefined ? text : `${system}\n\n${text}`;
      continue;
    }
    out.push({
      role: msg.role === "tool" ? "user" : (msg.role as "user" | "assistant"),
      content: toAnthropicContent(msg.content),
    });
  }
  return system !== undefined ? { system, messages: out } : { messages: out };
}

function extractTextOnly(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ─── Incoming: Anthropic → ContentBlock[] ─────────────────────────────

export function fromAnthropicContent(content: string | AnthropicContentBlock[]): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(fromAnthropicBlock);
}

function fromAnthropicBlock(block: AnthropicContentBlock): ContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source:
          block.source.type === "base64"
            ? {
                kind: "base64",
                mediaType: block.source.media_type as
                  | "image/jpeg"
                  | "image/png"
                  | "image/gif"
                  | "image/webp",
                data: block.source.data,
              }
            : { kind: "url", url: block.source.url },
      };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: block.tool_use_id,
        content:
          typeof block.content === "string"
            ? block.content
            : (block.content.map(fromAnthropicBlock) as ContentBlock[]),
        ...(block.is_error !== undefined ? { isError: block.is_error } : {}),
      };
  }
}

/** Helper for adapters that just want the assistant's text response. */
export function extractAssistantText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// Re-export the role type for internal use.
export type { MessageRole };
