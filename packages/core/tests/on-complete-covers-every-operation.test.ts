/**
 * `onComplete` fires once per call for **every** operation, not just the two
 * that shipped working.
 *
 * ## Why this file exists
 *
 * `alpha.35` shipped `onComplete` documented as firing exactly once per call,
 * typed with an `operation` union naming nine operations, and emitted from two
 * of them: `generateText` and `generateChat`. A consumer adopting it as their
 * single per-call spend event would have lost every streamed and structured
 * call silently. It was reported by the RLM gateway (their TD-08) rather than
 * caught here, because the original test file exercised `generateText` and
 * nothing else, so every test passed.
 *
 * **The lesson this file encodes is structural, not incidental.** A hook whose
 * whole value is "one event per call, whatever the call" cannot be verified on
 * one method. So every operation the registry can serve gets a case here, and
 * the failure path gets one too, because a completion hook that only fires on
 * success describes a healthier system than the real one.
 *
 * Fixed in `0.1.0-alpha.35.1`. See
 * `TD-LLMPORTS-ONCOMPLETE-FIRES-FOR-TWO-OF-NINE-OPERATIONS`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRegistryFromEnv,
  wrapProviderError,
  type AdapterRegistration,
  type CompletionEvent,
  type LLMPort,
} from "../src/index.js";

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const COST = { inputUSD: 0.00001, outputUSD: 0.000005, totalUSD: 0.000015 };
const Schema = z.object({ ok: z.boolean() });

/** A port that answers on every method the registry can route. */
function answering(alias: string): LLMPort {
  const base = { usage: USAGE, cost: COST, modelId: "m", providerAlias: alias, latencyMs: 1 };
  return {
    generateText: async () => ({ ...base, text: "ok" }),
    generateStructured: async () => ({ ...base, data: { ok: true }, validationAttempts: 1 }),
    generateChat: async () => ({ ...base, text: "ok", toolCalls: [], stopReason: "stop" }),
    runAgent: async () => ({ ...base, text: "ok", toolCalls: [], stepsTaken: 1, terminationReason: "completed" }),
    async *streamText() {
      yield "he";
      yield "llo";
    },
    async *streamStructured() {
      yield { ok: true };
    },
    async *streamChat() {
      yield { type: "text", text: "hello" };
    },
  } as unknown as LLMPort;
}

/** A port that fails on every method, at open time. */
function failing(): LLMPort {
  const boom = (): never => {
    throw wrapProviderError("a", Object.assign(new Error("HTTP 503"), { status: 503 }));
  };
  return {
    generateText: async () => boom(),
    generateStructured: async () => boom(),
    generateChat: async () => boom(),
    runAgent: async () => boom(),
    // Streaming adapters must throw when PRIMED, which is the first `next()`,
    // so the throw belongs in the generator body rather than before it.
    async *streamText() {
      boom();
      yield "";
    },
    async *streamStructured() {
      boom();
      yield {};
    },
    async *streamChat() {
      boom();
      yield { type: "text", text: "" };
    },
  } as unknown as LLMPort;
}

function adapter(name: string, port: LLMPort): AdapterRegistration {
  return { name, pricing: { m: { inputPer1M: 1, outputPer1M: 1 } }, createLLMPort: () => port };
}

const env = {
  LLM_PROVIDER_A: "alpha|m|req:100/hour",
  LLM_TASK_ROUTE_CHAT: "a",
};

function registryWith(port: LLMPort, seen: CompletionEvent[]) {
  return createRegistryFromEnv({
    env,
    adapters: { alpha: adapter("alpha", port) },
    observability: { onComplete: (e) => void seen.push(e) },
  });
}

const call = { taskType: "chat", messages: [{ role: "user" as const, content: "hi" }] };

/** Drain an async iterable so a streamed call actually completes. */
async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) {
    // discard
  }
}

describe("onComplete fires for every operation the registry serves", () => {
  const cases: Array<[CompletionEvent["operation"], (p: ReturnType<typeof registryWith>) => Promise<void>]> = [
    ["generateText", async (r) => void (await r.getPort().generateText(call))],
    ["generateStructured", async (r) => void (await r.getPort().generateStructured({ ...call, schema: Schema }))],
    ["generateChat", async (r) => void (await r.getPort().generateChat!(call))],
    ["runAgent", async (r) => void (await r.getPort().runAgent({ ...call, instructions: "go", tools: {} }))],
    ["streamText", async (r) => drain(r.getPort().streamText(call))],
    ["streamStructured", async (r) => drain(r.getPort().streamStructured({ ...call, schema: Schema }))],
    ["streamChat", async (r) => drain(r.getPort().streamChat!(call))],
  ];

  for (const [operation, invoke] of cases) {
    it(`fires exactly once for ${operation}, naming that operation`, async () => {
      const seen: CompletionEvent[] = [];
      await invoke(registryWith(answering("a"), seen));

      // Exactly one: the hook's entire contract is one event per call, so two
      // events is as wrong as none.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.operation).toBe(operation);
      expect(seen[0]!.ok).toBe(true);
      expect(seen[0]!.providerAttempts).toBeGreaterThanOrEqual(1);
      expect(seen[0]!.taskType).toBe("chat");
    });
  }

  for (const [operation, invoke] of cases) {
    it(`fires on failure for ${operation}, with ok false and the error`, async () => {
      const seen: CompletionEvent[] = [];
      const registry = registryWith(failing(), seen);
      // A streamed failure surfaces either as a rejection or, for streamChat,
      // as a terminal error event, so the assertion is on the hook rather than
      // on how the call ended.
      await invoke(registry).catch(() => undefined);

      expect(seen).toHaveLength(1);
      expect(seen[0]!.operation).toBe(operation);
      expect(seen[0]!.ok).toBe(false);
      expect(seen[0]!.error).toBeInstanceOf(Error);
    });
  }
});

describe("the guard that would have caught the original defect", () => {
  it("covers every operation the event type can name, except the two the registry cannot serve", async () => {
    // `embed` and `rerank` are in the union for consumers emitting the event
    // themselves; the registry's LLM port does not route them, so they have no
    // case above. Everything else must be covered, and this assertion fails if
    // a new operation joins the union without a test.
    const registryServed: ReadonlyArray<CompletionEvent["operation"]> = [
      "generateText",
      "generateStructured",
      "generateChat",
      "runAgent",
      "streamText",
      "streamStructured",
      "streamChat",
    ];
    const covered = new Set<string>();
    for (const op of registryServed) {
      const seen: CompletionEvent[] = [];
      const r = registryWith(answering("a"), seen);
      const port = r.getPort();
      switch (op) {
        case "generateText":
          await port.generateText(call);
          break;
        case "generateStructured":
          await port.generateStructured({ ...call, schema: Schema });
          break;
        case "generateChat":
          await port.generateChat!(call);
          break;
        case "runAgent":
          await port.runAgent({ ...call, instructions: "go", tools: {} });
          break;
        case "streamText":
          await drain(port.streamText(call));
          break;
        case "streamStructured":
          await drain(port.streamStructured({ ...call, schema: Schema }));
          break;
        case "streamChat":
          await drain(port.streamChat!(call));
          break;
      }
      if (seen.length === 1 && seen[0]!.operation === op) covered.add(op);
    }
    expect([...covered].sort()).toEqual([...registryServed].sort());
  });
});
