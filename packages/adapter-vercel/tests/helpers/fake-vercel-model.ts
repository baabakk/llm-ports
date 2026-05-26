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
  finishReason?: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
}

export function buildVercelGenerateTextResult(spec: MockedGenerateText): {
  text: string;
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  response: { modelId: string };
  steps: Array<{
    text: string;
    finishReason: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>;
    toolResults?: Array<{ toolCallId: string; result: unknown }>;
  }>;
} {
  const usage = {
    promptTokens: spec.promptTokens,
    completionTokens: spec.completionTokens,
    totalTokens: spec.promptTokens + spec.completionTokens,
  };
  const finishReason = spec.finishReason ?? "stop";
  return {
    text: spec.text,
    finishReason,
    usage,
    response: { modelId: spec.modelId ?? "fake-model" },
    // alpha.8: runAgent multi-turn uses result.steps[]. For single-step
    // generation, mimic Vercel's behavior: a 1-element steps array carrying
    // the same text + usage + finishReason as the top-level result.
    steps: [{ text: spec.text, finishReason, usage }],
  };
}

/**
 * Build a result that simulates a reasoning model that spent its entire
 * output budget on hidden reasoning and produced no visible text. The
 * adapter should detect this and retry once with an expanded budget.
 */
export function buildVercelReasoningStarvedResult(spec: {
  promptTokens: number;
  completionTokens: number;
  modelId?: string;
}): ReturnType<typeof buildVercelGenerateTextResult> {
  return buildVercelGenerateTextResult({
    text: "",
    promptTokens: spec.promptTokens,
    completionTokens: spec.completionTokens,
    modelId: spec.modelId,
    finishReason: "length",
  });
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
