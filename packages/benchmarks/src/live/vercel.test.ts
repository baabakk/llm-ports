/**
 * Live integration tests for @llm-ports/adapter-vercel.
 *
 * Skipped unless RUN_LIVE_TESTS=1 AND at least one of ANTHROPIC_API_KEY /
 * OPENAI_API_KEY is set.
 *
 * The Vercel adapter accepts pre-configured Vercel LanguageModel instances,
 * so this test exercises both providers (Anthropic, OpenAI) through the
 * Vercel adapter to validate the same shape works for both.
 */

import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createRegistryFromEnv, type LLMPort } from "@llm-ports/core";
import { createVercelAdapter } from "@llm-ports/adapter-vercel";
import {
  ANTHROPIC_KEY,
  OPENAI_KEY,
  assertGenerateStructuredShape,
  assertGenerateTextShape,
  recordCost,
  reportCosts,
  skipAnthropic,
  skipOpenAI,
} from "./shared.js";

afterAll(() => {
  reportCosts();
});

describe.skipIf(skipAnthropic)("live: vercel adapter (with Anthropic model)", () => {
  const ALIAS = "live-vercel-anthropic";

  function makePort(): LLMPort {
    process.env["ANTHROPIC_API_KEY"] = ANTHROPIC_KEY ?? "missing";
    const adapter = createVercelAdapter({
      models: { "claude-haiku-4-5": anthropic("claude-haiku-4-5") },
      pricing: {
        "claude-haiku-4-5": { inputPer1M: 0.8, outputPer1M: 4.0 },
      },
    });
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_LIVE_VERCEL_ANTHROPIC: "vercel|claude-haiku-4-5|unlimited",
        LLM_TASK_ROUTE_TEST_TEXT: "live-vercel-anthropic",
        LLM_TASK_ROUTE_TEST_STRUCTURED: "live-vercel-anthropic",
        LLM_TASK_ROUTE_TEST_STREAM: "live-vercel-anthropic",
      },
      adapters: { vercel: adapter },
    });
    return registry.getPort();
  }

  it("generateText.basic", async () => {
    const llm = makePort();
    const result = await llm.generateText({
      taskType: "test-text",
      prompt: "Say 'pong' and nothing else.",
      maxOutputTokens: 20,
    });
    assertGenerateTextShape(result, ALIAS);
    recordCost("vercel-anthropic", result.cost.totalUSD);
    expect(result.text.toLowerCase()).toMatch(/pong/);
  });

  it("generateStructured.simple", async () => {
    const Intent = z.object({
      intent: z.enum(["question", "request", "complaint", "feedback"]),
      reasoning: z.string(),
    });
    const llm = makePort();
    const result = await llm.generateStructured({
      taskType: "test-structured",
      instructions: "Classify user intent.",
      prompt: "Can I get a refund?",
      schema: Intent,
      schemaName: "user-intent",
    });
    assertGenerateStructuredShape(result, ALIAS, { maxAttempts: 2 });
    recordCost("vercel-anthropic", result.cost.totalUSD);
  });

  it("streamText.echo", async () => {
    const llm = makePort();
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

describe.skipIf(skipOpenAI)("live: vercel adapter (with OpenAI model)", () => {
  const ALIAS = "live-vercel-openai";

  function makePort(): LLMPort {
    process.env["OPENAI_API_KEY"] = OPENAI_KEY ?? "missing";
    const adapter = createVercelAdapter({
      models: { "gpt-5-nano": openai("gpt-5-nano") },
      pricing: {
        "gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.2 },
      },
    });
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_LIVE_VERCEL_OPENAI: "vercel|gpt-5-nano|unlimited",
        LLM_TASK_ROUTE_TEST_TEXT_OPENAI: "live-vercel-openai",
        LLM_TASK_ROUTE_TEST_STRUCTURED_OPENAI: "live-vercel-openai",
        LLM_TASK_ROUTE_TEST_STREAM_OPENAI: "live-vercel-openai",
      },
      adapters: { vercel: adapter },
    });
    return registry.getPort();
  }

  it("generateText.basic", async () => {
    const llm = makePort();
    const result = await llm.generateText({
      taskType: "test-text-openai",
      prompt: "Say 'pong' and nothing else.",
      maxOutputTokens: 20,
    });
    assertGenerateTextShape(result, ALIAS);
    recordCost("vercel-openai", result.cost.totalUSD);
    expect(result.text.toLowerCase()).toMatch(/pong/);
  });

  it("generateStructured.simple", async () => {
    const Intent = z.object({
      intent: z.enum(["question", "request", "complaint", "feedback"]),
      reasoning: z.string(),
    });
    const llm = makePort();
    const result = await llm.generateStructured({
      taskType: "test-structured-openai",
      instructions: "Classify user intent.",
      prompt: "Can I get a refund?",
      schema: Intent,
      schemaName: "user-intent",
    });
    assertGenerateStructuredShape(result, ALIAS, { maxAttempts: 2 });
    recordCost("vercel-openai", result.cost.totalUSD);
  });

  it("streamText.echo", async () => {
    const llm = makePort();
    const chunks: string[] = [];
    for await (const chunk of llm.streamText({
      taskType: "test-stream-openai",
      prompt: "Count from 1 to 5, separated by spaces, nothing else.",
      maxOutputTokens: 30,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });
});
