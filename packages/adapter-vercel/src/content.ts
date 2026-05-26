/**
 * Content translation between llm-ports ContentBlock[] and Vercel AI SDK's
 * multi-part message shape (CoreUserMessage / CoreAssistantMessage parts).
 *
 * Vercel's parts model:
 *   { type: "text", text: string }
 *   { type: "image", image: string | URL | Uint8Array | Buffer }
 *   { type: "file", data: string | Uint8Array, mimeType: string }
 *   { type: "tool-call", toolCallId, toolName, args }
 *   { type: "tool-result", toolCallId, toolName, result, isError? }
 *
 * Image translation:
 *   - base64 → data URI string `data:<mt>;base64,<data>` (Vercel's documented form)
 *   - URL → the URL string verbatim (Vercel passes through; underlying SDK fetches)
 *
 * Audio translation:
 *   - base64 → `{ type: "file", data: <base64>, mimeType: <audio/*> }`
 *   - URL → throws (Vercel's image-only URL passthrough doesn't apply to audio)
 *
 * Tool-use / tool-result translation is handled at the runAgent message-level
 * mapping in adapter.ts, not here — Vercel expects standalone messages with
 * role: "tool" rather than inline content parts.
 *
 * Shipped in 0.1.0-alpha.8 (replaces the alpha.5 `stringifyContentBlocks`
 * placeholder-string degradation).
 */

import {
  ContentBlockUnsupportedError,
  type ContentBlock,
  type MessageContent,
} from "@llm-ports/core";

const ADAPTER_NAME = "vercel";

/**
 * Vercel's part shapes (subset we use). We type-erase to `unknown` at call
 * sites because Vercel's TS union changes based on role; passing a wide
 * union through `prompt` / `messages.content` works at runtime.
 */
export type VercelPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string }
  | { type: "file"; data: string; mimeType: string };

/**
 * Translate a llm-ports `MessageContent` to a Vercel parts array. When the
 * content is a plain string, returns it as a single text part (allowing
 * Vercel to do the simpler string-prompt path internally).
 */
export function toVercelParts(content: MessageContent): VercelPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.flatMap(toVercelPart);
}

function toVercelPart(block: ContentBlock): VercelPart[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text }];
    case "image": {
      if (block.source.kind === "base64") {
        // Vercel accepts base64 either as a data URI string or as raw bytes.
        // Data URI matches the OpenAI compat convention and round-trips through
        // every @ai-sdk/* provider we care about (Vercel translates per-provider).
        return [
          {
            type: "image",
            image: `data:${block.source.mediaType};base64,${block.source.data}`,
          },
        ];
      }
      // URL form: pass through verbatim. Vercel + underlying SDK handle fetch.
      return [{ type: "image", image: block.source.url }];
    }
    case "audio": {
      if (block.source.kind === "base64") {
        return [
          {
            type: "file",
            data: block.source.data,
            mimeType: block.source.mediaType,
          },
        ];
      }
      throw new ContentBlockUnsupportedError(
        ADAPTER_NAME,
        "audio (url; Vercel routes audio as file-data; pass base64 + mediaType instead)",
      );
    }
    case "tool_use":
    case "tool_result":
      // These don't live as inline content parts in Vercel's model — they
      // become top-level messages (role: "tool" for results). The runAgent
      // message-level mapping handles this. If we see them inline here,
      // it's a caller mistake (or a provider response with an unusual shape).
      throw new Error(
        `${block.type} content blocks must be promoted to top-level messages with role: "tool"; ` +
          `cannot inline as a Vercel content part.`,
      );
  }
}

/**
 * Whether the content has any non-text blocks — useful for choosing between
 * Vercel's simpler `prompt: string` path vs the richer `messages` path with
 * structured parts.
 */
export function hasMultimodalContent(content: MessageContent): boolean {
  if (typeof content === "string") return false;
  return content.some((b) => b.type !== "text");
}
