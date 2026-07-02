/**
 * alpha.26+ canonical `messages` input, migration shim, deprecation
 * warnings, error paths.
 *
 * Test coverage:
 *   1. `messages: LLMMessage[]` flows through to the adapter unchanged.
 *   2. Legacy `{instructions, prompt}` shape still works with a deprecation
 *      warning emitted (backwards compat during alpha.26 window).
 *   3. Passing BOTH `messages` AND legacy fields throws `MessagesConflictError`.
 *   4. Missing both throws `MessagesRequiredError`.
 *   5. Empty `messages` array throws `EmptyMessagesError`.
 *   6. Deprecation warning is deduplicated across repeated calls from the
 *      same call-site (fingerprint dedup).
 *   7. `suppressDeprecationWarnings: true` silences all warnings.
 *   8. `deprecationWarningHandler` intercepts the warning message.
 *   9. `toMessages(instructions, prompt)` returns the expected shape.
 *  10. `sys()` + `usr()` helpers return the expected shape.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createRegistryFromEnv,
  EmptyMessagesError,
  MessagesConflictError,
  MessagesRequiredError,
  PromptRequiredError,
  sys,
  toMessages,
  usr,
  type AdapterRegistration,
  type AgentResult,
  type GenerateStructuredResult,
  type GenerateTextResult,
  type LLMMessage,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 2.0 };

function makeSpyPort(seen: Array<{ options: unknown }>): LLMPort {
  return {
    async generateText(options): Promise<GenerateTextResult> {
      seen.push({ options: { ...options } });
      return {
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0.001 },
        modelId: "m",
        providerAlias: "primary",
        latencyMs: 1,
      };
    },
    async generateStructured<T>(options): Promise<GenerateStructuredResult<T>> {
      seen.push({ options: { ...options } });
      return {
        data: {} as T,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0.001 },
        modelId: "m",
        providerAlias: "primary",
        latencyMs: 1,
        validationAttempts: 1,
      };
    },
    async runAgent(): Promise<AgentResult> {
      throw new Error("not used");
    },
    streamText: async function* (options) {
      seen.push({ options: { ...options } });
      yield "hello";
    },
    streamStructured: async function* (options) {
      seen.push({ options: { ...options } });
      yield {} as never;
    },
  };
}

function makeRegistry(seen: Array<{ options: unknown }>, opts?: {
  suppress?: boolean;
  handler?: (msg: string) => void;
}) {
  const adapter: AdapterRegistration = {
    name: "spy",
    pricing: { m: PRICING },
    createLLMPort: () => makeSpyPort(seen),
  };
  return createRegistryFromEnv({
    env: {
      LLM_PROVIDER_PRIMARY: "spy|m|req:100/hour",
      LLM_TASK_ROUTE_TEST: "primary",
    },
    adapters: { spy: adapter },
    ...(opts?.suppress !== undefined ? { suppressDeprecationWarnings: opts.suppress } : {}),
    ...(opts?.handler ? { deprecationWarningHandler: opts.handler } : {}),
  });
}

describe("alpha.26 messages input helpers", () => {
  it("toMessages produces [system, user] when instructions is non-empty", () => {
    const out = toMessages("sys", "user text");
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "user text" },
    ]);
  });

  it("toMessages produces just [user] when instructions is undefined", () => {
    const out = toMessages(undefined, "user text");
    expect(out).toEqual([{ role: "user", content: "user text" }]);
  });

  it("toMessages produces just [user] when instructions is empty string", () => {
    const out = toMessages("", "user text");
    expect(out).toEqual([{ role: "user", content: "user text" }]);
  });

  it("toMessages throws PromptRequiredError when prompt is undefined", () => {
    expect(() => toMessages("sys", undefined as never)).toThrow(PromptRequiredError);
  });

  it("sys() returns { role: 'system', content }", () => {
    expect(sys("hello")).toEqual({ role: "system", content: "hello" });
  });

  it("usr() with a string returns { role: 'user', content: string }", () => {
    expect(usr("hi")).toEqual({ role: "user", content: "hi" });
  });

  it("usr() with content blocks returns { role: 'user', content: blocks }", () => {
    const blocks = [{ type: "text" as const, text: "hi" }];
    expect(usr(blocks)).toEqual({ role: "user", content: blocks });
  });
});

describe("alpha.26 canonical messages path", () => {
  it("messages input flows through the Registry to the adapter unchanged", async () => {
    const seen: Array<{ options: unknown }> = [];
    const registry = makeRegistry(seen);
    const canonicalMessages: LLMMessage[] = [
      sys("You are a classifier."),
      usr("Classify this."),
    ];
    await registry.getPort().generateText({
      taskType: "test",
      messages: canonicalMessages,
    });
    expect(seen).toHaveLength(1);
    const passed = seen[0]!.options as { messages: LLMMessage[] };
    expect(passed.messages).toEqual(canonicalMessages);
  });

  it("legacy {instructions, prompt} still works with deprecation warning", async () => {
    const seen: Array<{ options: unknown }> = [];
    const handler = vi.fn();
    const registry = makeRegistry(seen, { handler });
    await registry.getPort().generateText({
      taskType: "test",
      instructions: "sys",
      prompt: "hi",
    });
    expect(seen).toHaveLength(1);
    const passed = seen[0]!.options as { messages: LLMMessage[] };
    // Legacy path synthesizes messages via toMessages.
    expect(passed.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatch(/DEPRECATED/);
  });

  it("mixing messages + legacy fields throws MessagesConflictError", async () => {
    const seen: Array<{ options: unknown }> = [];
    const registry = makeRegistry(seen);
    await expect(
      registry.getPort().generateText({
        taskType: "test",
        messages: [usr("hi")],
        instructions: "sys",
        prompt: "collides",
      }),
    ).rejects.toThrow(MessagesConflictError);
  });

  it("missing both throws MessagesRequiredError", async () => {
    const seen: Array<{ options: unknown }> = [];
    const registry = makeRegistry(seen);
    await expect(
      registry.getPort().generateText({ taskType: "test" } as never),
    ).rejects.toThrow(MessagesRequiredError);
  });

  it("empty messages array throws EmptyMessagesError", async () => {
    const seen: Array<{ options: unknown }> = [];
    const registry = makeRegistry(seen);
    await expect(
      registry.getPort().generateText({
        taskType: "test",
        messages: [],
      }),
    ).rejects.toThrow(EmptyMessagesError);
  });
});

describe("alpha.26 deprecation warning behavior", () => {
  it("dedupes repeated calls from the same call-site to a single warning", async () => {
    const seen: Array<{ options: unknown }> = [];
    const handler = vi.fn();
    const registry = makeRegistry(seen, { handler });
    for (let i = 0; i < 10; i++) {
      await registry.getPort().generateText({
        taskType: "test",
        instructions: "sys",
        prompt: "hi",
      });
    }
    // Same call-site → single warning across 10 calls.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("suppressDeprecationWarnings: true silences all warnings", async () => {
    const seen: Array<{ options: unknown }> = [];
    const handler = vi.fn();
    const registry = makeRegistry(seen, { suppress: true, handler });
    await registry.getPort().generateText({
      taskType: "test",
      instructions: "sys",
      prompt: "hi",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("streamText emits a warning too when using legacy shape", async () => {
    const seen: Array<{ options: unknown }> = [];
    const handler = vi.fn();
    const registry = makeRegistry(seen, { handler });
    for await (const _c of registry.getPort().streamText({
      taskType: "test",
      instructions: "sys",
      prompt: "hi",
    })) {
      // consume
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatch(/streamText/);
  });

  it("streamStructured emits a warning too when using legacy shape", async () => {
    const seen: Array<{ options: unknown }> = [];
    const handler = vi.fn();
    const registry = makeRegistry(seen, { handler });
    for await (const _c of registry.getPort().streamStructured({
      taskType: "test",
      instructions: "sys",
      prompt: "hi",
      schema: {} as never,
    })) {
      // consume
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatch(/streamStructured/);
  });

  it("generateStructured emits a warning when using legacy shape", async () => {
    const seen: Array<{ options: unknown }> = [];
    const handler = vi.fn();
    const registry = makeRegistry(seen, { handler });
    await registry.getPort().generateStructured({
      taskType: "test",
      instructions: "sys",
      prompt: "hi",
      schema: {} as never,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatch(/generateStructured/);
  });
});
