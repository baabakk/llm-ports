/**
 * Live integration tests for @llm-ports/adapter-openai.
 *
 * Skipped unless RUN_LIVE_TESTS=1 AND OPENAI_API_KEY is set.
 * Compat-provider tests (Groq, Cerebras) skip independently if their keys
 * aren't set, so a partial test run is supported.
 *
 * Verifies the adapter against the real OpenAI API (and OpenAI-compatible
 * providers) for the Phase 2 test matrix.
 */

import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRegistryFromEnv, type LLMPort, type EmbeddingsPort } from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";
import {
  CEREBRAS_KEY,
  GROQ_KEY,
  OPENAI_KEY,
  PUBLIC_IMAGE_URL,
  TINY_PNG_BASE64,
  assertAgentShape,
  assertGenerateStructuredShape,
  assertGenerateTextShape,
  recordCost,
  reportCosts,
  skipCerebras,
  skipGroq,
  skipOpenAI,
} from "./shared.js";

const MODEL = "gpt-5-nano";              // smallest, cheapest
const EMBED_MODEL = "text-embedding-3-small";
const ALIAS = "live-openai";

function makePorts(): { llm: LLMPort; embed: EmbeddingsPort } {
  const adapter = createOpenAIAdapter({ apiKey: OPENAI_KEY ?? "missing" });
  const registry = createRegistryFromEnv({
    env: {
      LLM_PROVIDER_LIVE_OPENAI: `openai|${MODEL}|unlimited`,
      LLM_PROVIDER_LIVE_OPENAI_EMBED: `openai|${EMBED_MODEL}|unlimited`,
      LLM_TASK_ROUTE_TEST_TEXT: "live-openai",
      LLM_TASK_ROUTE_TEST_STRUCTURED: "live-openai",
      LLM_TASK_ROUTE_TEST_STREAM: "live-openai",
      LLM_TASK_ROUTE_TEST_AGENT: "live-openai",
      LLM_TASK_ROUTE_TEST_VISION: "live-openai",
      LLM_TASK_ROUTE_TEST_EMBED: "live-openai-embed",
    },
    adapters: { openai: adapter },
  });
  return { llm: registry.getPort(), embed: registry.getEmbeddingsPort() };
}

afterAll(() => {
  reportCosts();
});

