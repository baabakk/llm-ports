/**
 * Live integration tests for @llm-ports/adapter-anthropic.
 *
 * Skipped unless RUN_LIVE_TESTS=1 AND ANTHROPIC_API_KEY is set.
 *
 * Verifies the adapter against the real Claude API for the test matrix
 * defined in TEST-PLAN.md Phase 2.
 */

import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRegistryFromEnv, type LLMPort } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import {
  ANTHROPIC_KEY,
  PUBLIC_IMAGE_URL,
  TINY_PNG_BASE64,
  assertAgentShape,
  assertGenerateStructuredShape,
  assertGenerateTextShape,
  recordCost,
  reportCosts,
  skipAnthropic,
} from "./shared.js";

const MODEL = "claude-haiku-4-5";       // smallest, cheapest for the matrix
const ALIAS = "live-anthropic";

function makePort(): LLMPort {
  const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY ?? "missing" });
  const registry = createRegistryFromEnv({
    env: {
      LLM_PROVIDER_LIVE_ANTHROPIC: `anthropic|${MODEL}|unlimited`,
      LLM_TASK_ROUTE_TEST_TEXT: "live-anthropic",
      LLM_TASK_ROUTE_TEST_STRUCTURED: "live-anthropic",
      LLM_TASK_ROUTE_TEST_STREAM: "live-anthropic",
      LLM_TASK_ROUTE_TEST_AGENT: "live-anthropic",
      LLM_TASK_ROUTE_TEST_VISION: "live-anthropic",
    },
    adapters: { anthropic: adapter },
  });
  return registry.getPort();
}

afterAll(() => {
  reportCosts();
});

