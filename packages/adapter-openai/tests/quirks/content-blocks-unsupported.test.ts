/**
 * Phase 8 — content-block-unsupported tests.
 *
 * Different adapters support different content-block types. When an
 * unsupported block is sent, the adapter must throw `ContentBlockUnsupportedError`
 * BEFORE making the SDK call (so users get a clear "this provider doesn't
 * support audio" message, not a confusing 400 from the API).
 *
 * OpenAI: audio URL not supported (only base64); some media types unsupported.
 * Anthropic: audio not supported at all.
 * Ollama: audio not supported, image URL not supported (file-only).
 *
 * (Anthropic and Ollama tests live in those packages' own quirks files when
 * they get added — this file covers the OpenAI-specific cases.)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { mockChatCompletionsCreate, resetMocks } from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { createOpenAIAdapter } from "../../src/index.js";
import { ContentBlockUnsupportedError } from "@llm-ports/core";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("Phase 8: content-block unsupported (OpenAI)", () => {
  it("audio URL throws ContentBlockUnsupportedError BEFORE the SDK call", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o-audio-preview", "live");

    let caught: unknown;
    try {
      await port.generateText({
        taskType: "t",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe the audio" },
              {
                type: "audio",
                source: { kind: "url", url: "https://example.com/clip.wav" },
              },
            ],
          },
        ],
        maxOutputTokens: 50,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContentBlockUnsupportedError);
    // SDK was never called — adapter rejected the input shape directly
    expect(mockChatCompletionsCreate).not.toHaveBeenCalled();
  });

  it("audio with unsupported media type throws ContentBlockUnsupportedError", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o-audio-preview", "live");

    let caught: unknown;
    try {
      await port.generateText({
        taskType: "t",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              {
                type: "audio",
                source: { kind: "base64", mediaType: "audio/flac", data: "AAA=" },
              },
            ],
          },
        ],
        maxOutputTokens: 50,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContentBlockUnsupportedError);
    expect(mockChatCompletionsCreate).not.toHaveBeenCalled();
  });
});
