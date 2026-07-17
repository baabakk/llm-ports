/**
 * alpha.27+ canonical messages input + generalized deprecation infrastructure.
 *
 * Test coverage:
 *   1. `messages: LLMMessage[]` flows through to the adapter unchanged.
 *   2. Missing `messages` throws `MessagesRequiredError`.
 *   3. Empty `messages` array throws `EmptyMessagesError`.
 *   4. `warnDeprecated` fires with dedup by `where`.
 *   5. `suppressDeprecationWarnings: true` silences all warnings.
 *   6. `deprecationWarningHandler` intercepts the warning message with
 *      the generalized details format.
 *   7. Helper: `toMessages(instructions, prompt)` returns the expected shape.
 *   8. Helper: `sys()` + `usr()` returns the expected shape.
 *
 * alpha.26's tests for the removed `{instructions, prompt}` legacy path
 * were deleted alongside the fields themselves (Commit D). The alpha.27
 * `warnDeprecated` API is domain-agnostic and reusable for future
 * deprecation cycles.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createRegistryFromEnv,
  createWarningState,
  EmptyMessagesError,
  MessagesRequiredError,
  PromptRequiredError,
  sys,
  toMessages,
  usr,
  warnDeprecated,
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

function makeRegistry(seen: Array<{ options: unknown }>) {
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
  });
}

describe("alpha.27 canonical messages input", () => {
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

  it("missing messages throws MessagesRequiredError", async () => {
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

  it("generateStructured with messages input works", async () => {
    const seen: Array<{ options: unknown }> = [];
    const registry = makeRegistry(seen);
    await registry.getPort().generateStructured({
      taskType: "test",
      messages: [sys("system"), usr("hi")],
      schema: z.object({ x: z.string() }),
    });
    expect(seen).toHaveLength(1);
  });
});

describe("alpha.27 generalized deprecation infrastructure", () => {
  it("warnDeprecated fires once per unique `where` key", () => {
    const handler = vi.fn();
    const state = createWarningState({ handler });
    warnDeprecated(state, { what: "'legacy' option", where: "createSomething" });
    warnDeprecated(state, { what: "'legacy' option", where: "createSomething" });
    warnDeprecated(state, { what: "'legacy' option", where: "createSomething" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("warnDeprecated fires for each distinct `where` key", () => {
    const handler = vi.fn();
    const state = createWarningState({ handler });
    warnDeprecated(state, { what: "'a' option", where: "createA" });
    warnDeprecated(state, { what: "'b' option", where: "createB" });
    warnDeprecated(state, { what: "'c' option", where: "createC" });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("suppressed WarningState silences all warnings", () => {
    const handler = vi.fn();
    const state = createWarningState({ suppressed: true, handler });
    warnDeprecated(state, { what: "'x'", where: "createX" });
    warnDeprecated(state, { what: "'y'", where: "createY" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("warning message includes removalVersion + migrationUrl when provided", () => {
    const handler = vi.fn();
    const state = createWarningState({ handler });
    warnDeprecated(state, {
      what: "'onMissing' as a function",
      where: "createVersionedStore",
      removalVersion: "alpha.35",
      migrationUrl: "https://example.com/migration.md",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0]![0] as string;
    expect(msg).toContain("DEPRECATED");
    expect(msg).toContain("'onMissing' as a function");
    expect(msg).toContain("createVersionedStore");
    expect(msg).toContain("alpha.35");
    expect(msg).toContain("https://example.com/migration.md");
  });
});

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