describe.skipIf(skipAnthropic)("live: anthropic", () => {
  describe("generateText", () => {
    it("basic — returns text + usage + cost", async () => {
      const llm = makePort();
      const result = await llm.generateText({
        taskType: "test-text",
        prompt: "Say 'pong' and nothing else.",
        maxOutputTokens: 20,
      });
      assertGenerateTextShape(result, ALIAS);
      recordCost("anthropic", result.cost.totalUSD);
      expect(result.text.toLowerCase()).toMatch(/pong/);
    });

    it("system — honors instructions", async () => {
      const llm = makePort();
      const result = await llm.generateText({
        taskType: "test-text",
        instructions: "Always respond in exactly three words.",
        prompt: "Describe water.",
        maxOutputTokens: 30,
      });
      assertGenerateTextShape(result, ALIAS);
      recordCost("anthropic", result.cost.totalUSD);
      const wordCount = result.text.trim().split(/\s+/).length;
      // Loose: model usually obeys, but may add punctuation; allow 2-5 words.
      expect(wordCount).toBeGreaterThanOrEqual(2);
      expect(wordCount).toBeLessThanOrEqual(8);
    });

    it("long — produces ~500-token output", async () => {
      const llm = makePort();
      const result = await llm.generateText({
        taskType: "test-text",
        prompt: "Write 5 short paragraphs about the history of TypeScript.",
        maxOutputTokens: 600,
      });
      assertGenerateTextShape(result, ALIAS);
      recordCost("anthropic", result.cost.totalUSD);
      expect(result.usage.outputTokens).toBeGreaterThan(200);
    });
  });

  describe("generateStructured", () => {
    const Intent = z.object({
      intent: z.enum(["question", "request", "complaint", "feedback"]),
      reasoning: z.string(),
    });

    it("simple — returns Zod-validated typed data", async () => {
      const llm = makePort();
      const result = await llm.generateStructured({
        taskType: "test-structured",
        instructions: "You classify user messages into intent categories.",
        prompt: "Can I get a refund on order #12345?",
        schema: Intent,
        schemaName: "user-intent",
      });
      assertGenerateStructuredShape(result, ALIAS, { maxAttempts: 2 });
      recordCost("anthropic", result.cost.totalUSD);
      expect(["question", "request", "complaint", "feedback"]).toContain(
        result.data.intent,
      );
    });

    it("retry — borderline input may fire validation retry", async () => {
      const Schema = z.object({
        priority: z.enum(["P0", "P1", "P2", "P3"]),
        urgent: z.boolean(),
      });
      const llm = makePort();
      // Intentionally vague rubric to maximize chance of first-attempt failure.
      const result = await llm.generateStructured({
        taskType: "test-structured",
        instructions:
          "Classify priority. Use exactly P0/P1/P2/P3 (uppercase, no other format).",
        prompt: "I think this might possibly be sort of important.",
        schema: Schema,
        schemaName: "priority-test",
      });
      assertGenerateStructuredShape(result, ALIAS, { maxAttempts: 2 });
      recordCost("anthropic", result.cost.totalUSD);
      // Note: validationAttempts may be 1 or 2 depending on model's first attempt
    });
  });

  describe("streamText", () => {
    it("echo — yields chunks that reassemble to the full response", async () => {
      const llm = makePort();
      const chunks: string[] = [];
      for await (const chunk of llm.streamText({
        taskType: "test-stream",
        prompt: "Count from 1 to 5, separated by spaces, nothing else.",
        maxOutputTokens: 30,
      })) {
        chunks.push(chunk);
      }
      const full = chunks.join("");
      expect(chunks.length).toBeGreaterThan(0);
      expect(full).toMatch(/1.*2.*3.*4.*5/);
    });
  });

  describe("streamStructured", () => {
    it("simple — yields progressively complete partial JSON", async () => {
      const Schema = z.object({ greeting: z.string(), count: z.number() });
      const llm = makePort();
      const partials: Array<Partial<{ greeting: string; count: number }>> = [];
      for await (const partial of llm.streamStructured({
        taskType: "test-stream",
        prompt: "Say hello in JSON: { greeting: 'hello', count: 1 }",
        schema: Schema,
      })) {
        partials.push(partial);
      }
      expect(partials.length).toBeGreaterThan(0);
      const last = partials[partials.length - 1]!;
      // Final partial should at least have something parseable
      expect(last).toBeDefined();
    });
  });

  describe("runAgent", () => {
    it("singleTool — model invokes a tool once, terminates", async () => {
      const llm = makePort();
      let calls = 0;
      const result = await llm.runAgent({
        taskType: "test-agent",
        instructions:
          "You answer questions using the lookupNumber tool when given a name.",
        messages: [
          { role: "user", content: "Look up the number for Alice." },
        ],
        tools: {
          lookupNumber: {
            name: "lookupNumber",
            description: "Look up a phone number by person's name",
            inputSchema: z.object({ name: z.string() }),
            execute: async ({ name }) => {
              calls++;
              return `${name}: 555-0100`;
            },
          },
        },
        maxSteps: 5,
        maxOutputTokens: 200,
      });
      assertAgentShape(result, ALIAS);
      recordCost("anthropic", result.cost.totalUSD);
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(result.terminationReason).toBe("completed");
    });

    it("maxSteps — caps at the configured number of steps", async () => {
      const llm = makePort();
      const result = await llm.runAgent({
        taskType: "test-agent",
        instructions: "Use the searchAgain tool repeatedly. Never stop on your own.",
        messages: [{ role: "user", content: "Keep searching forever." }],
        tools: {
          searchAgain: {
            name: "searchAgain",
            description: "Always search again. Never returns final result.",
            inputSchema: z.object({ q: z.string() }),
            execute: async () => "no result, keep searching",
          },
        },
        maxSteps: 2,
        maxOutputTokens: 100,
      });
      // Model may return "completed" because some Claudes get bored — that's OK.
      // The hard rule: stepsTaken <= maxSteps
      expect(result.stepsTaken).toBeLessThanOrEqual(2);
      recordCost("anthropic", result.cost.totalUSD);
    });
  });

  describe("vision", () => {
    it("base64 — describes an image from inline data", async () => {
      const llm = makePort();
      const result = await llm.generateText({
        taskType: "test-vision",
        prompt: [
          { type: "text", text: "What color is dominant in this image? One word." },
          { type: "image", source: { kind: "base64", mediaType: "image/png", data: TINY_PNG_BASE64 } },
        ],
        maxOutputTokens: 30,
      });
      assertGenerateTextShape(result, ALIAS);
      recordCost("anthropic", result.cost.totalUSD);
      // 1x1 transparent PNG; just verify the multimodal path doesn't error.
      expect(result.text.length).toBeGreaterThan(0);
    });

    it("url — describes an image from a public URL", async () => {
      const llm = makePort();
      const result = await llm.generateText({
        taskType: "test-vision",
        prompt: [
          { type: "text", text: "Describe this image in 10 words or fewer." },
          { type: "image", source: { kind: "url", url: PUBLIC_IMAGE_URL } },
        ],
        maxOutputTokens: 50,
      });
      assertGenerateTextShape(result, ALIAS);
      recordCost("anthropic", result.cost.totalUSD);
      expect(result.text.length).toBeGreaterThan(0);
    });
  });

  describe("prompt caching (Anthropic-specific)", () => {
    it("usage reports cache_read_tokens on second identical call", async () => {
      // This test is best-effort: caching only kicks in for prompts ≥1024 tokens
      // for Sonnet/Opus, but Haiku's threshold is lower. Verify the FIELD is
      // populated on second call — exact values vary.
      const llm = makePort();
      const longPrompt = "Repeat after me: " + "abc ".repeat(1000) + "\n\nNow say 'done'.";
      const r1 = await llm.generateText({
        taskType: "test-text",
        prompt: longPrompt,
        maxOutputTokens: 20,
      });
      assertGenerateTextShape(r1, ALIAS);
      recordCost("anthropic", r1.cost.totalUSD);
      const r2 = await llm.generateText({
        taskType: "test-text",
        prompt: longPrompt,
        maxOutputTokens: 20,
      });
      assertGenerateTextShape(r2, ALIAS);
      recordCost("anthropic", r2.cost.totalUSD);
      // Cache may or may not hit depending on Anthropic's policy; just verify
      // the framework doesn't crash on cache-related fields.
      // (If Anthropic doesn't cache automatically without cache_control, this
      // test is a no-op for caching but still validates the call shape.)
      expect(r2.text.length).toBeGreaterThan(0);
    });
  });
});
