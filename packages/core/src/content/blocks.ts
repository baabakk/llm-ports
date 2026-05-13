/**
 * Multimodal content block types.
 *
 * Replaces the legacy `content: string` shape used by older LLM SDKs.
 * String content is syntactic sugar for `[{ type: "text", text: "..." }]`;
 * adapters accept either form and normalize internally.
 *
 * See docs/concepts/content-blocks for the full design rationale.
 */

/** Either a plain string (sugar) or an array of typed content blocks. */
export type MessageContent = string | ContentBlock[];

/** Discriminated union of all supported content block kinds. */
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | AudioBlock
  | ToolUseBlock
  | ToolResultBlock;

/** Plain text content. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** Image input (vision-capable models). */
export interface ImageBlock {
  type: "image";
  source: ImageSource;
}

export type ImageSource =
  | {
      kind: "base64";
      mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      data: string;
    }
  | {
      kind: "url";
      url: string;
    };

/** Audio input (audio-capable models). */
export interface AudioBlock {
  type: "audio";
  source: AudioSource;
}

export type AudioSource =
  | {
      kind: "base64";
      mediaType: "audio/wav" | "audio/mp3" | "audio/ogg";
      data: string;
    }
  | {
      kind: "url";
      url: string;
    };

/** Tool/function call request emitted by the model. */
export interface ToolUseBlock {
  type: "tool_use";
  /** Unique id for this tool call within the conversation. */
  id: string;
  /** Name of the tool the model wants to invoke. */
  name: string;
  /** Arguments the model is passing to the tool. Shape depends on the tool's input schema. */
  input: unknown;
}

/** Tool/function call result, supplied back to the model. */
export interface ToolResultBlock {
  type: "tool_result";
  /** Must match the `id` of the corresponding ToolUseBlock. */
  toolUseId: string;
  /** Result of executing the tool. May be a string, JSON, or further content blocks. */
  content: string | ContentBlock[];
  /** Set true if the tool execution failed; lets the model know to recover. */
  isError?: boolean;
}
