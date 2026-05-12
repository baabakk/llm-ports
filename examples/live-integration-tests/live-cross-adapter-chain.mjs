/**
 * Live cross-adapter chain test.
 *
 * Replaces the previous TIGHT/LOOSE same-OpenAI-twice surrogate with a
 * real Anthropic + OpenAI fallback chain. Proves the registry walks
 * across DIFFERENT adapters when the first is budget-exhausted, not
 * just across two aliases of the same one.
 *
 * Scenario:
 *   - LLM_PROVIDER_TIGHT_ANTHROPIC: claude-haiku-4-5 with cost:0.0000001/day (will refuse)
 *   - LLM_PROVIDER_LOOSE_OPENAI:    gpt-4o-mini with cost:1/day (will succeed)
 *   - LLM_TASK_ROUTE_HELLO=tight_anthropic,loose_openai
 *
 * Pre-trip the TIGHT_ANTHROPIC budget, call generateText, assert the
 * result comes from LOOSE_OPENAI.
 */

import { createRegistryFromEnv, NoProvidersAvailableError } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
if (!anthropicKey || !openaiKey) {
  console.error(
    "Set both ANTHROPIC_API_KEY and OPENAI_API_KEY before running this test.",
  );
  process.exit(1);
}

const anthropic = createAnthropicAdapter({ apiKey: anthropicKey });
const openai = createOpenAIAdapter({ apiKey: openaiKey });

// Registry parser lowercases the env-var alias and converts `_` to `-`, so
// LLM_PROVIDER_TIGHT_ANTHROPIC becomes alias `tight-anthropic`.
const registry = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_TIGHT_ANTHROPIC: "anthropic|claude-haiku-4-5|cost:0.0000001/day",
    LLM_PROVIDER_LOOSE_OPENAI: "openai|gpt-4o-mini|cost:1/day",
    LLM_TASK_ROUTE_HELLO: "tight-anthropic,loose-openai",
  },
  adapters: { anthropic, openai },
});

console.log("--- chain: tight-anthropic,loose-openai (real cross-adapter fallback) ---");
console.log("  TIGHT is Anthropic (Claude Haiku), capped at 0.0000001 USD/day");
console.log("  LOOSE is OpenAI (gpt-4o-mini), capped at 1 USD/day");
console.log();

// Trip TIGHT_ANTHROPIC's budget so the registry walks past it.
await registry.cost.recordCost("tight-anthropic", 0.001);
console.log("  recorded 0.001 USD against tight-anthropic to exceed its daily cap.\n");

const llm = registry.getPort();

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

  let failures = 0;
  if (result.providerAlias !== "loose-openai") {
    console.error(
      `\n  ✗ FAIL: expected providerAlias='loose-openai' (chain walked past Anthropic), ` +
        `got '${result.providerAlias}'`,
    );
    failures++;
  }
  if (!result.modelId.includes("gpt-4o-mini")) {
    console.error(
      `\n  ✗ FAIL: expected modelId to include 'gpt-4o-mini', got '${result.modelId}'`,
    );
    failures++;
  }

  if (failures === 0) {
    console.log(
      "\n  ✓ Chain walked Anthropic (budget-exhausted) → OpenAI as expected.",
    );
    console.log(
      "    This proves the registry's fallback walks across DIFFERENT adapter " +
        "implementations, not just across aliases of the same adapter.",
    );
  }
  process.exit(failures);
} catch (err) {
  if (err instanceof NoProvidersAvailableError) {
    console.error(
      `\n  ✗ FAIL: registry exhausted the chain. Attempted: ${err.attempted.join(", ")}`,
    );
  } else {
    console.error("\n  ✗ FAIL: unexpected error:", err);
  }
  process.exit(1);
}
