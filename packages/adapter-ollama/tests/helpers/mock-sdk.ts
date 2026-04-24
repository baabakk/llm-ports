/**
 * Mock the ollama npm package for tests.
 */

import { vi, type Mock } from "vitest";

export const mockChat: Mock = vi.fn();
export const mockEmbed: Mock = vi.fn();
export const mockList: Mock = vi.fn(async () => ({ models: [] }));
export const mockPull: Mock = vi.fn();
export const mockDelete: Mock = vi.fn();

vi.mock("ollama", () => {
  return {
    Ollama: vi.fn().mockImplementation(() => ({
      chat: mockChat,
      embed: mockEmbed,
      list: mockList,
      pull: mockPull,
      delete: mockDelete,
    })),
  };
});

// ─── Response builders for the Ollama API shape ──────────────────────

export interface MockedOllamaChatResponse {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  promptEvalCount: number;
  evalCount: number;
  modelId?: string;
  doneReason?: "stop" | "length" | "load";
}

export function buildOllamaChatResponse(spec: MockedOllamaChatResponse): {
  model: string;
  created_at: string;
  message: {
    role: "assistant";
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  };
  done: boolean;
  done_reason?: string;
  prompt_eval_count: number;
  eval_count: number;
} {
  return {
    model: spec.modelId ?? "llama3.3",
    created_at: new Date().toISOString(),
    message: {
      role: "assistant",
      content: spec.text ?? "",
      ...(spec.toolCalls && spec.toolCalls.length > 0
        ? {
            tool_calls: spec.toolCalls.map((tc) => ({
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    },
    done: true,
    ...(spec.doneReason ? { done_reason: spec.doneReason } : {}),
    prompt_eval_count: spec.promptEvalCount,
    eval_count: spec.evalCount,
  };
}

export function buildOllamaEmbedResponse(spec: {
  vectors: number[][];
  modelId?: string;
}): { model: string; embeddings: number[][] } {
  return {
    model: spec.modelId ?? "nomic-embed-text",
    embeddings: spec.vectors,
  };
}

/** Build a fake Ollama streaming chat iterator. */
export function buildOllamaChatStream(chunks: string[]): AsyncIterable<{
  model: string;
  created_at: string;
  message: { role: "assistant"; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        yield {
          model: "llama3.3",
          created_at: new Date().toISOString(),
          message: { role: "assistant" as const, content: chunks[i]! },
          done: isLast,
          ...(isLast ? { prompt_eval_count: 5, eval_count: chunks.length } : {}),
        };
      }
    },
  };
}

export function resetMocks(): void {
  mockChat.mockReset();
  mockEmbed.mockReset();
  mockList.mockReset();
  mockList.mockImplementation(async () => ({ models: [] }));
  mockPull.mockReset();
  mockDelete.mockReset();
}
