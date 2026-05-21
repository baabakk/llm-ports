/**
 * Live vision test — proves the image pipeline reaches a real vision model.
 *
 * Three runs:
 *   1. Anthropic (claude-haiku-4-5) — base64 PNG via ImageBlock
 *   2. OpenAI (gpt-4o-mini) — base64 PNG via ImageBlock + detail="low"
 *   3. OpenAI (gpt-4o-mini) — URL PNG via ImageBlock + detail="auto"
 *
 * Sends a 1×1 transparent PNG (smallest possible). The point isn't whether
 * the model can describe a 1×1 image (it can't — it's transparent), but
 * that the request reaches the model without a wire-format error. A real
 * 4xx from the provider would surface as a ProviderUnavailableError; the
 * test fails loudly if the adapter mangled the payload.
 *
 * Cost: ~$0.0005 total across all calls.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   OPENAI_API_KEY=sk-... \
 *   node examples/live-integration-tests/live-vision.mjs
 */

import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
if (!anthropicKey && !openaiKey) {
  console.error("Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY before running this test.");
  process.exit(1);
}

// 1×1 transparent PNG, base64-encoded.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const adapters = {};
const env = {};
if (anthropicKey) {
  adapters.anthropic = createAnthropicAdapter({ apiKey: anthropicKey });
  env.LLM_PROVIDER_VISION_ANTHROPIC = "anthropic|claude-haiku-4-5|cost:1/day";
}
if (openaiKey) {
  adapters.openai = createOpenAIAdapter({
    apiKey: openaiKey,
    pricingOverrides: {
      "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    },
  });
  env.LLM_PROVIDER_VISION_OPENAI = "openai|gpt-4o-mini|cost:1/day";
}

env.LLM_TASK_ROUTE_DESCRIBE_ANTHROPIC = "vision-anthropic";
env.LLM_TASK_ROUTE_DESCRIBE_OPENAI = "vision-openai";

const registry = createRegistryFromEnv({ env, adapters });

let failures = 0;

if (anthropicKey) {
  console.log("--- live vision: Anthropic (base64 PNG) ---");
  try {
    const result = await registry.getPort().generateText({
      taskType: "describe-anthropic",
      prompt: [
        { type: "text", text: "What color is this image? Reply in one word." },
        { type: "image", source: { kind: "base64", mediaType: "image/png", data: TINY_PNG } },
      ],
      maxOutputTokens: 50,
    });
    console.log("  text:    ", result.text.trim());
    console.log("  model:   ", result.modelId);
    console.log("  usage:   ", `${result.usage.inputTokens} in + ${result.usage.outputTokens} out`);
    console.log("  cost USD:", result.cost.totalUSD.toFixed(8));
    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err.message);
    failures++;
  }
}

if (openaiKey) {
  console.log("\n--- live vision: OpenAI base64 PNG + detail='low' ---");
  try {
    const result = await registry.getPort().generateText({
      taskType: "describe-openai",
      prompt: [
        { type: "text", text: "What color is this image? Reply in one word." },
        {
          type: "image",
          source: {
            kind: "base64",
            mediaType: "image/png",
            data: TINY_PNG,
            detail: "low",
          },
        },
      ],
      maxOutputTokens: 50,
    });
    console.log("  text:    ", result.text.trim());
    console.log("  model:   ", result.modelId);
    console.log("  usage:   ", `${result.usage.inputTokens} in + ${result.usage.outputTokens} out`);
    console.log("  cost USD:", result.cost.totalUSD.toFixed(8));
    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err.message);
    failures++;
  }

  console.log("\n--- live vision: OpenAI URL PNG + detail='auto' (default) ---");
  try {
    // Use a stable, public 1×1 PNG. Wikimedia Commons hosts one.
    const result = await registry.getPort().generateText({
      taskType: "describe-openai",
      prompt: [
        { type: "text", text: "What color is the image? Reply in one word." },
        {
          type: "image",
          source: {
            kind: "url",
            url: "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
          },
        },
      ],
      maxOutputTokens: 50,
    });
    console.log("  text:    ", result.text.trim());
    console.log("  model:   ", result.modelId);
    console.log("  usage:   ", `${result.usage.inputTokens} in + ${result.usage.outputTokens} out`);
    console.log("  cost USD:", result.cost.totalUSD.toFixed(8));
    console.log("  PASS");
  } catch (err) {
    console.error("  FAIL:", err.message);
    failures++;
  }
}

console.log("\n--- summary ---");
console.log(`  ${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
