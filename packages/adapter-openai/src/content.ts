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
      // detail is optional on both ImageSource variants; forward only when set
      // so we don't override OpenAI's per-account default ("auto") on calls
      // that didn't request a specific mode.
      const image_url: { url: string; detail?: "auto" | "low" | "high" } = { url };
      if (block.source.detail !== undefined) {
        image_url.detail = block.source.detail;
      }
      return { type: "image_url", image_url };
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

// ─── Harmony tool-call extraction (alpha.23+) ────────────────────────
//
// gpt-oss-* models from OpenAI use the "harmony" output format where a tool
// call is encoded as a structured channel:
//
//   <|channel|>commentary to=functions.write_file<|constrain|>json<|message|>
//   {"path":"x.ts","content":"..."}
//
// Some providers (Cerebras, Groq) translate harmony channels into the
// standard `tool_calls` array on the response before sending it back. Others
// (DeepInfra at the time of writing) pass the raw harmony channel through as
// `message.reasoning_content`, leaving `tool_calls` empty. Without
// extraction, runAgent terminates the agentic loop on what looks like an
// empty assistant turn.
//
// This parser handles the "raw harmony" case by extracting one or more
// tool calls from a reasoning_content string. It returns null in three cases:
//   - reasoning_content is empty or missing
//   - reasoning_content does not contain any parseable harmony tool call
//     (just chain-of-thought prose, or a bare JSON fragment with no tool
//     name — the latter is the case the alpha.23 zero-tool-call rescue
//     handles via a corrective retry instead)
//   - the matched JSON arguments are unparseable
//
// Returning null lets the caller fall through to the zero-tool-call rescue
// path (ASK 2 in alpha.23), so this parser is the surgical fast path: when
// the model emitted a complete tool call but in the wrong channel, hoist
// it; otherwise stay out of the way.
//
// See llm-ports#46 / discussion #50, and ADW's 2026-06-19 diagnostic
// transcript for the empirical evidence motivating this addition.

/**
 * Best-effort parse of one or more tool calls out of a harmony-formatted
 * reasoning_content string. Returns null when no parseable harmony tool
 * call is found (so the caller can fall through to corrective rescue).
 */
export function parseHarmonyToolCalls(
  reasoningContent: string | null | undefined,
): OpenAIToolCall[] | null {
  if (!reasoningContent || reasoningContent.length === 0) return null;

  // Match: <|channel|>commentary|tool ... to=functions.NAME [<|constrain|>json] <|message|>{...JSON...}
  //
  // The non-greedy `[\s\S]*?` between the tool name and `<|message|>` allows
  // for an optional `<|constrain|>json` segment per the harmony spec (some
  // providers pass it through, others don't). The lookahead at the end
  // bounds the JSON before the next harmony marker or end-of-string. Tool
  // name is restricted to identifier characters to avoid false matches
  // inside JSON bodies.
  const HARMONY_TOOL_PATTERN =
    /<\|channel\|>(?:commentary|tool)[\s\S]*?to=functions\.([A-Za-z_][A-Za-z0-9_]*)[\s\S]*?<\|message\|>(\{[\s\S]*?\})(?=<\||$)/g;

  const calls: OpenAIToolCall[] = [];
  let match: RegExpExecArray | null;
  while ((match = HARMONY_TOOL_PATTERN.exec(reasoningContent)) !== null) {
    const toolName = match[1]!;
    const argsJson = match[2]!;
    // Validate the JSON before synthesizing the tool_call so we don't pass
    // along garbage that would fail downstream when the consumer's tool
    // executor tries to parse it.
    try {
      JSON.parse(argsJson);
    } catch {
      continue;
    }
    calls.push({
      id: `harmony-${Math.random().toString(36).slice(2, 14)}`,
      type: "function",
      function: { name: toolName, arguments: argsJson },
    });
  }

  return calls.length > 0 ? calls : null;
}

// ─── Incoming: OpenAI assistant message → ContentBlock[] ─────────────

/**
 * Convert an OpenAI assistant response (`message.content` + `message.tool_calls`)
 * back into a llm-ports ContentBlock[].
 *
 * Alpha.23+: accepts an optional `reasoning_content` field. When `tool_calls`
 * is empty/missing and `reasoning_content` contains harmony-formatted tool
 * calls (DeepInfra-style gpt-oss serving), the harmony tool calls are
 * extracted and merged into the result. See `parseHarmonyToolCalls`.
 */
export function fromOpenAIAssistantMessage(message: {
  content: string | null | OpenAIContentPart[];
  tool_calls?: OpenAIToolCall[];
  reasoning_content?: string | null;
}): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    blocks.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "image_url") {
        // Decode assistant-emitted image_url back into an ImageBlock so
        // callers don't silently lose data when a vision model emits an
        // image in its response. Detects data: URIs vs http(s) and routes
        // them to the correct ImageSource kind. (Gap 5 / issue #20.)
        const decoded = decodeAssistantImageUrl(part.image_url.url);
        if (decoded) blocks.push(decoded);
      }
      // input_audio: still rare in assistant responses; OpenAI exposes
      // output audio via a separate `audio` field on the message, not as
      // an `input_audio` content part. Skip until a real use case shows.
    }
  }
  // Alpha.23+: when standard tool_calls is empty/missing AND a non-empty
  // reasoning_content is present, try the harmony extraction path. This
  // recovers tool calls emitted by DeepInfra-served gpt-oss into the
  // reasoning channel rather than the standard tool_calls array. Falls
  // through silently when no harmony tool calls are parseable, leaving
  // the zero-tool-call rescue (ASK 2) to handle the prose-only case.
  const standardToolCalls = message.tool_calls && message.tool_calls.length > 0
    ? message.tool_calls
    : (parseHarmonyToolCalls(message.reasoning_content) ?? undefined);

  if (standardToolCalls) {
    for (const tc of standardToolCalls) {
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

/**
 * Decode an assistant-emitted `image_url.url` back into an llm-ports
 * `ImageBlock`. Returns null when the URL is malformed.
 *
 * Routing rule:
 *   - `data:<mediaType>;base64,<payload>` → `{ kind: "base64", mediaType, data }`
 *   - `http(s)://...`                       → `{ kind: "url", url }`
 *   - Anything else (file://, missing scheme, etc.) → null
 *
 * The mediaType union is constrained to the four formats `ImageBlock`
 * supports. If a model emits an exotic type (svg+xml, bmp, tiff), the
 * decoder returns null and the assistant message is treated as if the
 * image part wasn't there. That's preferred to a structurally-invalid
 * ImageBlock that downstream code would crash on.
 */
function decodeAssistantImageUrl(url: string): ContentBlock | null {
  if (typeof url !== "string" || url.length === 0) return null;

  // data: URI form
  const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
  if (dataMatch && dataMatch[1] && dataMatch[2]) {
    const mediaType = dataMatch[1];
    const data = dataMatch[2];
    if (
      mediaType === "image/jpeg" ||
      mediaType === "image/png" ||
      mediaType === "image/gif" ||
      mediaType === "image/webp"
    ) {
      return { type: "image", source: { kind: "base64", mediaType, data } };
    }
    return null;
  }

  // URL form
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return { type: "image", source: { kind: "url", url } };
  }

  return null;
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
