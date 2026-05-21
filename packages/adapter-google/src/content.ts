/**
 * Content translation between llm-ports ContentBlock[] and Gemini's
 * Content + Part shapes.
 *
 * Gemini's content model:
 *   Content = { role: "user" | "model" | "function", parts: Part[] }
 *   Part shapes (the ones we care about):
 *     - { text: string }
 *     - { inlineData: { mimeType: string, data: string (base64) } }
 *     - { fileData: { mimeType: string, fileUri: string } }
 *     - { functionCall: { name: string, args: object } }
 *     - { functionResponse: { name: string, response: object } }
 *
 * Notes:
 *   - System messages map to a top-level `systemInstruction` field on the
 *     request, NOT a Content with role: "system". `toGeminiRequest` handles
 *     this split.
 *   - The assistant role is `"model"` in Gemini's vocabulary.
 *   - Tool results are mapped to `functionResponse` parts.
 */

import {
  ContentBlockUnsupportedError,
  type ContentBlock,
  type LLMMessage,
  type MessageContent,
} from "@llm-ports/core";

const ADAPTER_NAME = "google";

// ─── Outgoing: ContentBlock[] → Gemini Part[] ────────────────────────

interface GeminiTextPart {
  text: string;
}
interface GeminiInlineDataPart {
  inlineData: { mimeType: string; data: string };
}
interface GeminiFileDataPart {
  fileData: { mimeType: string; fileUri: string };
}
interface GeminiFunctionCallPart {
  functionCall: { name: string; args: Record<string, unknown> };
}
interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: Record<string, unknown> };
}
export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFileDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

export interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

/** Translate a single ContentBlock to one or more GeminiParts. */
function toGeminiParts(block: ContentBlock): GeminiPart[] {
  switch (block.type) {
    case "text":
      return [{ text: block.text }];
    case "image": {
      if (block.source.kind === "base64") {
        return [
          {
            inlineData: {
              mimeType: block.source.mediaType,
              data: block.source.data,
            },
          },
        ];
      }
      // URL form
      return [
        {
          fileData: {
            // Gemini infers mimeType from URL extension when not provided.
            // We pass image/jpeg as a sane default; users wanting tighter
            // control should pass base64 with explicit mediaType.
            mimeType: "image/jpeg",
            fileUri: block.source.url,
          },
        },
      ];
    }
    case "audio": {
      if (block.source.kind === "base64") {
        return [
          {
            inlineData: {
              mimeType: block.source.mediaType,
              data: block.source.data,
            },
          },
        ];
      }
      throw new ContentBlockUnsupportedError(ADAPTER_NAME, "audio (url; Gemini accepts base64 or fileData with fileUri)");
    }
    case "tool_use": {
      // Gemini's tool-call shape has args as a plain object; we pass the input
      // through if it's already an object, else wrap.
      const args =
        block.input !== null && typeof block.input === "object"
          ? (block.input as Record<string, unknown>)
          : { value: block.input };
      return [{ functionCall: { name: block.name, args } }];
    }
    case "tool_result": {
      // Gemini's functionResponse expects a `response` object. If the
      // ContentBlock.tool_result.content is a string, wrap it.
      const response: Record<string, unknown> =
        typeof block.content === "string"
          ? { result: block.content }
          : { result: extractTextOnly(block.content) };
      return [
        {
          functionResponse: {
            // Gemini's API requires the tool name; we use toolUseId since
            // llm-ports' ToolResultBlock doesn't carry the name. Adapters
            // that need the name can plumb it through a separate channel.
            name: block.toolUseId,
            response,
          },
        },
      ];
    }
  }
}

function extractTextOnly(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Translate a MessageContent to Gemini Parts. */
export function toGeminiParts2(content: MessageContent): GeminiPart[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  return content.flatMap(toGeminiParts);
}

/**
 * Translate an array of LLMMessages into:
 *   - `systemInstruction`: the concatenated system messages (Gemini puts
 *     these at the top level of the request, not in `contents`).
 *   - `contents`: the user + assistant + tool messages, with roles mapped.
 */
export function toGeminiRequest(messages: LLMMessage[]): {
  systemInstruction?: string;
  contents: GeminiContent[];
} {
  let systemInstruction: string | undefined;
  const contents: GeminiContent[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string" ? msg.content : extractTextOnly(msg.content);
      systemInstruction = systemInstruction === undefined ? text : `${systemInstruction}\n\n${text}`;
      continue;
    }
    const role: GeminiContent["role"] =
      msg.role === "tool" ? "function" : msg.role === "assistant" ? "model" : "user";
    contents.push({
      role,
      parts: toGeminiParts2(msg.content),
    });
  }
  return systemInstruction !== undefined
    ? { systemInstruction, contents }
    : { contents };
}

// ─── Incoming: Gemini response → ContentBlock[] ──────────────────────

interface GeminiResponseCandidate {
  content?: {
    role?: string;
    parts?: GeminiPart[];
  };
  finishReason?: string;
}

/**
 * Extract the assistant text from a Gemini response. Used by generateText
 * and by the structured-output path before JSON parsing.
 */
export function extractGeminiText(parts: GeminiPart[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p): p is GeminiTextPart => "text" in p)
    .map((p) => p.text)
    .join("");
}

/**
 * Translate a Gemini response candidate's parts back into ContentBlock[].
 * Used by runAgent to reconstruct the model's tool_use blocks.
 */
export function fromGeminiCandidate(candidate: GeminiResponseCandidate): ContentBlock[] {
  const out: ContentBlock[] = [];
  const parts = candidate.content?.parts ?? [];
  for (const part of parts) {
    if ("text" in part && part.text.length > 0) {
      out.push({ type: "text", text: part.text });
    } else if ("functionCall" in part) {
      out.push({
        type: "tool_use",
        id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        input: part.functionCall.args,
      });
    } else if ("inlineData" in part) {
      // Inline (base64) image in assistant response. Decode if media type
      // is one we support, else drop (consistent with adapter-openai's
      // unknown-media-type behavior).
      const mt = part.inlineData.mimeType;
      if (
        mt === "image/jpeg" ||
        mt === "image/png" ||
        mt === "image/gif" ||
        mt === "image/webp"
      ) {
        out.push({
          type: "image",
          source: { kind: "base64", mediaType: mt, data: part.inlineData.data },
        });
      }
    }
    // fileData / functionResponse in assistant responses: not currently observed.
  }
  return out;
}
