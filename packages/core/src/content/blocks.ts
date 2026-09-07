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
  | DocumentBlock
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
      /**
       * Cost-vs-fidelity hint for the OpenAI vision pipeline.
       * - `"auto"` (default): provider decides based on image size.
       * - `"low"`: ~85 tokens regardless of image size; suitable for triage
       *   and broad classification.
       * - `"high"`: full per-tile analysis (~170 tokens per 512×512 tile);
       *   needed for OCR, fine-grained reasoning, small text.
       *
       * Honored by `@llm-ports/adapter-openai` (forwarded to OpenAI's
       * `image_url.detail`). Other adapters ignore the field — Anthropic and
       * Ollama don't have an equivalent knob.
       */
      detail?: "auto" | "low" | "high";
    }
  | {
      kind: "url";
      url: string;
      /** See base64 variant. Same semantics. */
      detail?: "auto" | "low" | "high";
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

/**
 * Document input (PDF and plain-text formats).
 *
 * A separate member rather than a widened `ImageSource`, following the
 * precedent `AudioBlock` set: a PDF is not an image, providers treat
 * documents as a distinct input kind, and a merged union would be
 * re-split inside every adapter anyway.
 *
 * Adapter support is uneven and that is handled by routing rather than
 * by failure. An adapter that cannot carry a document throws
 * `ContentBlockUnsupportedError`, which `defaultShouldFallback` treats as
 * walk-worthy, so a chain advances to a provider that can serve the call
 * without any consumer configuration.
 *
 * Added in `0.1.0-alpha.33`.
 */
export interface DocumentBlock {
  type: "document";
  source: DocumentSource;
  /**
   * Filename hint. OpenAI surfaces it to the model alongside the bytes and
   * benefits from a real name; other providers ignore it. When omitted,
   * adapters that require a filename synthesize one from the media type.
   */
  filename?: string;
}

/**
 * Document formats the content model can express.
 *
 * Deliberately a closed union rather than an open `string`: an adapter has
 * to map each one to a provider-specific shape, so a media type nothing can
 * carry is a runtime failure disguised as a type that compiles.
 */
export type DocumentMediaType =
  | "application/pdf"
  | "text/plain"
  | "text/markdown"
  | "text/csv";

export type DocumentSource =
  | {
      kind: "base64";
      mediaType: DocumentMediaType;
      /** Base64 payload only, with no `data:` prefix. Adapters add their own. */
      data: string;
    }
  | {
      kind: "url";
      url: string;
      /**
       * Optional for providers that sniff the type, required by those that
       * do not. Adapters needing it and not given it throw rather than guess,
       * because a wrong media type fails deep inside the provider.
       */
      mediaType?: DocumentMediaType;
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