describe.skipIf(skipOpenAI)("live: openai", () => {
  describe("generateText", () => {
    it("basic — returns text + usage + cost", async () => {
      const { llm } = makePorts();
      const result = await llm.generateText({
        taskType: "test-text",
        prompt: "Say 'pong' and nothing else.",
        maxOutputTokens: 20,
      });
      assertGenerateTextShape(result, ALIAS);
      recordCost("openai", result.cost.totalUSD);
      expect(result.text.toLowerCase()).toMatch(/pong/);
    });

    it("system — honors instructions", async () => {
      const { llm } = makePorts();
      const result = await llm.generateText({
        taskType: "test-text",
        instructions: "Always respond in exactly three words.",
        prompt: "Describe water.",
        maxOutputTokens: 30,
      });
      assertGenerateTextShape(result, ALIAS);
      recordCost("openai", result.cost.totalUSD);
      const wordCount = result.text.trim().split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(2);
      expect(wordCount).toBeLessThanOrEqual(8);
    });

    it("long — produces ~500-token output", async () => {
      const { llm } = makePorts();
      const result = await llm.generateText({
        taskType: "test-text",
        prompt: "Write 5 short paragraphs about the history of TypeScript.",
        maxOutputTokens: 600,
      });
      assertGenerateTextShape(result, ALIAS);
      recordCost("openai", result.cost.totalUSD);
      expect(result.usage.outputTokens).toBeGreaterThan(200);
    });
  });

  describe("generateStructured", () => {
    const Intent = z.object({
      intent: z.enum(["question", "request", "complaint", "feedback"]),
      reasoning: z.string(),
    });

    it("simple — returns Zod-validated typed data via native JSON mode", async () => {
      const { llm } = makePorts();
      const result = await llm.generateStructured({
        taskType: "test-structured",
        instructions: "You classify user messages into intent categories.",
        prompt: "Can I get a refund on order #12345?",
        schema: Intent,
        schemaName: "user-intent",
      });
      assertGenerateStructuredShape(result, ALIAS, { maxAttempts: 2 });
      recordCost("openai", result.cost.totalUSD);
      expect(["question", "request", "complaint", "feedback"]).toContain(
        result.data.intent,
      );
    });

    it("retry — borderline input may fire validation retry", async () => {
      const Schema = z.object({
        priority: z.enum(["P0", "P1", "P2", "P3"]),
        urgent: z.boolean(),
      });
      const { llm } = makePorts();
      const result = await llm.generateStructured({
        taskType: "test-structured",
        instructions: "Use exactly P0/P1/P2/P3 (uppercase).",
        prompt: "I think this might possibly be sort of important.",
        schema: Schema,
        schemaName: "priority-test",
      });
      assertGenerateStructuredShape(result, ALIAS, { maxAttempts: 2 });
      recordCost("openai", result.cost.totalUSD);
    });
  });

  describe("streamText", () => {
    it("echo — yields chunks that reassemble", async () => {
      const { llm } = makePorts();
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
      const { llm } = makePorts();
      const partials: Array<Partial<{ greeting: string; count: number }>> = [];
      for await (const partial of llm.streamStructured({
        taskType: "test-stream",
        prompt: "Say hello in JSON: { greeting: 'hello', count: 1 }",
        schema: Schema,
      })) {
        partials.push(partial);
      }
      expect(partials.length).toBeGreaterThan(0);
    });
  });

  describe("runAgent", () => {
    it("singleTool — model invokes a tool once, terminates", async () => {
      const { llm } = makePorts();
      let calls = 0;
      const result = await llm.runAgent({
        taskType: "test-agent",
        instructions:
          "You answer questions using the lookupNumber tool when given a name.",
        messages: [{ role: "user", content: "Look up the number for Alice." }],
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
      recordCost("openai", result.cost.totalUSD);
      expect(calls).toBeGreaterThanOrEqual(1);
    });

    it("maxSteps — caps at the configured number of steps", async () => {
      const { llm } = makePorts();
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
      expect(result.stepsTaken).toBeLessThanOrEqual(2);
      recordCost("openai", result.cost.totalUSD);
    });
  });

  describe("vision", () => {
    it("base64 (data URI) — describes an image from inline data", async () => {
      const { llm } = makePorts();
      const result = await llm.generateText({
        taskType: "test-vision",
        prompt: [
          { type: "text", text: "What color is dominant in this image? One word." },
          { type: "image", source: { kind: "base64", mediaType: "image/png", data: TINY_PNG_BASE64 } },
        ],
        maxOutputTokens: 30,
      });
      assertGenerateTextShape(result, ALIAS);
      recordCost("openai", result.cost.totalUSD);
      expect(result.text.length).toBeGreaterThan(0);
    });

    it("url — describes an image from a public URL", async () => {
      const { llm } = makePorts();
      const result = await llm.generateText({
        taskType: "test-vision",
        prompt: [
          { type: "text", text: "Describe this image in 10 words or fewer." },
          { type: "image", source: { kind: "url", url: PUBLIC_IMAGE_URL } },
        ],
        maxOutputTokens: 50,
      });
      assertGenerateTextShape(result, ALIAS);
      recordCost("openai", result.cost.totalUSD);
      expect(result.text.length).toBeGreaterThan(0);
    });
  });

  describe("embeddings", () => {
    it("single — returns a vector of expected dimensions", async () => {
      const { embed } = makePorts();
      const result = await embed.generateEmbedding({
        taskType: "test-embed",
        input: "Hello, world.",
      });
      expect(result.vector).toHaveLength(1536); // text-embedding-3-small default
      expect(result.dimensions).toBe(1536);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.cost.totalUSD).toBeGreaterThan(0);
      recordCost("openai", result.cost.totalUSD);
    });

    it("batch — returns matching vectors", async () => {
      const { embed } = makePorts();
      const result = await embed.generateEmbeddings({
        taskType: "test-embed",
        inputs: ["one", "two", "three"],
      });
      expect(result.vectors).toHaveLength(3);
      expect(result.dimensions).toBe(1536);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      recordCost("openai", result.cost.totalUSD);
    });
  });
});

// ─── OpenAI-compatible providers ──────────────────────────────────────

describe.skipIf(skipGroq)("live: groq (via openai adapter + baseURL)", () => {
  it("basic generateText routes correctly through the compat baseURL", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: GROQ_KEY ?? "missing",
      baseURL: "https://api.groq.com/openai/v1",
      pricingOverrides: {
        "llama-3.3-70b-versatile": { inputPer1M: 0.59, outputPer1M: 0.79 },
      },
    });
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_LIVE_GROQ: "openai|llama-3.3-70b-versatile|unlimited",
        LLM_TASK_ROUTE_TEST_GROQ: "live-groq",
      },
      adapters: { openai: adapter },
    });
    const llm = registry.getPort();
    const result = await llm.generateText({
      taskType: "test-groq",
      prompt: "Say 'pong' and nothing else.",
      maxOutputTokens: 20,
    });
    assertGenerateTextShape(result, "live-groq");
    recordCost("groq", result.cost.totalUSD);
    expect(result.text.toLowerCase()).toMatch(/pong/);
  });
});

describe.skipIf(skipCerebras)("live: cerebras (via openai adapter + baseURL)", () => {
  it("basic generateText routes correctly through the compat baseURL", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: CEREBRAS_KEY ?? "missing",
      baseURL: "https://api.cerebras.ai/v1",
      pricingOverrides: {
        "llama-4-scout-17b-16e-instruct": { inputPer1M: 0.65, outputPer1M: 0.85 },
      },
    });
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_LIVE_CEREBRAS:
          "openai|llama-4-scout-17b-16e-instruct|unlimited",
        LLM_TASK_ROUTE_TEST_CEREBRAS: "live-cerebras",
      },
      adapters: { openai: adapter },
    });
    const llm = registry.getPort();
    const result = await llm.generateText({
      taskType: "test-cerebras",
      prompt: "Say 'pong' and nothing else.",
      maxOutputTokens: 20,
    });
    assertGenerateTextShape(result, "live-cerebras");
    recordCost("cerebras", result.cost.totalUSD);
    expect(result.text.toLowerCase()).toMatch(/pong/);
  });
});
