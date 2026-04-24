/**
 * Mock the openai SDK module so tests can control responses without HTTP.
 */

import { vi, type Mock } from "vitest";

export const mockChatCompletionsCreate: Mock = vi.fn();
export const mockEmbeddingsCreate: Mock = vi.fn();

vi.mock("openai", () => {
  const ctor = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChatCompletionsCreate } },
    embeddings: { create: mockEmbeddingsCreate },
  }));
  return { default: ctor };
});

// ─── Response builders for the OpenAI Chat Completions API shape ─────

export interface MockedOpenAIChatResponse {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  promptTokens: number;
  completionTokens: number;
  modelId?: string;
  cachedTokens?: number;
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter";
}

export function buildOpenAIChatResponse(spec: MockedOpenAIChatResponse): {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens: number };
  };
} {
  const tcs = spec.toolCalls?.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.arguments },
  }));
  return {
    id: `chatcmpl-test-${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: spec.modelId ?? "gpt-5-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: spec.text ?? null,
          ...(tcs && tcs.length > 0 ? { tool_calls: tcs } : {}),
        },
        finish_reason:
          spec.finishReason ?? (tcs && tcs.length > 0 ? "tool_calls" : "stop"),
      },
    ],
    usage: {
      prompt_tokens: spec.promptTokens,
      completion_tokens: spec.completionTokens,
      total_tokens: spec.promptTokens + spec.completionTokens,
      ...(spec.cachedTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: spec.cachedTokens } }
        : {}),
    },
  };
}

export function buildOpenAIEmbeddingResponse(spec: {
  vector: number[];
  promptTokens: number;
  modelId?: string;
}): {
  object: "list";
  model: string;
  data: Array<{ object: "embedding"; embedding: number[]; index: number }>;
  usage: { prompt_tokens: number; total_tokens: number };
} {
  return {
    object: "list",
    model: spec.modelId ?? "text-embedding-3-small",
    data: [{ object: "embedding", embedding: spec.vector, index: 0 }],
    usage: { prompt_tokens: spec.promptTokens, total_tokens: spec.promptTokens },
  };
}

/**
 * Build a fake stream that yields ChatCompletionChunk-shaped events with
 * the given text deltas. Matches openai's stream iterator contract.
 */
export function buildOpenAIChatStream(chunks: string[]): AsyncIterable<{
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { content?: string };
    finish_reason: string | null;
  }>;
}> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        yield {
          id: "chatcmpl-stream-test",
          object: "chat.completion.chunk" as const,
          created: Math.floor(Date.now() / 1000),
          model: "gpt-5-mini",
          choices: [
            {
              index: 0 as const,
              delta: { content: chunks[i] },
              finish_reason: isLast ? "stop" : null,
            },
          ],
        };
      }
    },
  };
}

export function resetMocks(): void {
  mockChatCompletionsCreate.mockReset();
  mockEmbeddingsCreate.mockReset();
}
