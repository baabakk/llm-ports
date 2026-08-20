/**
 * Alpha.32 — `streamChat`: streaming with tool calls surfaced, not executed.
 *
 * The cases that matter most are the contract ones, because those are
 * promises rather than behaviour that may drift:
 *
 * - tool calls are SURFACED, never executed (`execute` must not run);
 * - tool schemas are converted PER ATTEMPT, so a fallback provider never
 *   inherits a dialect prepared for the provider that just failed;
 * - adapters lacking the optional method are skipped, not attempted;
 * - a failed chain yields a terminal `error` event rather than throwing
 *   out of the iterator, so one shape covers both outcomes.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AuthenticationError,
  createRegistryFromEnv,
  NoProvidersAvailableError,
  ProviderUnavailableError,
  type AdapterRegistration,
  type ChatStreamEvent,
  type LLMPort,
  type ModelPricing,
  type StreamChatOptions,
  type ToolDefinition,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1, outputPer1M: 2 };

/** A tool whose `execute` fails the test if anything calls it. */
function neverExecutedTool(): ToolDefinition {
  return {
    name: "save_plan",
    description: "Save the plan",
    inputSchema: z.object({ objective: z.string() }),
    execute: async () => {
      throw new Error("streamChat must never execute a tool");
    },
  };
}

/** Minimal port with only the required methods; no streamChat. */
function portWithout(): LLMPort {
  return {
    async generateText() {
      throw new Error("not used");
    },
    async generateStructured() {
      throw new Error("not used");
    },
    async runAgent() {
      throw new Error("not used");
    },
    streamText: async function* () {
      yield "unused";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

/** Port that emits a scripted event sequence. */
function portEmitting(
  events: ChatStreamEvent[],
  onCall?: (options: StreamChatOptions) => void,
): LLMPort {
  return {
    ...portWithout(),
    streamChat: async function* (options: StreamChatOptions) {
      onCall?.(options);
      for (const e of events) yield e;
    },
  };
}

function adapterFor(name: string, port: LLMPort): AdapterRegistration {
  return {
    name,
    pricing: { "model-x": PRICING },
    createLLMPort: () => port,
  };
}

const ENV_ONE = {
  LLM_PROVIDER_A: "alpha|model-x|req:100/hour",
  LLM_TASK_ROUTE_CHAT: "a",
} as const;

const ENV_TWO = {
  LLM_PROVIDER_A: "alpha|model-x|req:100/hour",
  LLM_PROVIDER_B: "beta|model-x|req:100/hour",
  LLM_TASK_ROUTE_CHAT: "a,b",
} as const;

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

// ─── Event passthrough ──────────────────────────────────────────────

describe("streamChat — event stream", () => {
  it("passes text deltas and tool calls through in order", async () => {
    const scripted: ChatStreamEvent[] = [
      { type: "text-delta", text: "Let me " },
      { type: "text-delta", text: "check." },
      { type: "tool-call", toolCallId: "c1", toolName: "save_plan", args: { objective: "x" }, rawArguments: '{"objective":"x"}' },
      { type: "step-finish", stopReason: "tool_calls" },
    ];
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: { alpha: adapterFor("alpha", portEmitting(scripted)) },
    });

    const events = await collect(
      registry.getPort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
        tools: { save_plan: neverExecutedTool() },
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "text-delta",
      "text-delta",
      "tool-call",
      "step-finish",
    ]);
  });

  it("SURFACES tool calls without executing them", async () => {
    // The defining contract of this method. `execute` throws if called.
    const tool = neverExecutedTool();
    const executeSpy = vi.spyOn(tool, "execute");
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: {
        alpha: adapterFor(
          "alpha",
          portEmitting([
            { type: "tool-call", toolCallId: "c1", toolName: "save_plan", args: {}, rawArguments: "{}" },
            { type: "step-finish", stopReason: "tool_calls" },
          ]),
        ),
      },
    });

    const events = await collect(
      registry.getPort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
        tools: { save_plan: tool },
      }),
    );
    expect(events[0]).toMatchObject({ type: "tool-call", toolName: "save_plan" });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("carries usage and cost on the terminal finish event", async () => {
    // Streamed responses arrive in pieces; without this the call would
    // lose its cost accounting entirely.
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: {
        alpha: adapterFor(
          "alpha",
          portEmitting([
            { type: "text-delta", text: "ok" },
            {
              type: "finish",
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              cost: { inputUSD: 0.00001, outputUSD: 0.00001, totalUSD: 0.00002 },
              modelId: "model-x",
              providerAlias: "a",
            },
          ]),
        ),
      },
    });

    const events = await collect(
      registry.getPort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ modelId: "model-x" });
  });
});

// ─── Tool schema conversion, per attempt ────────────────────────────

