/**
 * llm-ports — multi-provider example.
 *
 * Demonstrates the three load-bearing features once you have more than one
 * provider:
 *
 *   1. Fallback chain        — primary fast cheap model; fall back to a
 *                              backup if the primary's budget is exhausted
 *                              or it's unavailable
 *   2. USD cost gating       — per-provider hourly/daily/monthly caps
 *                              enforced before the API call, not after
 *   3. Capability factories  — define "classify intent" once, reuse it
 *                              across the codebase. Improving the prompt
 *                              improves every call site.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   OPENAI_API_KEY=sk-... \
 *   pnpm --filter @llm-ports/example-multi-provider start
 *
 * If only one key is set, the example still runs — the missing provider
 * will fail at request time and the chain falls back to the other.
 */

import { z } from "zod";
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";
import { createClassifier } from "@llm-ports/capabilities";

// ─── Adapter wiring (the only files that import LLM SDKs) ────────────

const anthropicKey = process.env["ANTHROPIC_API_KEY"];
const openaiKey = process.env["OPENAI_API_KEY"];

if (!anthropicKey && !openaiKey) {
  console.error(
    "Set at least one of ANTHROPIC_API_KEY / OPENAI_API_KEY before running.",
  );
  process.exit(1);
}

// ─── Registry: two providers, one fallback chain, USD-denominated caps ─

const registry = createRegistryFromEnv({
  env: {
    // PRIMARY: Anthropic Claude Haiku — fastest, cheapest. Capped at $5/day.
    LLM_PROVIDER_PRIMARY: "anthropic|claude-haiku-4-5|cost:5/day",

    // BACKUP: OpenAI gpt-4o-mini. Capped at $10/day so it can absorb
    // overflow from the primary's cap.
    LLM_PROVIDER_BACKUP: "openai|gpt-4o-mini|cost:10/day",

    // TASK ROUTING: classify-intent calls try PRIMARY first, fall back to
    // BACKUP. The registry walks the chain in order; each entry is checked
    // for budget+cost availability before the call.
    LLM_TASK_ROUTE_TRIAGE: "primary,backup",
  },
  adapters: {
    ...(anthropicKey
      ? { anthropic: createAnthropicAdapter({ apiKey: anthropicKey }) }
      : {}),
    ...(openaiKey ? { openai: createOpenAIAdapter({ apiKey: openaiKey }) } : {}),
  },
});

const llm = registry.getPort();

// ─── Capability: defined ONCE, reusable from any call site ───────────

const IntentSchema = z.object({
  intent: z.enum(["question", "request", "complaint", "feedback", "other"]),
  urgency: z.enum(["low", "normal", "high"]),
  reasoning: z.string(),
});

const classifyIntent = createClassifier({
  port: llm,
  schema: IntentSchema,
  schemaName: "user-intent",
  rubric: `
    Choose EXACTLY one intent:
    - question: asking for information
    - request: wants something done
    - complaint: reports a problem
    - feedback: opinion only
    - other: anything else
  `,
});

// ─── Run a few representative inputs ─────────────────────────────────

const inputs = [
  "Where is my order? It's been 3 weeks.",
  "Could you also add a vegetarian option to the menu?",
  "Just wanted to say the new design looks great.",
  "URGENT: the payment page is down for our enterprise customers.",
];

console.log("Classifying", inputs.length, "messages through the chain...\n");

let totalCostUSD = 0;

for (const content of inputs) {
  const result = await classifyIntent({ content });
  console.log(`Input: ${content}`);
  console.log(`  intent: ${result.intent} (urgency: ${result.urgency})`);
  console.log(`  reasoning: ${result.reasoning}\n`);
}

// Capability factories also expose per-call hooks via `onResult` (not used
// here for brevity). In production you'd wire `onResult` to your quality-
// tracking sink to log cost/latency/usage per call.

console.log(
  "Done. Fallback chain primary → backup, USD cost gating per provider,",
);
console.log(
  "and the same `classifyIntent({ content })` call site no matter which",
);
console.log("provider actually served the request.");
console.log(
  `\nTotal cost: $${totalCostUSD.toFixed(6)} USD (use \`onResult\` hooks to track).`,
);
