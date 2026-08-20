/**
 * `@llm-ports/integration-livekit` — mapping tests.
 *
 * Covers the translation layer in both directions, which is where an
 * inbound integration actually goes wrong: a chat context flattened
 * incorrectly, a tool call whose arguments arrive parsed when the
 * framework expects raw text, or an event silently forced into a shape
 * that misleads the framework.
 *
 * The class itself is exercised through its exported mapping functions
 * rather than by constructing a live `AgentSession`, which would need a
 * media server. Those functions are exported for exactly this reason.
 */

import { describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "@llm-ports/core";
import { chatContextToMessages, toChatChunk, toolContextToTools } from "../src/index.js";

/** Minimal stand-in for LiveKit's ChatContext shape. */
function ctx(items: unknown[]): never {
  return { items } as never;
}

function message(role: string, ...content: string[]): unknown {
  return { type: "message", role, content };
}

let seq = 0;
const nextId = () => `id-${++seq}`;

// ─── Chat context inward ────────────────────────────────────────────

describe("chatContextToMessages", () => {
  it("flattens message items and joins their content parts", () => {
    const out = chatContextToMessages(
      ctx([message("system", "You are a coach."), message("user", "Hello", " there")]),
    );
    expect(out).toEqual([
      { role: "system", content: "You are a coach." },
      { role: "user", content: "Hello there" },
    ]);
  });

  it("skips tool calls and their outputs", () => {
    // LiveKit replays these to the model itself on the next turn, so
    // forwarding them here would duplicate them in the prompt.
    const out = chatContextToMessages(
      ctx([
        message("user", "hi"),
        { type: "function_call", name: "save_plan", args: "{}", callId: "c1" },
        { type: "function_call_output", callId: "c1", output: "saved" },
      ]),
    );
    expect(out).toEqual([{ role: "user", content: "hi" }]);
  });

  it("drops empty and whitespace-only messages", () => {
    // An empty turn is not something to send to a provider; several
    // reject a message with no content outright.
    const out = chatContextToMessages(ctx([message("user", ""), message("user", "   ")]));
    expect(out).toEqual([]);
  });

  it("falls back to the user role for anything unrecognized", () => {
    const out = chatContextToMessages(ctx([message("developer", "x")]));
    expect(out[0]?.role).toBe("user");
  });

  it("ignores non-string content parts rather than stringifying them", () => {
    // A multimodal part has no faithful text rendering, and inventing one
    // would put fabricated content in the prompt.
    const out = chatContextToMessages(
      ctx([{ type: "message", role: "user", content: ["hi", { image: "..." }] }]),
    );
    expect(out).toEqual([{ role: "user", content: "hi" }]);
  });
});

// ─── Tools inward ───────────────────────────────────────────────────

describe("toolContextToTools", () => {
  it("returns undefined when there are no tools, so the field is omitted", () => {
    // Omitting `tools` is not the same as sending `tools: {}` to every
    // provider, and some treat the empty object differently.
    expect(toolContextToTools(undefined)).toBeUndefined();
    expect(toolContextToTools({})).toBeUndefined();
  });

  it("maps name, description, and schema", () => {
    const schema = { parse: () => ({}) };
    const result = toolContextToTools({
      save_plan: { description: "Save it", parameters: schema },
    });
    expect(result!.tools["save_plan"]).toMatchObject({
      name: "save_plan",
      description: "Save it",
    });
    expect(result!.tools["save_plan"]!.inputSchema).toBe(schema);
  });

  it("accepts either parameters or schema as the field name", () => {
    const schema = { parse: () => ({}) };
    const result = toolContextToTools({ t: { schema } });
    expect(result!.tools["t"]!.inputSchema).toBe(schema);
  });

  it("gives every tool a throwing execute, because LiveKit owns the loop", async () => {
    // If one of these ever ran it would mean the tool-use loop had moved
    // into the port, which would double-execute the agent's handler.
    // Failing loudly beats running a silent duplicate.
    const result = toolContextToTools({ save_plan: { description: "d", parameters: {} } });
    await expect(result!.tools["save_plan"]!.execute({} as never)).rejects.toThrow(
      /LiveKit owns the tool-use loop/,
    );
  });
});

// ─── Events outward ─────────────────────────────────────────────────

describe("toChatChunk", () => {
  it("maps a text delta to an assistant content chunk", () => {
    const chunk = toChatChunk({ type: "text-delta", text: "Hello" }, nextId);
    expect(chunk).toMatchObject({ delta: { role: "assistant", content: "Hello" } });
  });

  it("forwards tool-call arguments as RAW text, not the parsed object", () => {
    // LiveKit's FunctionCall carries `args` as a string and parses it
    // itself. Handing it the parsed object would break that contract.
    const event: ChatStreamEvent = {
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "save_plan",
      args: { objective: "win" },
      rawArguments: '{"objective":"win"}',
    };
    const chunk = toChatChunk(event, nextId);
    const call = (chunk!.delta!.toolCalls as unknown as Array<Record<string, unknown>>)[0]!;
    expect(call["args"]).toBe('{"objective":"win"}');
    expect(call["name"]).toBe("save_plan");
    expect(call["callId"]).toBe("call_1");
  });

  it("still forwards a tool call whose arguments failed to parse", () => {
    // The adapter reports a parse failure rather than dropping the call,
    // and that decision has to survive this layer too.
    const chunk = toChatChunk(
      {
        type: "tool-call",
        toolCallId: "c",
        toolName: "save_plan",
        rawArguments: '{"broken":',
      },
      nextId,
    );
    const call = (chunk!.delta!.toolCalls as unknown as Array<Record<string, unknown>>)[0]!;
    expect(call["args"]).toBe('{"broken":');
  });

  it("maps finish onto LiveKit's usage vocabulary", () => {
    const chunk = toChatChunk(
      {
        type: "finish",
        usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
        modelId: "m",
        providerAlias: "a",
      },
      nextId,
    );
    expect(chunk!.usage).toMatchObject({
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19,
    });
  });

  it("drops events with no LiveKit equivalent rather than inventing one", () => {
    // step-finish: LiveKit infers turn boundaries from the stream ending.
    // error: raised by the caller so the framework sees a rejection.
    expect(toChatChunk({ type: "step-finish", stopReason: "stop" }, nextId)).toBeUndefined();
    expect(toChatChunk({ type: "error", error: new Error("x") }, nextId)).toBeUndefined();
  });

  it("gives every emitted chunk a distinct id", () => {
    const a = toChatChunk({ type: "text-delta", text: "a" }, nextId);
    const b = toChatChunk({ type: "text-delta", text: "b" }, nextId);
    expect(a!.id).not.toBe(b!.id);
  });
});
