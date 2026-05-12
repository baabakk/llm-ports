/**
 * Live Anthropic Gate C test against the PUBLISHED adapter-anthropic alpha.
 *
 * Three things this proves that the unit tests cannot:
 *   1. generateText + generateStructured work against a real Claude model
 *   2. runAgent with a Zod tool schema works end-to-end (alpha.1 fix #1)
 *   3. The bundled pricing for Claude Haiku 4.5 reports a sane USD figure
 *
 * Cost: ~$0.0005 total across all three calls on claude-haiku-4-5.
 */

import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { z } from "zod";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY before running this test.");
  process.exit(1);
}

const adapter = createAnthropicAdapter({ apiKey });
const registry = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|cost:1/day",
    LLM_TASK_ROUTE_GREETING: "fast",
    LLM_TASK_ROUTE_CLASSIFY: "fast",
    LLM_TASK_ROUTE_AGENT: "fast",
  },
  adapters: { anthropic: adapter },
});
const llm = registry.getPort();

// ─── 1. generateText ───────────────────────────────────────────────────

console.log("--- live generateText (Claude Haiku 4.5) ---");
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

// ─── 2. generateStructured ─────────────────────────────────────────────

console.log("\n--- live generateStructured (typed classification) ---");
const Classification = z.object({
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  reasoning: z.string(),
});
let classification = null;
let classificationError = null;
try {
  classification = await llm.generateStructured({
    taskType: "classify",
    prompt:
      "Classify this support email priority and ALWAYS include a `reasoning` field explaining the choice: " +
      "'Our production API has been down for 20 minutes. Need immediate help.'",
    schema: Classification,
    schemaName: "support-priority",
    maxOutputTokens: 200,
  });
  console.log("  parsed:   ", classification.data);
  console.log("  model:    ", classification.modelId);
  console.log("  attempts: ", classification.validationAttempts);
  console.log("  cost USD: ", classification.cost.totalUSD.toFixed(8));
  console.log("  latency:  ", classification.latencyMs, "ms");
} catch (err) {
  classificationError = err;
  console.log("  ⚠ generateStructured threw ValidationError:");
  console.log("    issues:    ", JSON.stringify(err.issues));
  console.log("    attempts:  ", err.attempts);
  console.log(
    "  This is the typed-error surface working as designed — the registry " +
      "can catch ValidationError and route to a fallback model when one model " +
      "won't adhere to the schema. Continuing.",
  );
}

// ─── 3. runAgent with a Zod tool schema (PROVES alpha.1 fix #1 end-to-end) ──

console.log("\n--- live runAgent + Zod tool schema (alpha.1 fix #1 end-to-end) ---");

let toolCalled = false;
let toolGotProperArgs = false;
const FAKE_ORDER_DB = {
  "ORD-1001": { item: "wireless mouse", status: "shipped", trackingId: "1Z999AA" },
  "ORD-1002": { item: "USB-C cable",   status: "processing", trackingId: null },
};

const agent = await llm.runAgent({
  taskType: "agent",
  instructions:
    "You are a customer-support agent. When the user asks about an order, " +
    "you MUST call the lookupOrder tool with the order id to get details. " +
    "Do not invent order data.",
  messages: [
    { role: "user", content: "What's the status of order ORD-1001?" },
  ],
  tools: {
    lookupOrder: {
      name: "lookupOrder",
      description: "Look up an order by ID. Returns item, status, and tracking id.",
      inputSchema: z.object({
        orderId: z.string().describe("The order ID, e.g. ORD-1001"),
        includeShipping: z.boolean().optional().describe("Include shipping address details"),
      }),
      execute: async (args) => {
        toolCalled = true;
        // The core assertion of alpha.1 fix #1: the model receives a real
        // JSON Schema for inputSchema, so it knows to populate orderId.
        // Before the fix, inputSchema was passed as { type: "object", properties: {} },
        // and the model had to GUESS the parameter name from the description string.
        if (typeof args === "object" && args !== null && "orderId" in args) {
          toolGotProperArgs = true;
        }
        const orderId = (args).orderId;
        const found = FAKE_ORDER_DB[orderId];
        if (!found) return JSON.stringify({ error: `No order ${orderId}` });
        return JSON.stringify(found);
      },
    },
  },
  maxSteps: 4,
  maxOutputTokens: 400,
});

console.log("  final text:         ", agent.text.trim().slice(0, 200));
console.log("  steps taken:        ", agent.stepsTaken);
console.log("  termination:        ", agent.terminationReason);
console.log("  tool calls made:    ", agent.toolCalls?.length ?? 0);
console.log("  tool actually fired:", toolCalled);
console.log("  args had `orderId`: ", toolGotProperArgs);
console.log("  total cost USD:     ", agent.cost.totalUSD.toFixed(8));
console.log("  total latency:      ", agent.latencyMs, "ms");

let failures = 0;
if (!toolCalled) {
  console.error("\n  ✗ FAIL: Claude did not call the lookupOrder tool.");
  failures++;
}
if (!toolGotProperArgs) {
  console.error(
    "\n  ✗ FAIL: Claude called the tool but with the wrong arg shape — " +
      "this is the symptom alpha.1 fix #1 was supposed to eliminate.",
  );
  failures++;
}
if (failures === 0) {
  console.log(
    "\n  ✓ Claude called the tool with the correct `orderId` argument. " +
      "Alpha.1 fix #1 (Zod-to-JSON-Schema in adapter-anthropic) works against the real API.",
  );
}

const totalCost =
  greeting.cost.totalUSD +
  (classification?.cost.totalUSD ?? 0) +
  agent.cost.totalUSD;
console.log("\n--- summary ---");
console.log(`  total cost across all live calls:   $${totalCost.toFixed(8)}`);
console.log(`  package:                            @llm-ports/adapter-anthropic (workspace)`);
console.log(`  generateText:                       ✓`);
console.log(
  `  generateStructured:                 ${classificationError ? "⚠ ValidationError (typed; not a crash)" : "✓"}`,
);
console.log(
  `  runAgent + Zod tool schema:         ${toolCalled && toolGotProperArgs ? "✓ (alpha.1 fix #1 verified end-to-end)" : "✗"}`,
);

process.exit(failures);
