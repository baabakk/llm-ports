/**
 * Convert llm-ports ContentBlock[] to/from Ollama's chat API format.
 *
 * Ollama message structure:
 *   - role: "system" | "user" | "assistant" | "tool"
 *   - content: string (Ollama doesn't have content blocks for chat text)
 *   - images?: string[] (base64 strings; image_url not supported)
 *   - tool_calls?: Array<{ function: { name, arguments: object } }>  (assistant)
 *   - tool_call_id?: string  (tool role)
 *
 * Notable differences:
 *   - All text is collapsed into a single `content` string per message.
 *   - Images are split out into `images` array as base64; URL images must be
 *     fetched by the caller (Ollama does not pull URLs).
 *   - Audio is NOT supported by Ollama chat.
 *   - Tool arguments are parsed objects, not JSON strings (unlike OpenAI).
 */

import {
  ContentBlockUnsupportedError,
  type ContentBlock,
  type LLMMessage,
  type ToolUseBlock,
} from "@llm-ports/core";

const ADAPTER_NAME = "ollama";

// ─── Ollama message shapes ───────────────────────────────────────────

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

// ─── Outgoing: LLMMessage[] → OllamaMessage[] ────────────────────────

export function toOllamaMessages(messages: LLMMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];

  for (const msg of messages) {
    const blocks = typeof msg.content === "string"
      ? [{ type: "text" as const, text: msg.content }]
      : msg.content;

    if (msg.role === "system") {
      out.push({ role: "system", content: textOnly(blocks) });
      continue;
    }

    if (msg.role === "assistant") {
      const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
      const message: OllamaMessage = {
        role: "assistant",
        content: textOnly(blocks),
      };
      if (toolUses.length > 0) {
        message.tool_calls = toolUses.map((tu) => ({
          function: {
            name: tu.name,
            arguments: typeof tu.input === "object" && tu.input !== null
              ? (tu.input as Record<string, unknown>)
              : { value: tu.input },
          },
        }));
      }
      out.push(message);
      continue;
    }

    // user or tool roles
    const toolResults = blocks.filter(
      (b): b is { type: "tool_result"; toolUseId: string; content: string | ContentBlock[]; isError?: boolean } =>
        b.type === "tool_result",
    );
    for (const tr of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: tr.toolUseId,
        content:
          typeof tr.content === "string"
            ? tr.content
            : textOnly(tr.content as ContentBlock[]),
      });
    }

    const userBlocks = blocks.filter((b) => b.type !== "tool_result");
    if (userBlocks.length > 0) {
      const images = collectImages(userBlocks);
      // Audio explicitly rejected
      for (const block of userBlocks) {
        if (block.type === "audio") {
          throw new ContentBlockUnsupportedError(ADAPTER_NAME, "audio");
        }
      }
      const userMessage: OllamaMessage = {
        role: "user",
        content: textOnly(userBlocks),
      };
      if (images.length > 0) {
        userMessage.images = images;
      }
      out.push(userMessage);
    }
  }

  return out;
}

function textOnly(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function collectImages(blocks: ContentBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type !== "image") continue;
    if (b.source.kind === "url") {
      throw new ContentBlockUnsupportedError(
        ADAPTER_NAME,
        "image (url; Ollama only accepts base64 — fetch the URL first)",
      );
    }
    out.push(b.source.data);
  }
  return out;
}

// ─── Incoming: Ollama assistant message → ContentBlock[] ─────────────

export function fromOllamaAssistantMessage(message: {
  content?: string;
  tool_calls?: OllamaToolCall[];
}): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    blocks.push({ type: "text", text: message.content });
  }
  if (message.tool_calls) {
    for (let i = 0; i < message.tool_calls.length; i++) {
      const tc = message.tool_calls[i]!;
      blocks.push({
        type: "tool_use",
        // Ollama doesn't return ids; synthesize stable ones based on position.
        id: `ollama-tool-${i}`,
        name: tc.function.name,
        input: tc.function.arguments,
      });
    }
  }
  return blocks;
}

export function extractAssistantText(message: { content?: string }): string {
  return message.content ?? "";
}
