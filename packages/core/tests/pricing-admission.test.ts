/**
 * Alpha.34, items 2 to 4 — the pricing admission matrix.
 *
 * Before this release, pricing had two states, present and absent, and
 * absent meant the provider was unroutable. That conflated "this costs
 * nothing" with "nobody knows what this costs", and the conflation is what
 * pushed a consumer into inventing a $1-per-million placeholder for every
 * model without a published rate. A fabricated number is inert right up
 * until a cost gate is switched on, at which point it silently becomes a
 * budget input.
 *
 * Three states now, and the guard is conditional on whether anyone is
 * actually enforcing money. Every cell of that matrix is asserted below,
 * because the failure being prevented is a plausible-looking number rather
 * than a crash, and a matrix with an untested cell is where one hides.
 */

import { describe, expect, it } from "vitest";
import {
  createRegistryFromEnv,
  NoProvidersAvailableError,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const PRICED: ModelPricing = { inputPer1M: 10, outputPer1M: 20 };

function port(): LLMPort {
  return {
    generateText: async () =>
      ({
        text: "ok",
        modelId: "model-x",
        providerAlias: "a",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        // The adapter decides cost; these tests are about admission, so the
        // port reports none and the assertions stay on whether the call
        // happened at all.
      }) as GenerateTextResult,
  } as unknown as LLMPort;
}

/** An adapter with a real table, so "model-x" is priced and others are not. */
function pricedAdapter(): AdapterRegistration {
  return { name: "alpha", pricing: { "model-x": PRICED }, createLLMPort: () => port() };
}

/** An adapter that declares it never bills, with no table at all. */
function freeAdapter(): AdapterRegistration {
  return { name: "alpha", pricing: "free", createLLMPort: () => port() };
}

const CALL = { taskType: "chat", messages: [{ role: "user" as const, content: "hi" }] };

function envFor(gating: string, model = "model-x"): Record<string, string> {
  return {
    LLM_PROVIDER_A: `alpha|${model}|${gating}`,
    LLM_TASK_ROUTE_CHAT: "a",
  };
}

const UNLIMITED = "unlimited";
const COST_GATED = "cost:100/day";

describe("priced model", () => {
  it("is admitted with no cost gate", async () => {
    const r = createRegistryFromEnv({ env: envFor(UNLIMITED), adapters: { alpha: pricedAdapter() } });
    await expect(r.getPort().generateText({ ...CALL })).resolves.toBeDefined();
  });

  it("is admitted under a cost gate", async () => {
    const r = createRegistryFromEnv({ env: envFor(COST_GATED), adapters: { alpha: pricedAdapter() } });
    await expect(r.getPort().generateText({ ...CALL })).resolves.toBeDefined();
  });
});

describe("free adapter", () => {
  it("is admitted for a model that appears in no table", async () => {
    // The reason `"free"` exists rather than a table of zeroes: a local
    // runtime serves whatever the operator pulled, so its model set cannot
    // be enumerated in advance and every unlisted name would otherwise be
    // unroutable.
    const r = createRegistryFromEnv({
      env: envFor(UNLIMITED, "some-model-nobody-listed"),
      adapters: { alpha: freeAdapter() },
    });
    await expect(r.getPort().generateText({ ...CALL })).resolves.toBeDefined();
  });

  it("is admitted under a cost gate, because zero is a known price", async () => {
    const r = createRegistryFromEnv({
      env: envFor(COST_GATED, "some-model-nobody-listed"),
      adapters: { alpha: freeAdapter() },
    });
    await expect(r.getPort().generateText({ ...CALL })).resolves.toBeDefined();
  });
});

describe("unknown price", () => {
  it("is admitted when nothing is enforcing money", async () => {
    // The cell the whole release is for. This configuration could not run
    // at all before alpha.34.
    const r = createRegistryFromEnv({
      env: envFor(UNLIMITED, "unpriced-model"),
      adapters: { alpha: pricedAdapter() },
    });
    await expect(r.getPort().generateText({ ...CALL })).resolves.toBeDefined();
  });

  it("is refused under a cost gate by default", async () => {
    // Anyone actually enforcing a budget keeps today's behaviour. A gate
    // that silently stopped binding would be worse than one that refuses.
    const r = createRegistryFromEnv({
      env: envFor(COST_GATED, "unpriced-model"),
      adapters: { alpha: pricedAdapter() },
    });
    await expect(r.getPort().generateText({ ...CALL })).rejects.toThrow();
  });

  it("is admitted under a cost gate when pricingPolicy is warn, and says so once", async () => {
    const warnings: string[] = [];
    const r = createRegistryFromEnv({
      env: envFor(COST_GATED, "unpriced-model"),
      adapters: { alpha: pricedAdapter() },
      pricingPolicy: "warn",
      deprecationWarningHandler: (m) => warnings.push(m),
    });

    await expect(r.getPort().generateText({ ...CALL })).resolves.toBeDefined();
    expect(warnings.join(" | ")).toContain("unpriced-model");
  });

  it("is admitted silently when pricingPolicy is silent", async () => {
    const warnings: string[] = [];
    const r = createRegistryFromEnv({
      env: envFor(COST_GATED, "unpriced-model"),
      adapters: { alpha: pricedAdapter() },
      pricingPolicy: "silent",
      deprecationWarningHandler: (m) => warnings.push(m),
    });

    await expect(r.getPort().generateText({ ...CALL })).resolves.toBeDefined();
    expect(warnings).toEqual([]);
  });

  it("does not consult pricingPolicy when there is no cost gate", async () => {
    // The policy governs exactly one cell. An ungated alias is admitted
    // whatever it is set to, and must not warn: warning about a price
    // nobody is enforcing is noise that trains people to ignore warnings.
    const warnings: string[] = [];
    const r = createRegistryFromEnv({
      env: envFor(UNLIMITED, "unpriced-model"),
      adapters: { alpha: pricedAdapter() },
      pricingPolicy: "warn",
      deprecationWarningHandler: (m) => warnings.push(m),
    });

    await expect(r.getPort().generateText({ ...CALL })).resolves.toBeDefined();
    expect(warnings).toEqual([]);
  });
});

describe("explicit overrides", () => {
  it("beat a free declaration, because stating a rate says it does bill", async () => {
    const r = createRegistryFromEnv({
      env: envFor(COST_GATED, "billed-after-all"),
      adapters: { alpha: freeAdapter() },
      pricingOverrides: { "billed-after-all": PRICED },
    });
    await expect(r.getPort().generateText({ ...CALL })).resolves.toBeDefined();
  });
});

/** The error a refused call rejects with, so a test can check it was the price. */
async function refusal(call: Promise<unknown>): Promise<NoProvidersAvailableError> {
  const err = await call.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(NoProvidersAvailableError);
  return err as NoProvidersAvailableError;
}

describe("the matrix at priority P0", () => {
  // P0 skips the budget and cost checks. The price check is not one of them:
  // under the default policy it refused an unpriced model at every priority
  // before alpha.34, and that default exists to preserve exactly that.
  const P0 = { ...CALL, priority: 0 as const };

  it("admits an unknown price when nothing is enforcing money", async () => {
    const r = createRegistryFromEnv({
      env: envFor(UNLIMITED, "unpriced-model"),
      adapters: { alpha: pricedAdapter() },
    });
    await expect(r.getPort().generateText(P0)).resolves.toBeDefined();
  });

  it("still refuses an unknown price on a cost-gated alias by default, and says it was the price", async () => {
    const r = createRegistryFromEnv({
      env: envFor(COST_GATED, "unpriced-model"),
      adapters: { alpha: pricedAdapter() },
    });
    const err = await refusal(r.getPort().generateText(P0));
    expect(Object.values(err.reasons).join(" ")).toContain("no pricing entry");
  });

  it("admits an unknown price on a cost-gated alias when pricingPolicy is warn", async () => {
    const r = createRegistryFromEnv({
      env: envFor(COST_GATED, "unpriced-model"),
      adapters: { alpha: pricedAdapter() },
      pricingPolicy: "warn",
      deprecationWarningHandler: () => {},
    });
    await expect(r.getPort().generateText(P0)).resolves.toBeDefined();
  });

  it("admits a free adapter on a cost-gated alias", async () => {
    const r = createRegistryFromEnv({
      env: envFor(COST_GATED, "anything-local"),
      adapters: { alpha: freeAdapter() },
    });
    await expect(r.getPort().generateText(P0)).resolves.toBeDefined();
  });
});

describe("the matrix on a forced alias", () => {
  // forceProviderAlias skips task routing through a separate selection path,
  // which applies the same price rule and must be checked on its own.
  const FORCED = { ...CALL, forceProviderAlias: "a" };

  it("admits an unknown price when nothing is enforcing money", async () => {
    const r = createRegistryFromEnv({
      env: envFor(UNLIMITED, "unpriced-model"),
      adapters: { alpha: pricedAdapter() },
    });
    await expect(r.getPort().generateText(FORCED)).resolves.toBeDefined();
  });

  it("refuses an unknown price on a cost-gated alias by default, and says it was the price", async () => {
    const r = createRegistryFromEnv({
      env: envFor(COST_GATED, "unpriced-model"),
      adapters: { alpha: pricedAdapter() },
    });
    const err = await refusal(r.getPort().generateText(FORCED));
    expect(Object.values(err.reasons).join(" ")).toContain("no pricing entry");
  });

  it("admits an unknown price on a cost-gated alias when pricingPolicy is silent", async () => {
    const r = createRegistryFromEnv({
      env: envFor(COST_GATED, "unpriced-model"),
      adapters: { alpha: pricedAdapter() },
      pricingPolicy: "silent",
    });
    await expect(r.getPort().generateText(FORCED)).resolves.toBeDefined();
  });
});