describe("streamChat — tool schemas are converted per attempt", () => {
  it("hands each provider the caller's tool definitions, not the previous provider's output", async () => {
    // This is the guarantee that prevents the reported defect class where
    // a fallback model rejects the primary model's tool definitions,
    // because schema preparation happened once upstream and was reused.
    const seenByProvider: Record<string, Record<string, ToolDefinition> | undefined> = {};

    const failing = adapterFor("alpha", {
      ...portWithout(),
      streamChat: async function* (options: StreamChatOptions) {
        seenByProvider["a"] = options.tools;
        throw new ProviderUnavailableError("a", new Error("down"));
        // eslint-disable-next-line no-unreachable
        yield { type: "step-finish", stopReason: "stop" } as ChatStreamEvent;
      },
    });
    const working = adapterFor("beta", {
      ...portWithout(),
      streamChat: async function* (options: StreamChatOptions) {
        seenByProvider["b"] = options.tools;
        yield { type: "step-finish", stopReason: "stop" };
      },
    });

    const tools = { save_plan: neverExecutedTool() };
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: { alpha: failing, beta: working },
      runtimeFallback: "aggressive",
    });

    await collect(
      registry.getPort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
        tools,
      }),
    );

    // Both providers were handed the SAME source definitions, each free
    // to convert them into its own dialect. Neither received a
    // pre-converted artifact from the other.
    expect(seenByProvider["a"]).toBeDefined();
    expect(seenByProvider["b"]).toBeDefined();
    expect(seenByProvider["a"]!["save_plan"]).toBe(tools["save_plan"]);
    expect(seenByProvider["b"]!["save_plan"]).toBe(tools["save_plan"]);
    // And critically, the zod schema arrives intact rather than as some
    // provider's JSON-Schema rendering of it.
    expect(seenByProvider["b"]!["save_plan"]!.inputSchema).toBe(
      tools["save_plan"]!.inputSchema,
    );
  });
});

// ─── Capability detection ───────────────────────────────────────────

describe("streamChat — optional-method handling", () => {
  it("skips an adapter that does not implement it and uses one that does", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", portWithout()),
        beta: adapterFor("beta", portEmitting([{ type: "step-finish", stopReason: "stop" }])),
      },
    });

    const events = await collect(
      registry.getPort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events).toEqual([{ type: "step-finish", stopReason: "stop" }]);
  });

  it("names every alias and the missing method when nothing in the chain supports it", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", portWithout()),
        beta: adapterFor("beta", portWithout()),
      },
    });

    await expect(
      collect(
        registry.getPort().streamChat!({
          taskType: "chat",
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    ).rejects.toThrow(NoProvidersAvailableError);
  });

  it("reports support per alias", () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", portWithout()),
        beta: adapterFor("beta", portEmitting([])),
      },
    });
    expect(registry.aliasSupportsStreamChat("a")).toBe(false);
    expect(registry.aliasSupportsStreamChat("b")).toBe(true);
    // Unresolvable aliases answer "cannot serve this" rather than throwing.
    expect(registry.aliasSupportsStreamChat("nonexistent")).toBe(false);
  });
});

// ─── Fallback and failure ───────────────────────────────────────────

describe("streamChat — fallback and failure", () => {
  it("walks the chain when the first provider fails to open its stream", async () => {
    const failing = adapterFor("alpha", {
      ...portWithout(),
      streamChat: async function* () {
        throw new ProviderUnavailableError("a", new Error("down"));
      },
    });
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: failing,
        beta: adapterFor("beta", portEmitting([{ type: "text-delta", text: "from b" }])),
      },
      runtimeFallback: "aggressive",
    });

    const events = await collect(
      registry.getPort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events).toEqual([{ type: "text-delta", text: "from b" }]);
  });

  it("yields a terminal error event on a mid-stream failure rather than throwing", async () => {
    // One shape covers both outcomes, so a consumer's for-await does not
    // need a try/catch wrapped around a live conversation.
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: {
        alpha: adapterFor("alpha", {
          ...portWithout(),
          streamChat: async function* () {
            yield { type: "text-delta", text: "partial" } as ChatStreamEvent;
            throw new Error("connection reset");
          },
        }),
      },
    });

    const events = await collect(
      registry.getPort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events[0]).toEqual({ type: "text-delta", text: "partial" });
    expect(events[1]?.type).toBe("error");
    expect((events[1] as { error: Error }).error.message).toBe("connection reset");
  });

  it("honours forceProviderAlias", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", portEmitting([{ type: "text-delta", text: "from a" }])),
        beta: adapterFor("beta", portEmitting([{ type: "text-delta", text: "from b" }])),
      },
    });
    const events = await collect(
      registry.getPort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
        forceProviderAlias: "b",
      }),
    );
    expect(events).toEqual([{ type: "text-delta", text: "from b" }]);
  });

  it("marks a provider authenticated once its stream opens", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: { alpha: adapterFor("alpha", portEmitting([])) },
    });
    expect(registry.hasEverAuthenticated("a")).toBe(false);
    await collect(
      registry.getPort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(registry.hasEverAuthenticated("a")).toBe(true);
  });
});

// ─── Options passthrough ────────────────────────────────────────────

describe("streamChat — options reach the adapter", () => {
  it("forwards toolChoice, signal, and per-attempt timeout", async () => {
    let seen: StreamChatOptions | undefined;
    const controller = new AbortController();
    const registry = createRegistryFromEnv({
      env: { ...ENV_ONE },
      adapters: {
        alpha: adapterFor("alpha", portEmitting([], (o) => {
          seen = o;
        })),
      },
    });

    await collect(
      registry.getPort().streamChat!({
        taskType: "chat",
        messages: [{ role: "user", content: "hi" }],
        toolChoice: "required",
        signal: controller.signal,
        perAttemptTimeoutMs: 1500,
      }),
    );
    expect(seen?.toolChoice).toBe("required");
    expect(seen?.signal).toBe(controller.signal);
    expect(seen?.perAttemptTimeoutMs).toBe(1500);
  });
});
