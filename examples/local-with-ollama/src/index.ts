/**
 * llm-ports — local-first dev loop with Ollama.
 *
 * Shows the local-to-cloud flip pattern:
 *   - Default: route all traffic to Ollama (zero cost, fully offline).
 *   - With ANTHROPIC_API_KEY set: enable a cloud fallback chain
 *     (local-first, cloud as backup if Ollama is down or model is missing).
 *   - With FORCE_CLOUD=1 set: route everything to cloud, the way prod runs.
 *
 * The same `await llm.generateText(...)` call drives all three. Application
 * code never imports `ollama` or `@anthropic-ai/sdk` directly.
 *
 * Run:
 *   # Local only (default):
 *   pnpm --filter @llm-ports/example-local-with-ollama start
 *
 *   # Local + cloud fallback:
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *     pnpm --filter @llm-ports/example-local-with-ollama start
 *
 *   # Force cloud (skip Ollama entirely):
 *   FORCE_CLOUD=1 ANTHROPIC_API_KEY=sk-ant-... \
 *     pnpm --filter @llm-ports/example-local-with-ollama start
 *
 * Prereqs (local path):
 *   - Ollama daemon running:    `ollama serve`
 *   - At least one model pulled: `ollama pull llama3.2`
 *
 * If the daemon isn't running, this example calls `pullModel` to fetch the
 * model. If the daemon ISN'T installed, set FORCE_CLOUD=1 and run with an
 * Anthropic key.
 */

import { createRegistryFromEnv } from "@llm-ports/core";
import { createOllamaAdapter } from "@llm-ports/adapter-ollama";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { z } from "zod";

const anthropicKey = process.env["ANTHROPIC_API_KEY"];
const forceCloud = process.env["FORCE_CLOUD"] === "1";
const localModel = process.env["OLLAMA_MODEL"] ?? "llama3.2";

if (forceCloud && !anthropicKey) {
  console.error("FORCE_CLOUD=1 requires ANTHROPIC_API_KEY.");
  process.exit(1);
}

// ─── Build adapter map dynamically ─────────────────────────────────────

const adapters: Record<string, ReturnType<typeof createOllamaAdapter> | ReturnType<typeof createAnthropicAdapter>> = {};
let routeChain: string;

if (forceCloud) {
  // Cloud only — useful for asserting prod parity.
  adapters["anthropic"] = createAnthropicAdapter({ apiKey: anthropicKey! });
  routeChain = "cloud";
} else {
  // Always wire Ollama. Health-check it before registering.
  const ollama = createOllamaAdapter({
    autoPull: true, // adapter will auto-pull a model on first use if missing
    keepAlive: "10m",
  });
  const health = await ollama.checkHealth();
  if (!health.ok) {
    console.error(
      `Ollama daemon not reachable on http://localhost:11434 ` +
        `(checked in ${health.latencyMs}ms). Start it with \`ollama serve\`, ` +
        `or rerun with FORCE_CLOUD=1 and ANTHROPIC_API_KEY set.`,
    );
    process.exit(1);
  }
  console.log(`Ollama reachable (${health.latencyMs}ms)`);
  adapters["ollama"] = ollama;

  // Optionally add cloud fallback.
  if (anthropicKey) {
    adapters["anthropic"] = createAnthropicAdapter({ apiKey: anthropicKey });
    routeChain = "local,cloud"; // walk in order; cloud fires if local fails budget
  } else {
    routeChain = "local";
  }
}

// ─── Build the registry config dynamically ─────────────────────────────

const env: Record<string, string | undefined> = {};
if (adapters["ollama"]) {
  env["LLM_PROVIDER_LOCAL"] = `ollama|${localModel}|unlimited`;
}
if (adapters["anthropic"]) {
  env["LLM_PROVIDER_CLOUD"] = "anthropic|claude-haiku-4-5|cost:1/day";
}
env["LLM_TASK_ROUTE_DRAFT"] = routeChain;
env["LLM_TASK_ROUTE_EXTRACT"] = routeChain;

const registry = createRegistryFromEnv({ env, adapters });
const llm = registry.getPort();

console.log("Route chain:", routeChain);

// ─── 1. generateText ───────────────────────────────────────────────────

console.log("\n--- generateText ---");
const draft = await llm.generateText({
  taskType: "draft",
  messages: [{ role: "user" as const, content: "Give a one-sentence project pitch for a TypeScript LLM library." }],
  maxOutputTokens: 80,
});
console.log("Text:    ", draft.text.trim());
console.log("Model:   ", draft.modelId);
console.log("Provider:", draft.providerAlias);
console.log("Cost USD:", draft.cost.totalUSD.toFixed(6));
console.log("Latency: ", draft.latencyMs, "ms");

// ─── 2. generateStructured ─────────────────────────────────────────────

const Profile = z.object({
  language: z.string(),
  yearsOfExperience: z.number().int().min(0).max(80),
  strengths: z.array(z.string()).min(1).max(5),
});

console.log("\n--- generateStructured ---");
const profile = await llm.generateStructured({
  taskType: "extract",
  schema: Profile,
  schemaName: "developer-profile",
  messages: [
    {
      role: "user",
      content:
        "Extract a developer profile from this paragraph: " +
        "'Hi I'm Sam, I have been writing TypeScript for about 7 years " +
        "and I'm strong at API design, type-driven testing, and refactoring " +
        "legacy code.'",
    },
  ],
  maxOutputTokens: 200,
});
console.log("Parsed:", profile.data);
console.log("Attempts:", profile.validationAttempts);
console.log("Provider:", profile.providerAlias);

// ─── 3. (Bonus) Model management — only on the local path ──────────────

if (adapters["ollama"]) {
  // Look up the same adapter so we can call its management methods.
  // (LLMPort doesn't expose them — they're adapter-level, not per-port.)
  const ollama = adapters["ollama"] as ReturnType<typeof createOllamaAdapter>;
  const models = await ollama.listModels();
  console.log("\n--- Local Ollama models ---");
  for (const m of models.slice(0, 5)) {
    console.log(
      `  ${m.name.padEnd(30)} ${(m.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
    );
  }
  if (models.length > 5) {
    console.log(`  ... ${models.length - 5} more`);
  }
}
