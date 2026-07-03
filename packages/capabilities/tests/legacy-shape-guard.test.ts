/**
 * Regression guard for the alpha.26.1 fix.
 *
 * Every factory in `@llm-ports/capabilities` calls the port through the
 * canonical `messages: LLMMessage[]` shape — NOT the deprecated
 * `{instructions, prompt}` shape. If a future PR reintroduces the legacy
 * shape in an internal port call, this test catches it before publish.
 *
 * The alpha.26 ship shipped the deprecation of `instructions`/`prompt` on
 * the port surface but did NOT migrate this package's internal calls. The
 * alpha.26.1 patch closes that gap so this package continues to work when
 * alpha.27 removes the legacy fields entirely.
 *
 * The guard uses a spy port that records the SHAPE of every call it
 * receives. Each factory is instantiated + invoked once; the spy
 * assertion checks that `messages` was set and `instructions`/`prompt`
 * were NOT.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LLMPort, GenerateStructuredResult, GenerateTextResult } from "@llm-ports/core";
import {
  createAnalyzer,
  createClassifier,
  createDrafter,
  createExtractor,
  createPlanner,
  createScorer,
  createSummarizer,
} from "../src/index.js";

/**
 * Recording port that captures the shape of every call.
 */
function makeRecordingPort(): {
  port: LLMPort;
  calls: Array<{ method: string; options: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; options: Record<string, unknown> }> = [];
  const baseResult = {
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0.001 },
    modelId: "m",
    providerAlias: "spy",
    latencyMs: 1,
  };
  const port: LLMPort = {
    async generateText(options): Promise<GenerateTextResult> {
      calls.push({ method: "generateText", options: { ...options } });
      return { text: "draft", ...baseResult };
    },
    async generateStructured<T>(options): Promise<GenerateStructuredResult<T>> {
      calls.push({ method: "generateStructured", options: { ...options } });
      // Fake a schema-conforming result. Every test schema below is either
      // an object with a `score` field or a simple string wrapper.
      return {
        data: { score: 7, reason: "ok", intent: "test", category: "A" } as never,
        ...baseResult,
        validationAttempts: 1,
      };
    },
    async runAgent() {
      throw new Error("not used by these factories");
    },
    streamText: async function* () {
      yield "stub";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
  return { port, calls };
}

/**
 * Assertion helper: the given call MUST have `messages` set and MUST NOT
 * have `instructions` or `prompt` set.
 */
function assertCanonicalShape(call: { method: string; options: Record<string, unknown> }): void {
  expect(call.options.messages, `${call.method} should use canonical 'messages' shape`).toBeDefined();
  expect(Array.isArray(call.options.messages), `${call.method}.messages should be an LLMMessage[]`).toBe(true);
  expect((call.options.messages as unknown[]).length, `${call.method}.messages should be non-empty`).toBeGreaterThan(0);
  expect(call.options.instructions, `${call.method} should NOT set deprecated 'instructions'`).toBeUndefined();
  expect(call.options.prompt, `${call.method} should NOT set deprecated 'prompt'`).toBeUndefined();
}

describe("alpha.26.1 legacy-shape guard: every factory uses canonical messages input", () => {
  it("createClassifier does not use instructions/prompt", async () => {
    const { port, calls } = makeRecordingPort();
    const schema = z.object({ intent: z.string() });
    const classifier = createClassifier({
      port,
      schema,
      schemaName: "intent",
      taskType: "classify",
      systemContext: "Test context",
    });
    await classifier({ content: "Test input" });
    expect(calls.length).toBe(1);
    assertCanonicalShape(calls[0]!);
  });

  it("createExtractor does not use instructions/prompt", async () => {
    const { port, calls } = makeRecordingPort();
    const schema = z.object({ score: z.number() });
    const extractor = createExtractor({
      port,
      schema,
      schemaName: "fields",
      taskType: "extract",
      systemContext: "Test context",
    });
    await extractor({ content: "Test input" });
    expect(calls.length).toBe(1);
    assertCanonicalShape(calls[0]!);
  });

  it("createScorer does not use instructions/prompt", async () => {
    const { port, calls } = makeRecordingPort();
    const schema = z.object({ score: z.number(), reason: z.string() });
    const scorer = createScorer({
      port,
      schema,
      schemaName: "quality",
      taskType: "score",
      rubric: "0-10 rubric",
    });
    await scorer({ content: "Test input" });
    expect(calls.length).toBe(1);
    assertCanonicalShape(calls[0]!);
  });

  it("createSummarizer does not use instructions/prompt", async () => {
    const { port, calls } = makeRecordingPort();
    const summarizer = createSummarizer({
      port,
      taskType: "summarize",
      style: "concise bullet points",
    });
    await summarizer({ content: "Test input" });
    expect(calls.length).toBe(1);
    assertCanonicalShape(calls[0]!);
  });

  it("createDrafter does not use instructions/prompt", async () => {
    const { port, calls } = makeRecordingPort();
    const drafter = createDrafter({
      port,
      taskType: "draft",
      persona: "friendly professional",
    });
    await drafter({ instructions: "Write a short greeting" });
    expect(calls.length).toBe(1);
    assertCanonicalShape(calls[0]!);
  });

  it("createAnalyzer does not use instructions/prompt", async () => {
    const { port, calls } = makeRecordingPort();
    const schema = z.object({ score: z.number(), reason: z.string() });
    const analyzer = createAnalyzer({
      port,
      schema,
      schemaName: "analysis",
      taskType: "analyze",
    });
    await analyzer({ content: "Test input" });
    expect(calls.length).toBe(1);
    assertCanonicalShape(calls[0]!);
  });

  it("createPlanner does not use instructions/prompt", async () => {
    const { port, calls } = makeRecordingPort();
    const schema = z.object({ score: z.number() });
    const planner = createPlanner({
      port,
      schema,
      schemaName: "plan",
      taskType: "plan",
    });
    await planner({ goal: "Test goal" });
    expect(calls.length).toBe(1);
    assertCanonicalShape(calls[0]!);
  });
});
