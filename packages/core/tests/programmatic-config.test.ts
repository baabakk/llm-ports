/**
 * Alpha.34, item 5 — `RegistryOptions.config`.
 *
 * The Registry could only be configured through environment-variable
 * strings. That is the right default for a dozen routes and it stops being
 * expressible at scale, because a provider alias is derived from the
 * environment variable's own name: real model ids contain `/`, `.` and
 * capitals, and no env var name can encode those.
 *
 * One consumer answered with a generated 392-entry catalogue, opaque
 * `m0001` route ids, roughly 784 synthesized env vars at startup, and a
 * lookup on the request path to map client-facing ids back. All of it
 * exists to squeeze real model names through a naming scheme that cannot
 * hold them.
 */

import { describe, expect, it } from "vitest";
import {
  createRegistryFromEnv,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
  type RegistryConfig,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1, outputPer1M: 2 };

function port(text: string): LLMPort {
  return {
    generateText: async () =>
      ({
        text,
        modelId: "m",
        providerAlias: "a",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
      }) as GenerateTextResult,
  } as unknown as LLMPort;
}

/** A model id that no environment variable name can express. */
const AWKWARD_MODEL = "Qwen/Qwen3.7-Max";

function adapterFor(name: string, text: string): AdapterRegistration {
  return { name, pricing: { [AWKWARD_MODEL]: PRICING }, createLLMPort: () => port(text) };
}

const CONFIG: RegistryConfig = {
  providers: {
    "deepinfra:qwen": {
      alias: "deepinfra:qwen",
      adapter: "deepinfra",
      modelId: AWKWARD_MODEL,
      budgetLimit: { kind: "unlimited" },
      costLimit: { kind: "unlimited" },
    },
  },
  taskRoutes: { chat: ["deepinfra:qwen"] },
};

describe("configuring a Registry with an object", () => {
  it("routes to a model whose id an env var name could not express", async () => {
    const registry = createRegistryFromEnv({
      config: CONFIG,
      adapters: { deepinfra: adapterFor("deepinfra", "answered") },
    });

    const res = await registry.getPort().generateText({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.text).toBe("answered");
  });

  it("takes precedence over env when both are supplied", async () => {
    const registry = createRegistryFromEnv({
      config: CONFIG,
      env: {
        LLM_PROVIDER_OTHER: "deepinfra|ignored-model|unlimited",
        LLM_TASK_ROUTE_CHAT: "other",
      },
      adapters: { deepinfra: adapterFor("deepinfra", "from config") },
    });

    expect(registry.listTasks().map((t) => t.task)).toEqual(["chat"]);
    const res = await registry.getPort().generateText({
      taskType: "chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.text).toBe("from config");
  });

  it("does not mutate the caller's object", () => {
    // reconcileConfig deletes unusable aliases and rewrites chains in
    // place. Doing that to an object the caller still holds would be a
    // surprise, and a nasty one to debug: their config would change shape
    // after construction with nothing in their code doing it.
    const mine: RegistryConfig = {
      providers: { ...CONFIG.providers },
      taskRoutes: { chat: ["deepinfra:qwen", "never-registered"] },
    };

    createRegistryFromEnv({
      config: mine,
      adapters: { deepinfra: adapterFor("deepinfra", "x") },
      deprecationWarningHandler: () => {},
    });

    expect(mine.taskRoutes["chat"]).toEqual(["deepinfra:qwen", "never-registered"]);
  });
});
