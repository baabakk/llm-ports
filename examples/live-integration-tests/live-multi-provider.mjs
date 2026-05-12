/**
 * Live multi-provider Gate C smoke test.
 *
 * Proves the registry's fallback chain walks past a budget-exhausted
 * provider and reaches the next one. Uses only the OpenAI key (two
 * different OpenAI models stand in for two different "providers" in
 * the chain — the registry treats them as separate aliases).
 *
 * Scenario:
 *   - LLM_PROVIDER_TIGHT: gpt-4o-mini with cost:0.00000001/day (will refuse on first attempt)
 *   - LLM_PROVIDER_LOOSE: gpt-4o-mini with cost:1/day (will succeed)
 *   - Task route: tight,loose
 *
 * The registry should hit BudgetExceededError on `tight` and walk to `loose`.
 */

import {
  createRegistryFromEnv,
  BudgetExceededError,
  NoProvidersAvailableError,
} from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Set OPENAI_API_KEY before running this test.");
  process.exit(1);
}

const adapter = createOpenAIAdapter({ apiKey });

// Two provider aliases pointing at the same upstream; one has a budget so
// tight that even a 1-token call exceeds it. The chain should walk past
// it to the loose one.
const registry = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_TIGHT: "openai|gpt-4o-mini|cost:0.0000001/day",
    LLM_PROVIDER_LOOSE: "openai|gpt-4o-mini|cost:1/day",
    LLM_TASK_ROUTE_HELLO: "tight,loose",
  },
  adapters: { openai: adapter },
});

console.log("--- chain: tight,loose (tight has a sub-cent daily budget) ---");
console.log("  expectation: first call goes to LOOSE because TIGHT is over budget");
console.log();

const llm = registry.getPort();

// First, intentionally trip the TIGHT budget by recording a fake spend that
// puts it over. The InMemoryCost backend tracks spend in-process.
await registry.cost.recordCost("tight", 0.001); // 0.1 cent — way over $0.0000001 cap

console.log("  recorded 0.001 USD against TIGHT to ensure it's over its daily cap.\n");

try {
  const result = await llm.generateText({
    taskType: "hello",
    prompt: "Say hi in 5 words.",
    maxOutputTokens: 30,
  });
  console.log("  text:    ", result.text.trim());
  console.log("  provider:", result.providerAlias);
  console.log("  model:   ", result.modelId);
  console.log("  cost USD:", result.cost.totalUSD.toFixed(8));
  console.log("  latency: ", result.latencyMs, "ms");

  if (result.providerAlias !== "loose") {
    console.error(
      `\n  ✗ FAIL: expected providerAlias='loose' (chain walked past TIGHT), got '${result.providerAlias}'`,
    );
    process.exit(1);
  }
  console.log("\n  ✓ Chain walked TIGHT → LOOSE as expected. Fallback works.");
} catch (err) {
  if (err instanceof NoProvidersAvailableError) {
    console.error(
      `\n  ✗ FAIL: registry exhausted the chain — expected LOOSE to succeed. ` +
        `Attempted: ${err.attempted.join(", ")}.`,
    );
  } else if (err instanceof BudgetExceededError) {
    console.error(
      `\n  ✗ FAIL: budget gate fired without trying the next provider in the chain. ` +
        `This means the registry did NOT walk the chain on budget gating, which is wrong.`,
    );
  } else {
    console.error("\n  ✗ FAIL: unexpected error:", err);
  }
  process.exit(1);
}

console.log("\n  Gate C ✓: multi-provider example works end-to-end in a fresh project");
