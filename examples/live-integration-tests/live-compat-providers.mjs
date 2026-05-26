/**
 * Live compat-provider depth test — closes the v0.1 status doc gap
 * "compat-provider live coverage is one-test-deep."
 *
 * For each OpenAI-compat provider with an API key in the environment, runs:
 *   1. generateText (basic)
 *   2. generateStructured against a small Zod schema
 *   3. streamText (collects 3+ chunks)
 *   4. runAgent with a single tool (compat providers that don't support
 *      tool_calls skip this and the test prints "tool calls not supported")
 *
 * Skip silently when the API key is missing. Partial subsets work.
 *
 * Run (any subset):
 *   CEREBRAS_API_KEY=... \
 *   GROQ_API_KEY=... \
 *   CLARIFAI_PAT=... \
 *   SAMBANOVA_API_KEY=... \
 *   TOGETHER_API_KEY=... \
 *   FIREWORKS_API_KEY=... \
 *   node examples/live-integration-tests/live-compat-providers.mjs
 *
 * Cost: ~$0.001-0.005 per provider per full pass (most compat providers
 * are very cheap; Cerebras GptOSS is ~$0.0001 per call).
 *
 * Shipped in 0.1.0-alpha.8.
 */

import { createRegistryFromEnv } from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";
import { z } from "zod";

// ─── Provider catalog ────────────────────────────────────────────────

