/**
 * Live API-backed Gate C smoke test against the PUBLISHED packages.
 *
 * Confirms that a fresh project installing @llm-ports/{core,adapter-openai}
 * from real npm can make a real OpenAI call end-to-end and get back:
 *   - typed text output
 *   - exact USD cost
 *   - exact model id the request hit
 *   - latency
 *
 * This is the 60-second example Gate C requires (PUBLISHING-CHECKLIST line 95).
 *
 * Run:
 *   OPENAI_API_KEY=sk-... node live.mjs
 *
 * Cost: ~$0.0001 per run (one short generateText + one short generateStructured).
 */

import { createRegistryFromEnv } from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";
import { z } from "zod";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Set OPENAI_API_KEY before running this test.");
  process.exit(1);
}

const adapter = createOpenAIAdapter({ apiKey });
const registry = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_FAST: "openai|gpt-4o-mini|cost:1/day",
    LLM_TASK_ROUTE_GREETING: "fast",
    LLM_TASK_ROUTE_CLASSIFY: "fast",
  },
  adapters: { openai: adapter },
});
const llm = registry.getPort();

console.log("--- live generateText ---");
const t0 = Date.now();
const greeting = await llm.generateText({
  taskType: "greeting",
  prompt: "In exactly one sentence, greet a TypeScript developer.",
  maxOutputTokens: 80,
});
console.log("  text:    ", greeting.text.trim());
console.log("  model:   ", greeting.modelId);
console.log("  provider:", greeting.providerAlias);
console.log(
  "  usage:   ",
  `${greeting.usage.inputTokens} in + ${greeting.usage.outputTokens} out = ${greeting.usage.totalTokens} tokens`,
);
console.log("  cost USD:", greeting.cost.totalUSD.toFixed(8));
console.log("  latency: ", greeting.latencyMs, "ms");

console.log("\n--- live generateStructured (typed extraction) ---");
const Classification = z.object({
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  reasoning: z.string().min(10),
});
const s0 = Date.now();
const classification = await llm.generateStructured({
  taskType: "classify",
  prompt:
    "Classify this support email priority: 'Our production API has been down for 20 minutes. Need immediate help.'",
  schema: Classification,
  schemaName: "support-priority",
  maxOutputTokens: 200,
});
console.log("  parsed:   ", classification.data);
console.log("  model:    ", classification.modelId);
console.log("  attempts: ", classification.validationAttempts);
console.log("  cost USD: ", classification.cost.totalUSD.toFixed(8));
console.log("  latency:  ", classification.latencyMs, "ms");

const totalCost = greeting.cost.totalUSD + classification.cost.totalUSD;
const totalLatency = (Date.now() - t0);

console.log("\n--- summary ---");
console.log(`  total cost:    $${totalCost.toFixed(8)}`);
console.log(`  total latency: ${totalLatency} ms`);
console.log(`  packages:      @llm-ports/core + @llm-ports/adapter-openai (workspace)`);
console.log("  ✓ 60-second example works end-to-end against real OpenAI");
