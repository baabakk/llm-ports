/**
 * Mock the @google/genai SDK so tests can control responses without HTTP.
 */

import { vi, type Mock } from "vitest";

export const mockGenerateContent: Mock = vi.fn();
export const mockGenerateContentStream: Mock = vi.fn();

vi.mock("@google/genai", () => {
  const ctor = vi.fn().mockImplementation(() => ({
    models: {
      generateContent: mockGenerateContent,
      generateContentStream: mockGenerateContentStream,
    },
  }));
  return { GoogleGenAI: ctor };
});

export function resetMocks(): void {
  mockGenerateContent.mockReset();
  mockGenerateContentStream.mockReset();
}

// ─── Response builders ────────────────────────────────────────────────

export interface MockedGeminiResponse {
  text?: string;
  promptTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  modelId?: string;
  finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION";
  functionCall?: { name: string; args: Record<string, unknown> };
}

export function buildGeminiResponse(spec: MockedGeminiResponse): unknown {
  const parts: unknown[] = [];
  if (spec.text !== undefined) parts.push({ text: spec.text });
  if (spec.functionCall !== undefined) {
    parts.push({ functionCall: spec.functionCall });
  }
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts,
        },
        finishReason: spec.finishReason ?? "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: spec.promptTokens,
      candidatesTokenCount: spec.outputTokens,
      totalTokenCount: spec.promptTokens + spec.outputTokens,
      ...(spec.cachedTokens !== undefined
        ? { cachedContentTokenCount: spec.cachedTokens }
        : {}),
    },
    modelVersion: spec.modelId ?? "gemini-2.5-flash",
  };
}

/** Async generator that yields the given chunks (each becomes a streaming response). */
export function buildGeminiStream(chunks: string[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: chunk }],
              },
            },
          ],
        };
      }
    },
  };
}