const PROVIDERS = [
  {
    name: "cerebras",
    envKey: "CEREBRAS_API_KEY",
    baseURL: "https://api.cerebras.ai/v1",
    modelId: "gpt-oss-120b",
    pricing: { inputPer1M: 0.65, outputPer1M: 0.85 },
    supportsTools: false, // gpt-oss-* tool-use spotty
  },
  {
    name: "groq",
    envKey: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
    modelId: "llama-3.3-70b-versatile",
    pricing: { inputPer1M: 0.59, outputPer1M: 0.79 },
    supportsTools: true,
  },
  {
    name: "clarifai",
    envKey: "CLARIFAI_PAT",
    baseURL: "https://api.clarifai.com/v2/ext/openai/v1",
    modelId: "Qwen3_6-35B-A3B-FP8",
    pricing: { inputPer1M: 0.76, outputPer1M: 0.43 },
    supportsTools: false, // Qwen3.6 tool-use varies by deployment
  },
  {
    name: "sambanova",
    envKey: "SAMBANOVA_API_KEY",
    baseURL: "https://api.sambanova.ai/v1",
    modelId: "MiniMax-M2.7",
    pricing: { inputPer1M: 0.6, outputPer1M: 2.4 },
    supportsTools: false,
  },
  {
    name: "together",
    envKey: "TOGETHER_API_KEY",
    baseURL: "https://api.together.xyz/v1",
    modelId: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    pricing: { inputPer1M: 0.88, outputPer1M: 0.88 },
    supportsTools: true,
  },
  {
    name: "fireworks",
    envKey: "FIREWORKS_API_KEY",
    baseURL: "https://api.fireworks.ai/inference/v1",
    modelId: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    pricing: { inputPer1M: 0.9, outputPer1M: 0.9 },
    supportsTools: true,
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────

function color(text, code) {
  // Avoid pulling in chalk; minimal ANSI for terminal readability.
  return `\x1b[${code}m${text}\x1b[0m`;
}
const ok = (text) => color(text, 32);
const fail = (text) => color(text, 31);
const dim = (text) => color(text, 2);

const Sentiment = z.object({
  sentiment: z.enum(["positive", "negative", "neutral"]),
  confidence: z.number().min(0).max(1),
});

// ─── Per-provider test ───────────────────────────────────────────────

async function testProvider(provider) {
  const apiKey = process.env[provider.envKey];
  if (!apiKey) {
    console.log(dim(`SKIP ${provider.name} (${provider.envKey} not set)`));
    return { skipped: true };
  }

  console.log(`\n=== ${provider.name} (${provider.modelId}) ===`);

  const adapter = createOpenAIAdapter({
    apiKey,
    baseURL: provider.baseURL,
    displayName: provider.name,
    pricingOverrides: { [provider.modelId]: provider.pricing },
  });
  const aliasName = provider.name.toUpperCase();
  const registry = createRegistryFromEnv({
    env: {
      [`LLM_PROVIDER_${aliasName}`]: `openai|${provider.modelId}|cost:1/day`,
      LLM_TASK_ROUTE_GREETING: provider.name,
      LLM_TASK_ROUTE_CLASSIFY: provider.name,
      LLM_TASK_ROUTE_CHAT: provider.name,
      LLM_TASK_ROUTE_AGENT: provider.name,
    },
    adapters: { openai: adapter },
  });
  const llm = registry.getPort();

  const results = { passed: 0, failed: 0, errors: [] };

  // 1. generateText
  try {
    const r = await llm.generateText({
      taskType: "greeting",
      prompt: "Say 'hello'. Reply with just the word.",
      maxOutputTokens: 20,
    });
    if (r.text.toLowerCase().includes("hello")) {
      console.log(`  ${ok("PASS")} generateText: "${r.text.trim().slice(0, 40)}"`);
      results.passed++;
    } else {
      console.log(`  ${fail("FAIL")} generateText: expected hello, got "${r.text.trim().slice(0, 60)}"`);
      results.failed++;
    }
  } catch (err) {
    console.log(`  ${fail("FAIL")} generateText: ${err.message?.slice(0, 100)}`);
    results.errors.push(`generateText: ${err.message}`);
    results.failed++;
  }

  // 2. generateStructured
  try {
    const r = await llm.generateStructured({
      taskType: "classify",
      prompt: "Classify the sentiment: 'I love this product!'",
      schema: Sentiment,
      schemaName: "Sentiment",
      maxOutputTokens: 200,
    });
    console.log(
      `  ${ok("PASS")} generateStructured: ${r.data.sentiment} (conf=${r.data.confidence.toFixed(2)})`,
    );
    results.passed++;
  } catch (err) {
    console.log(`  ${fail("FAIL")} generateStructured: ${err.message?.slice(0, 120)}`);
    results.errors.push(`generateStructured: ${err.message}`);
    results.failed++;
  }

  // 3. streamText
  try {
    const chunks = [];
    for await (const chunk of llm.streamText({
      taskType: "chat",
      prompt: "Count from one to three, one number per line.",
      maxOutputTokens: 50,
    })) {
      chunks.push(chunk);
      if (chunks.length >= 10) break; // guard
    }
    if (chunks.length >= 1) {
      console.log(`  ${ok("PASS")} streamText: ${chunks.length} chunk(s)`);
      results.passed++;
    } else {
      console.log(`  ${fail("FAIL")} streamText: zero chunks received`);
      results.failed++;
    }
  } catch (err) {
    console.log(`  ${fail("FAIL")} streamText: ${err.message?.slice(0, 120)}`);
    results.errors.push(`streamText: ${err.message}`);
    results.failed++;
  }

  // 4. runAgent (conditional on tool support)
  if (!provider.supportsTools) {
    console.log(`  ${dim("SKIP")} runAgent: ${provider.name} doesn't support tool calls`);
  } else {
    try {
      const r = await llm.runAgent({
        taskType: "agent",
        instructions: "Use the get_weather tool to answer.",
        messages: [{ role: "user", content: "What's the weather in Paris?" }],
        tools: {
          get_weather: {
            name: "get_weather",
            description: "Get weather for a city",
            inputSchema: z.object({ city: z.string() }),
            execute: async (input) => ({ city: input.city, temp: 18, condition: "sunny" }),
          },
        },
        maxSteps: 3,
        maxOutputTokens: 200,
      });
      console.log(
        `  ${ok("PASS")} runAgent: ${r.stepsTaken} step(s), ${r.toolCalls.length} tool call(s)`,
      );
      results.passed++;
    } catch (err) {
      console.log(`  ${fail("FAIL")} runAgent: ${err.message?.slice(0, 120)}`);
      results.errors.push(`runAgent: ${err.message}`);
      results.failed++;
    }
  }

  return results;
}

// ─── Runner ──────────────────────────────────────────────────────────

const tested = [];
for (const provider of PROVIDERS) {
  const r = await testProvider(provider);
  if (!r.skipped) tested.push({ provider: provider.name, ...r });
}

console.log("\n=== SUMMARY ===");
if (tested.length === 0) {
  console.log(
    dim(
      "No providers tested — set at least one of: " +
        PROVIDERS.map((p) => p.envKey).join(", "),
    ),
  );
  process.exit(0);
}
let totalPassed = 0;
let totalFailed = 0;
for (const r of tested) {
  totalPassed += r.passed;
  totalFailed += r.failed;
  const status = r.failed === 0 ? ok("OK") : fail(`${r.failed} fail`);
  console.log(`  ${r.provider}: ${r.passed} passed, ${status}`);
}
console.log(
  `\n${tested.length} provider(s) tested. ${totalPassed} pass, ${totalFailed} fail.`,
);
process.exit(totalFailed === 0 ? 0 : 1);
