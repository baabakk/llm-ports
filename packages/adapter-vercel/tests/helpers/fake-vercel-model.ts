/**
 * Fake Vercel LanguageModel for tests. Avoids the complexity of mocking the
 * Vercel AI SDK's module surface; instead, we mock the SDK helpers themselves.
 */

import { vi, type Mock } from "vitest";

export const mockGenerateText: Mock = vi.fn();
export const mockStreamText: Mock = vi.fn();
export const mockEmbed: Mock = vi.fn();
export const mockEmbedMany: Mock = vi.fn();

vi.mock("ai", () => {
  return {
    generateText: mockGenerateText,
    streamText: mockStreamText,
    embed: mockEmbed,
    embedMany: mockEmbedMany,
  };
});

export interface MockedGenerateText {
  text: string;
  promptTokens: number;
  completionTokens: number;
  modelId?: string;
}

export function buildVercelGenerateTextResult(spec: MockedGenerateText): {
  text: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  response: { modelId: string };
} {
  return {
    text: spec.text,
    usage: {
      promptTokens: spec.promptTokens,
      completionTokens: spec.completionTokens,
      totalTokens: spec.promptTokens + spec.completionTokens,
    },
    response: { modelId: spec.modelId ?? "fake-model" },
  };
}

export function buildVercelStreamResult(chunks: string[]): {
  textStream: AsyncIterable<string>;
} {
  return {
    textStream: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    },
  };
}

export function resetMocks(): void {
  mockGenerateText.mockReset();
  mockStreamText.mockReset();
  mockEmbed.mockReset();
  mockEmbedMany.mockReset();
}
