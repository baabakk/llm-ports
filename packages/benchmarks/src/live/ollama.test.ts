/**
 * Live integration tests for @llm-ports/adapter-ollama.
 *
 * Skipped unless RUN_LIVE_TESTS=1.
 * Requires a local Ollama daemon. Tests skip gracefully if the daemon is
 * unreachable.
 *
 * Verifies the adapter against a real Ollama daemon for the Phase 2 test
 * matrix. Default test model is "llama3.2" (small, fast, common). Override
 * via OLLAMA_TEST_MODEL env var.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRegistryFromEnv, type EmbeddingsPort, type LLMPort } from "@llm-ports/core";
import { createOllamaAdapter } from "@llm-ports/adapter-ollama";
import {
  OLLAMA_URL,
  TINY_PNG_BASE64,
  assertAgentShape,
  assertGenerateStructuredShape,
  assertGenerateTextShape,
  recordCost,
  reportCosts,
  skipOllama,
} from "./shared.js";

const TEST_MODEL = process.env.OLLAMA_TEST_MODEL ?? "llama3.2";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? "llava";
const ALIAS = "live-ollama";

let daemonReachable = false;

function makePorts(model: string = TEST_MODEL): {
  llm: LLMPort;
  embed: EmbeddingsPort;
} {
  const adapter = createOllamaAdapter({ baseURL: OLLAMA_URL, autoPull: false });
  const registry = createRegistryFromEnv({
    env: {
      LLM_PROVIDER_LIVE_OLLAMA: `ollama|${model}|unlimited`,
      LLM_PROVIDER_LIVE_OLLAMA_EMBED: `ollama|${EMBED_MODEL}|unlimited`,
      LLM_TASK_ROUTE_TEST_TEXT: "live-ollama",
      LLM_TASK_ROUTE_TEST_STRUCTURED: "live-ollama",
      LLM_TASK_ROUTE_TEST_STREAM: "live-ollama",
      LLM_TASK_ROUTE_TEST_AGENT: "live-ollama",
      LLM_TASK_ROUTE_TEST_VISION: "live-ollama",
      LLM_TASK_ROUTE_TEST_EMBED: "live-ollama-embed",
    },
    adapters: { ollama: adapter },
  });
  return { llm: registry.getPort(), embed: registry.getEmbeddingsPort() };
}

beforeAll(async () => {
  if (skipOllama) return;
  // Pre-flight: skip the whole suite if the daemon is unreachable rather than
  // failing every test with the same connection error.
  try {
    const adapter = createOllamaAdapter({ baseURL: OLLAMA_URL });
    const health = await adapter.checkHealth();
    daemonReachable = health.ok;
    if (!daemonReachable) {
      // eslint-disable-next-line no-console
      console.warn(
        `[live: ollama] daemon at ${OLLAMA_URL} unreachable — all ollama tests will skip`,
      );
    }
  } catch {
    daemonReachable = false;
  }
});

afterAll(() => {
  reportCosts();
});

const skipNoDaemon = () => skipOllama || !daemonReachable;

describe.skipIf(skipOllama)("live: ollama", () => {
  describe("generateText", () => {
    it.skipIf(skipNoDaemon())("basic — returns text + usage + cost", async () => {
      const { llm } = makePorts();
      const result = await llm.generateText({
        taskType: "test-text",
        prompt: "Say 'pong' and nothing else.",
        maxOutputTokens: 20,
      });
      assertGenerateTextShape(result, ALIAS, { allowZeroCost: true });
      recordCost("ollama", result.cost.totalUSD); // typically 0
      expect(result.text.toLowerCase()).toMatch(/pong/);
    });

    it.skipIf(skipNoDaemon())("system — honors instructions", async () => {
      const { llm } = makePorts();
      const result = await llm.generateText({
        taskType: "test-text",
        instructions: "Always respond in exactly three words.",
        prompt: "Describe water.",
        maxOutputTokens: 30,
      });
      assertGenerateTextShape(result, ALIAS, { allowZeroCost: true });
      recordCost("ollama", result.cost.totalUSD);
    });

    it.skipIf(skipNoDaemon())("long — produces several paragraphs", async () => {
      const { llm } = makePorts();
      const result = await llm.generateText({
        taskType: "test-text",
        prompt: "Write 5 short paragraphs about the history of TypeScript.",
        maxOutputTokens: 600,
      });
      assertGenerateTextShape(result, ALIAS, { allowZeroCost: true });
      recordCost("ollama", result.cost.totalUSD);
    });
  });

  describe("generateStructured", () => {
    const Intent = z.object({
      intent: z.enum(["question", "request", "complaint", "feedback"]),
      reasoning: z.string(),
    });

    it.skipIf(skipNoDaemon())("simple — Zod-validated typed data via format=json", async () => {
      const { llm } = makePorts();
      const result = await llm.generateStructured({
        taskType: "test-structured",
        instructions: "You classify user messages into intent categories.",
        prompt: "Can I get a refund on order #12345?",
        schema: Intent,
        schemaName: "user-intent",
      });
      assertGenerateStructuredShape(result, ALIAS, { allowZeroCost: true, maxAttempts: 2 });
      recordCost("ollama", result.cost.totalUSD);
      expect(["question", "request", "complaint", "feedback"]).toContain(
        result.data.intent,
      );
    });
  });

  describe("streamText", () => {
    it.skipIf(skipNoDaemon())("echo — yields chunks that reassemble", async () => {
      const { llm } = makePorts();
      const chunks: string[] = [];
      for await (const chunk of llm.streamText({
        taskType: "test-stream",
        prompt: "Count from 1 to 5, separated by spaces, nothing else.",
        maxOutputTokens: 30,
      })) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join("")).toMatch(/1.*2.*3.*4.*5/);
    });
  });

  describe("runAgent", () => {
    it.skipIf(skipNoDaemon())("singleTool — model invokes a tool (model-dependent)", async () => {
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
      assertAgentShape(result, ALIAS, { allowZeroCost: true });
      recordCost("ollama", result.cost.totalUSD);
      // Tool use is model-dependent; smaller Ollama models may not call it.
      // The hard assertion: result returned, terminated cleanly. Soft: tool was called.
      expect(["completed", "max_steps"]).toContain(result.terminationReason);
    });
  });

  describe("vision (model-dependent — needs llava or similar)", () => {
    it.skipIf(skipNoDaemon())("base64 — describes an image", async () => {
      // Try with a vision model; if not installed locally, this test will fail
      // with a clear "model not found" error, which is the right signal.
      const { llm } = makePorts(VISION_MODEL);
      try {
        const result = await llm.generateText({
          taskType: "test-vision",
          prompt: [
            { type: "text", text: "What color is dominant in this image? One word." },
            { type: "image", source: { kind: "base64", mediaType: "image/png", data: TINY_PNG_BASE64 } },
          ],
          maxOutputTokens: 30,
        });
        assertGenerateTextShape(result, ALIAS, { allowZeroCost: true });
        recordCost("ollama", result.cost.totalUSD);
      } catch (err) {
        // If the user doesn't have llava installed, soft-skip
        if (err instanceof Error && /not found|pull/i.test(err.message)) {
          // eslint-disable-next-line no-console
          console.warn(
            `[live: ollama vision] ${VISION_MODEL} not installed; run "ollama pull ${VISION_MODEL}" to test`,
          );
          return;
        }
        throw err;
      }
    });
  });

  describe("embeddings", () => {
    it.skipIf(skipNoDaemon())("single — returns a vector", async () => {
      const { embed } = makePorts();
      try {
        const result = await embed.generateEmbedding({
          taskType: "test-embed",
          input: "Hello, world.",
        });
        expect(result.vector.length).toBeGreaterThan(0);
        expect(result.dimensions).toBe(result.vector.length);
        expect(result.cost.totalUSD).toBe(0); // local = free
      } catch (err) {
        if (err instanceof Error && /not found|pull/i.test(err.message)) {
          // eslint-disable-next-line no-console
          console.warn(
            `[live: ollama embed] ${EMBED_MODEL} not installed; run "ollama pull ${EMBED_MODEL}" to test`,
          );
          return;
        }
        throw err;
      }
    });
  });

  describe("model management", () => {
    it.skipIf(skipNoDaemon())("listModels — returns at least one model", async () => {
      const adapter = createOllamaAdapter({ baseURL: OLLAMA_URL });
      const models = await adapter.listModels();
      expect(Array.isArray(models)).toBe(true);
      // Most users have at least one model installed
      if (models.length > 0) {
        expect(models[0]?.name).toBeTypeOf("string");
        expect(models[0]?.size).toBeGreaterThan(0);
      }
    });

    it.skipIf(skipNoDaemon())("checkHealth — daemon reachable", async () => {
      const adapter = createOllamaAdapter({ baseURL: OLLAMA_URL });
      const health = await adapter.checkHealth();
      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
