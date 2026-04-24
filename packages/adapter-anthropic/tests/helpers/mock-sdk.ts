/**
 * Mock the @anthropic-ai/sdk module at the import boundary so the adapter's
 * `client.messages.create` and `client.messages.stream` calls can be
 * controlled per-test without real HTTP calls.
 *
 * Used by both content.test.ts (indirectly) and contract.test.ts.
 */

import { vi, type Mock } from "vitest";

// ─── Vitest auto-mock for the SDK ────────────────────────────────────

export const mockCreate: Mock = vi.fn();
export const mockStream: Mock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: mockCreate,
      stream: mockStream,
    },
  })),
}));

// ─── Response builders that mimic Anthropic's wire format ────────────

export interface MockedAnthropicMessageResponse {
  textBlocks?: string[];
  toolUseBlocks?: Array<{ id: string; name: string; input: unknown }>;
  inputTokens: number;
  outputTokens: number;
  modelId?: string;
  stopReason?: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence";
}

export function buildAnthropicResponse(spec: MockedAnthropicMessageResponse): {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
} {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  > = [];
  for (const text of spec.textBlocks ?? []) {
    content.push({ type: "text", text });
  }
  for (const tu of spec.toolUseBlocks ?? []) {
    content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
  }
  return {
    id: `msg_test_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: spec.modelId ?? "claude-haiku-4-5",
    content,
    stop_reason:
      spec.stopReason ??
      (spec.toolUseBlocks && spec.toolUseBlocks.length > 0 ? "tool_use" : "end_turn"),
    usage: {
      input_tokens: spec.inputTokens,
      output_tokens: spec.outputTokens,
    },
  };
}

/**
 * Build a fake stream iterator that yields content_block_delta events with
 * the given text chunks. Mimics the shape of @anthropic-ai/sdk's MessageStream.
 */
export function buildAnthropicTextStream(chunks: string[]): AsyncIterable<{
  type: "content_block_delta";
  index: number;
  delta: { type: "text_delta"; text: string };
}> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield {
          type: "content_block_delta" as const,
          index: 0,
          delta: { type: "text_delta" as const, text: chunk },
        };
      }
    },
  };
}

export function resetMocks(): void {
  mockCreate.mockReset();
  mockStream.mockReset();
}
