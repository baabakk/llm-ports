/**
 * Convert llm-ports ContentBlock[] to/from OpenAI's chat completions format.
 *
 * OpenAI message structure:
 *   - User/system: content can be `string` or array of typed parts
 *     - { type: "text", text: string }
 *     - { type: "image_url", image_url: { url: string, detail?: "auto"|"low"|"high" } }
 *     - { type: "input_audio", input_audio: { data, format: "wav"|"mp3" } }
 *   - Assistant: content + tool_calls separately
 *     - tool_calls: [{ id, type: "function", function: { name, arguments: JSON-string } }]
 *   - Tool: { role: "tool", tool_call_id, content }
 *
 * Notable differences from Anthropic:
 *   - Tool calls live in `tool_calls` field, not as content blocks
 *   - Tool results are separate messages (role: "tool"), not blocks
 *   - Image URLs use "image_url" wrapper; base64 encoded as data URI
 */

import {
  ContentBlockUnsupportedError,
  type ContentBlock,
  type LLMMessage,
  type MessageContent,
  type ToolUseBlock,
} from "@llm-ports/core";

const ADAPTER_NAME = "openai";

// ─── OpenAI message shapes (just enough for translation) ─────────────

export type OpenAIRole = "system" | "user" | "assistant" | "tool";

export interface OpenAITextPart {
  type: "text";
  text: string;
}
export interface OpenAIImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}
export interface OpenAIAudioPart {
  type: "input_audio";
  input_audio: { data: string; format: "wav" | "mp3" };
}
export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart | OpenAIAudioPart;

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAISystemMessage {
  role: "system";
  content: string;
}
export interface OpenAIUserMessage {
  role: "user";
  content: string | OpenAIContentPart[];
}
export interface OpenAIAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}
export interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}
export type OpenAIMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage;

// ─── Outgoing: ContentBlock[] / LLMMessage[] → OpenAI ────────────────

/**
 * Convert MessageContent (string or ContentBlock[]) to OpenAI's content shape.
 * For user messages: returns string when content is text-only, otherwise the
 * typed parts array. Throws on tool_use / tool_result (those become separate
 * messages via toOpenAIMessages).
 */
export function toOpenAIUserContent(content: MessageContent): string | OpenAIContentPart[] {
  if (typeof content === "string") return content;
  // If every block is text, collapse to a string for simpler payloads
  if (content.every((b) => b.type === "text")) {
    return content.map((b) => (b as { type: "text"; text: string }).text).join("");
  }
  return content.map((block) => toOpenAIContentPart(block));
}

function toOpenAIContentPart(block: ContentBlock): OpenAIContentPart {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image": {
      const url =
        block.source.kind === "url"
          ? block.source.url
          : `data:${block.source.mediaType};base64,${block.source.data}`;
      return { type: "image_url", image_url: { url } };
    }
    case "audio": {
      // OpenAI only accepts base64-encoded audio; URL audio is not supported
      if (block.source.kind === "url") {
        throw new ContentBlockUnsupportedError(ADAPTER_NAME, "audio (url; OpenAI requires base64)");
      }
      const format = mapAudioFormat(block.source.mediaType);
      return { type: "input_audio", input_audio: { data: block.source.data, format } };
    }
    case "tool_use":
    case "tool_result":
      throw new Error(
        `tool_use and tool_result blocks must be promoted to top-level messages; use toOpenAIMessages.`,
      );
  }
}

function mapAudioFormat(mediaType: string): "wav" | "mp3" {
  if (mediaType === "audio/wav") return "wav";
  if (mediaType === "audio/mp3") return "mp3";
  // Ogg not supported by OpenAI today
  throw new ContentBlockUnsupportedError(ADAPTER_NAME, `audio format "${mediaType}"`);
}

/**
 * Translate a llm-ports message list to OpenAI messages, promoting tool_use
 * blocks in assistant messages to `tool_calls` and tool_result blocks in
 * user/tool messages to standalone `role: "tool"` messages.
 */
export function toOpenAIMessages(messages: LLMMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : extractTextFromBlocks(msg.content);
      out.push({ role: "system", content: text });
      continue;
    }

    if (msg.role === "assistant") {
      const blocks = typeof msg.content === "string" ? [{ type: "text" as const, text: msg.content }] : msg.content;
      const textParts = blocks
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
      const message: OpenAIAssistantMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts : null,
      };
      if (toolUses.length > 0) {
        message.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: {
            name: tu.name,
            arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input),
          },
        }));
      }
      out.push(message);
      continue;
    }

    // user or tool roles
    const blocks = typeof msg.content === "string" ? [{ type: "text" as const, text: msg.content }] : msg.content;

    // Promote any tool_result blocks to standalone tool messages
    const toolResults = blocks.filter(
      (b): b is { type: "tool_result"; toolUseId: string; content: string | ContentBlock[]; isError?: boolean } =>
        b.type === "tool_result",
    );
    for (const tr of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: tr.toolUseId,
        content:
          typeof tr.content === "string" ? tr.content : extractTextFromBlocks(tr.content as ContentBlock[]),
      });
    }

    // Anything left becomes a user message
    const userBlocks = blocks.filter((b) => b.type !== "tool_result");
    if (userBlocks.length > 0) {
      out.push({
        role: "user",
        content: toOpenAIUserContent(userBlocks),
      });
    }
  }

  return out;
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ─── Incoming: OpenAI assistant message → ContentBlock[] ─────────────

/**
 * Convert an OpenAI assistant response (`message.content` + `message.tool_calls`)
 * back into a llm-ports ContentBlock[].
 */
export function fromOpenAIAssistantMessage(message: {
  content: string | null | OpenAIContentPart[];
  tool_calls?: OpenAIToolCall[];
}): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    blocks.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text });
      }
      // image_url and input_audio in assistant responses are very rare; ignore
    }
  }
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(tc.function.arguments);
      } catch {
        parsed = tc.function.arguments;
      }
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parsed,
      });
    }
  }
  return blocks;
}

/** Best-effort: extract just the assistant's text response. */
export function extractAssistantText(message: {
  content: string | null | OpenAIContentPart[];
}): string {
  if (typeof message.content === "string") return message.content;
  if (message.content === null) return "";
  return message.content
    .filter((p): p is OpenAITextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}
