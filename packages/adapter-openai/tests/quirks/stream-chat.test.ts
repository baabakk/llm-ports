/**
 * Alpha.32 — adapter-level `streamChat`.
 *
 * The core suite covers Registry behaviour (chain walking, capability
 * filtering, terminal error events). This covers what only the adapter
 * can get wrong: reassembling OpenAI's fragmented tool-call deltas, and
 * converting tool schemas on every call rather than once.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { mockChatCompletionsCreate, resetMocks } from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { createOpenAIAdapter } from "../../src/index.js";
import type { ChatStreamEvent, ToolDefinition } from "@llm-ports/core";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

/** Build a raw OpenAI-shaped stream from explicit chunk objects. */
function rawStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function textChunk(content: string): unknown {
  return { choices: [{ delta: { content } }] };
}

function toolFragment(
  index: number,
  fragment: { id?: string; name?: string; args?: string },
): unknown {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index,
              ...(fragment.id ? { id: fragment.id } : {}),
              ...(fragment.name || fragment.args
                ? {
                    function: {
                      ...(fragment.name ? { name: fragment.name } : {}),
                      ...(fragment.args !== undefined ? { arguments: fragment.args } : {}),
                    },
                  }
                : {}),
            },
          ],
        },
      },
    ],
  };
}

function finishChunk(reason: string): unknown {
  return { choices: [{ delta: {}, finish_reason: reason }] };
}

function makePort() {
  return createOpenAIAdapter({ apiKey: "sk-test" }).createLLMPort("gpt-4o", "a");
}

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const saveTool: ToolDefinition = {
  name: "save_plan",
  description: "Save it",
  inputSchema: z.object({ objective: z.string(), score: z.number() }),
  execute: async () => {
    throw new Error("streamChat must never execute a tool");
  },
};

// ─── Tool-call reassembly ───────────────────────────────────────────

describe("streamChat — tool-call reassembly", () => {
  it("assembles a call split across many argument fragments", async () => {
    // OpenAI streams tool arguments a few characters at a time. Emitting
    // fragments would push reassembly onto every consumer, so the adapter
    // buffers and emits once.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      rawStream([
        toolFragment(0, { id: "call_abc", name: "save_plan", args: '{"obj' }),
        toolFragment(0, { args: 'ective":"wi' }),
        toolFragment(0, { args: 'n","score":5}' }),
        finishChunk("tool_calls"),
      ]),
    );

    const events = await collect(
      makePort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
        tools: { save_plan: saveTool },
      }),
    );

    const call = events.find((e) => e.type === "tool-call");
    expect(call).toMatchObject({
      type: "tool-call",
      toolCallId: "call_abc",
      toolName: "save_plan",
      args: { objective: "win", score: 5 },
    });
  });

  it("keeps parallel calls separate by index and emits them in index order", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      rawStream([
        toolFragment(1, { id: "call_2", name: "second", args: '{"b":2}' }),
        toolFragment(0, { id: "call_1", name: "first", args: '{"a":1}' }),
        finishChunk("tool_calls"),
      ]),
    );

    const events = await collect(
      makePort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const calls = events.filter((e) => e.type === "tool-call");
    expect(calls.map((c) => (c as { toolName: string }).toolName)).toEqual(["first", "second"]);
  });

  it("reports unparseable arguments rather than throwing, and keeps the raw text", async () => {
    // One malformed call must not kill a live conversation, and a caller
    // who can salvage the raw string should get the chance.
    mockChatCompletionsCreate.mockResolvedValueOnce(
      rawStream([
        toolFragment(0, { id: "c", name: "save_plan", args: '{"objective":' }),
        finishChunk("tool_calls"),
      ]),
    );

    const events = await collect(
      makePort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const call = events.find((e) => e.type === "tool-call") as
      | { args?: unknown; rawArguments: string }
      | undefined;
    expect(call).toBeDefined();
    expect(call!.args).toBeUndefined();
    expect(call!.rawArguments).toBe('{"objective":');
  });

  it("flushes assembled calls even when the provider sends no finish_reason", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      rawStream([toolFragment(0, { id: "c", name: "save_plan", args: "{}" })]),
    );
    const events = await collect(
      makePort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events.some((e) => e.type === "tool-call")).toBe(true);
    expect(events.some((e) => e.type === "step-finish")).toBe(true);
  });

  it("drops a nameless call rather than pushing the decision outward", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      rawStream([toolFragment(0, { id: "c", args: "{}" }), finishChunk("tool_calls")]),
    );
    const events = await collect(
      makePort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events.some((e) => e.type === "tool-call")).toBe(false);
  });
});

// ─── Text ───────────────────────────────────────────────────────────

describe("streamChat — text", () => {
  it("emits text deltas and never an empty one", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      rawStream([textChunk("Hello"), textChunk(""), textChunk(" there"), finishChunk("stop")]),
    );
    const events = await collect(
      makePort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const texts = events.filter((e) => e.type === "text-delta");
    expect(texts.map((t) => (t as { text: string }).text)).toEqual(["Hello", " there"]);
  });

  it("interleaves text and tool calls without reordering", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      rawStream([
        textChunk("Checking"),
        toolFragment(0, { id: "c", name: "save_plan", args: "{}" }),
        finishChunk("tool_calls"),
      ]),
    );
    const events = await collect(
      makePort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["text-delta", "tool-call", "step-finish"]);
  });
});

// ─── Schema conversion happens per call ─────────────────────────────

describe("streamChat — tool schemas convert per call", () => {
  it("converts on every invocation rather than reusing a prepared artifact", async () => {
    // The guarantee that prevents a fallback provider being handed a
    // dialect prepared for the provider that just failed. Two calls must
    // each produce their own converted tools array.
    for (let i = 0; i < 2; i++) {
      mockChatCompletionsCreate.mockResolvedValueOnce(rawStream([finishChunk("stop")]));
      await collect(
        makePort().streamChat!({
          taskType: "chat",
          messages: [{ role: "user", content: "hi" }],
          tools: { save_plan: saveTool },
        }),
      );
    }

    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(2);
    const first = mockChatCompletionsCreate.mock.calls[0]![0] as { tools?: unknown[] };
    const second = mockChatCompletionsCreate.mock.calls[1]![0] as { tools?: unknown[] };

    // Both requests carry the schema, converted independently.
    expect(first.tools).toHaveLength(1);
    expect(second.tools).toHaveLength(1);
    expect(first.tools).not.toBe(second.tools);
    expect(second.tools![0]).toMatchObject({
      type: "function",
      function: {
        name: "save_plan",
        parameters: { type: "object" },
      },
    });
  });

  it("sends no tools field when the caller supplies none", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(rawStream([finishChunk("stop")]));
    await collect(
      makePort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const req = mockChatCompletionsCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(req["tools"]).toBeUndefined();
  });

  it("forwards toolChoice only when tools are present", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(rawStream([finishChunk("stop")]));
    await collect(
      makePort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
        tools: { save_plan: saveTool },
        toolChoice: "required",
      }),
    );
    const req = mockChatCompletionsCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(req["tool_choice"]).toBe("required");
  });
});
