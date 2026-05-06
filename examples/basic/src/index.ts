/**
 * llm-ports — basic example.
 *
 * Demonstrates the smallest possible end-to-end flow:
 *   1. Wire a single adapter (Anthropic Claude Haiku)
 *   2. Build a registry from env-style config
 *   3. Call generateText through the typed LLMPort
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @llm-ports/example-basic start
 *
 * The point: your application code (the call to `llm.generateText`) is
 * SDK-free. Swap providers by changing the adapter wiring; no business-logic
 * file imports `@anthropic-ai/sdk` directly.
 */

import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY before running this example.");
  process.exit(1);
}

// Adapter wiring — the only file in your app that imports Anthropic's SDK.
const adapter = createAnthropicAdapter({ apiKey });

// Registry: tells llm-ports about the providers you have and which task
// types route to them. Format: ALIAS=adapter|model|budgetSpec
//   - adapter: which adapter handles this provider ("anthropic" matches the
//     key under `adapters` below)
//   - model: the model id (here, Claude Haiku 4.5 — fastest, cheapest)
//   - budgetSpec: "unlimited" | "req:N/window" | "cost:USD/window"
//                 (windows: hour | day | month)
const registry = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|cost:1/day",
    LLM_TASK_ROUTE_GREETING: "fast",
  },
  adapters: { anthropic: adapter },
});

const llm = registry.getPort();

// Application code — completely SDK-free.
const result = await llm.generateText({
  taskType: "greeting",
  prompt: "In exactly one sentence, greet a TypeScript developer.",
  maxOutputTokens: 100,
});

console.log("Generated text:", result.text);
console.log("Usage:", result.usage);
console.log("Cost (USD):", result.cost.totalUSD.toFixed(6));
console.log("Latency (ms):", result.latencyMs);
console.log("Provider alias:", result.providerAlias);
console.log("Model:", result.modelId);
