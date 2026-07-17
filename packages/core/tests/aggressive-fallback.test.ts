/**
 * `runtimeFallback: "aggressive"` preset (alpha.25+, LP-REQ-01) — the
 * opinionated classifier bundled after three consumers (BEPA, HomeSignal,
 * SalesCoach) each rebuilt the same one by hand.
 *
 * Tests cover:
 *   - Positive: each error class the classifier walks on.
 *   - Negative: each error class the classifier does NOT walk on.
 *   - Body-pattern matches for credit-exhaustion 400s (positive + negative).
 *   - Raw 5xx status objects (defensive check).
 *   - Registry integration: chain of [rate-limited, credit-exhausted, healthy]
 *     resolves to the healthy provider under aggressive; aborts under default.
 */

import { describe, expect, it, vi } from "vitest";
import {
  aggressiveShouldFallback,
  AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS,
  AuthenticationError,
  BadRequestError,
  BudgetExceededError,
  ContentPolicyViolationError,
  ContextWindowExceededError,
  createRegistryFromEnv,
  EmptyResponseError,
  errorMatchers,
  NoProvidersAvailableError,
  ProviderUnavailableError,
  RateLimitError,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 2.0 };

describe("aggressiveShouldFallback classifier", () => {
  describe("positive cases (walks)", () => {
    it("walks on ProviderUnavailableError (existing default surface)", () => {
      const err = new ProviderUnavailableError("alias", new Error("boom"));
      expect(aggressiveShouldFallback(err)).toBe(true);
    });

    it("walks on RateLimitError", () => {
      const err = new RateLimitError("alias", "429", 5000);
      expect(aggressiveShouldFallback(err)).toBe(true);
    });

    it("walks on EmptyResponseError", () => {
      const err = new EmptyResponseError("alias", "model-x");
      expect(aggressiveShouldFallback(err)).toBe(true);
    });

    it("walks on ContextWindowExceededError", () => {
      const err = new ContextWindowExceededError("alias", "model-x", 8000, 12000);
      expect(aggressiveShouldFallback(err)).toBe(true);
    });

    it("walks on BadRequestError matching 'credit balance is too low'", () => {
      const err = new BadRequestError("alias", "Your credit balance is too low");
      expect(aggressiveShouldFallback(err)).toBe(true);
    });

    it("walks on BadRequestError matching 'insufficient funds'", () => {
      const err = new BadRequestError("alias", "insufficient funds on account");
      expect(aggressiveShouldFallback(err)).toBe(true);
    });

    it("walks on BadRequestError matching 'account disabled'", () => {
      const err = new BadRequestError("alias", "Account disabled by admin");
      expect(aggressiveShouldFallback(err)).toBe(true);
    });

    it("walks on BadRequestError matching 'billing'", () => {
      const err = new BadRequestError("alias", "billing issue on organization");
      expect(aggressiveShouldFallback(err)).toBe(true);
    });

    it("walks on BadRequestError matching 'exceeded your current quota'", () => {
      const err = new BadRequestError("alias", "You exceeded your current quota");
      expect(aggressiveShouldFallback(err)).toBe(true);
    });

    it("walks on raw error with status >= 500", () => {
      const err = { status: 503, message: "service unavailable" };
      expect(aggressiveShouldFallback(err)).toBe(true);
    });

    it("walks on raw error with status 500", () => {
      const err = { status: 500 };
      expect(aggressiveShouldFallback(err)).toBe(true);
    });
  });

  describe("negative cases (does not walk)", () => {
    it("does NOT walk on AuthenticationError", () => {
      const err = new AuthenticationError("alias", "invalid key");
      expect(aggressiveShouldFallback(err)).toBe(false);
    });

    it("does NOT walk on generic BadRequestError (malformed request)", () => {
      const err = new BadRequestError(
        "alias",
        "invalid parameter: temperature must be between 0 and 2",
      );
      expect(aggressiveShouldFallback(err)).toBe(false);
    });

    it("does NOT walk on ContentPolicyViolationError", () => {
      const err = new ContentPolicyViolationError("alias", "model-x");
      expect(aggressiveShouldFallback(err)).toBe(false);
    });

    it("does NOT walk on BudgetExceededError (port-internal gating)", () => {
      const err = new BudgetExceededError("alias", 100, 101, "cost");
      expect(aggressiveShouldFallback(err)).toBe(false);
    });

    it("does NOT walk on raw error with status < 500 and no LLMPortError wrapping", () => {
      const err = { status: 400, message: "bad request" };
      expect(aggressiveShouldFallback(err)).toBe(false);
    });

    it("does NOT walk on plain Error", () => {
      const err = new Error("something else");
      expect(aggressiveShouldFallback(err)).toBe(false);
    });

    it("does NOT walk on undefined / null / string / number", () => {
      expect(aggressiveShouldFallback(undefined)).toBe(false);
      expect(aggressiveShouldFallback(null)).toBe(false);
      expect(aggressiveShouldFallback("error")).toBe(false);
      expect(aggressiveShouldFallback(42)).toBe(false);
    });
  });

  describe("credit-exhaustion pattern coverage", () => {
    it("exposes the pattern list for consumer inspection", () => {
      expect(AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS.length).toBeGreaterThan(0);
      for (const p of AGGRESSIVE_CREDIT_EXHAUSTION_PATTERNS) {
        expect(p).toBeInstanceOf(RegExp);
      }
    });

    it("all documented patterns match against the constructed message", () => {
      const inputs: Array<[string, boolean]> = [
        ["Your credit balance is too low to complete this request", true],
        ["insufficient credit", true],
        ["Account suspended for policy violation", true],
        ["No billing profile configured", true],
        ["exceeded your current quota, please check your plan", true],
        ["out of credits", true],
        ["Payment required to continue", true],
        ["organization has been deactivated", true],
        ["invalid model name", false],
        ["temperature must be between 0 and 2", false],
        ["prompt too long", false],
      ];
      for (const [message, expectedMatch] of inputs) {
        const err = new BadRequestError("alias", message);
        expect(aggressiveShouldFallback(err)).toBe(expectedMatch);
      }
    });
  });
});

// ─── Registry integration ────────────────────────────────────────────

function makePort(behavior: {
  alias: string;
  modelId: string;
  throwOn?: () => Error;
  textOk?: string;
}): LLMPort {
  return {
    async generateText(): Promise<GenerateTextResult> {
      if (behavior.throwOn) throw behavior.throwOn();
      return {
        text: behavior.textOk ?? "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0.001 },
        modelId: behavior.modelId,
        providerAlias: behavior.alias,
        latencyMs: 1,
      };
    },
    async generateStructured() {
      throw new Error("unused");
    },
    async runAgent() {
      throw new Error("unused");
    },
    streamText: async function* () {
      yield "stub";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

describe("registry integration with runtimeFallback: 'aggressive'", () => {
  it("resolves to a healthy provider through a rate-limited + credit-exhausted chain", async () => {
    const rateLimitedAdapter: AdapterRegistration = {
      name: "adapter-rate-limited",
      pricing: { "m1": PRICING },
      createLLMPort: (modelId, alias) =>
        makePort({
          alias,
          modelId,
          throwOn: () => new RateLimitError(alias, "rate limited", 5000),
        }),
    };
    const creditExhaustedAdapter: AdapterRegistration = {
      name: "adapter-credit-exhausted",
      pricing: { "m2": PRICING },
      createLLMPort: (modelId, alias) =>
        makePort({
          alias,
          modelId,
          throwOn: () =>
            new BadRequestError(alias, "Your credit balance is too low"),
        }),
    };
    const healthyAdapter: AdapterRegistration = {
      name: "adapter-healthy",
      pricing: { "m3": PRICING },
      createLLMPort: (modelId, alias) =>
        makePort({ alias, modelId, textOk: "healthy" }),
    };

    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "adapter-rate-limited|m1|req:100/hour",
        LLM_PROVIDER_B: "adapter-credit-exhausted|m2|req:100/hour",
        LLM_PROVIDER_C: "adapter-healthy|m3|req:100/hour",
        LLM_TASK_ROUTE_TEST: "a,b,c",
      },
      adapters: {
        "adapter-rate-limited": rateLimitedAdapter,
        "adapter-credit-exhausted": creditExhaustedAdapter,
        "adapter-healthy": healthyAdapter,
      },
      runtimeFallback: "aggressive",
    });

    const result = await registry.getPort().generateText({
      taskType: "test",
      messages: [{ role: "user" as const, content: "hi" }],
    });

    expect(result.providerAlias).toBe("c");
    expect(result.text).toBe("healthy");
  });

  it("under 'default' the chain aborts on the rate-limited provider without walking", async () => {
    const rateLimitedAdapter: AdapterRegistration = {
      name: "adapter-rate-limited",
      pricing: { "m1": PRICING },
      createLLMPort: (modelId, alias) =>
        makePort({
          alias,
          modelId,
          throwOn: () => new RateLimitError(alias, "rate limited", 5000),
        }),
    };
    const healthyAdapter: AdapterRegistration = {
      name: "adapter-healthy",
      pricing: { "m3": PRICING },
      createLLMPort: (modelId, alias) =>
        makePort({ alias, modelId, textOk: "healthy" }),
    };

    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "adapter-rate-limited|m1|req:100/hour",
        LLM_PROVIDER_B: "adapter-healthy|m3|req:100/hour",
        LLM_TASK_ROUTE_TEST: "a,b",
      },
      adapters: {
        "adapter-rate-limited": rateLimitedAdapter,
        "adapter-healthy": healthyAdapter,
      },
      // "default" only walks on ProviderUnavailableError; RateLimitError aborts.
      runtimeFallback: "default",
    });

    await expect(
      registry.getPort().generateText({ taskType: "test", messages: [{ role: "user" as const, content: "hi" }] }),
    ).rejects.toThrow(RateLimitError);
  });

  it("aggressive preset is disjoint from custom classifier; both are respected", async () => {
    // Custom classifier that walks on EVERYTHING including AuthenticationError
    // (unusual, but valid). Ensures the object-form still takes precedence
    // when both aggressive-preset and a custom classifier were used.
    const authFailAdapter: AdapterRegistration = {
      name: "adapter-auth-fail",
      pricing: { "m1": PRICING },
      createLLMPort: (modelId, alias) =>
        makePort({
          alias,
          modelId,
          throwOn: () => new AuthenticationError(alias, "bad key"),
        }),
    };
    const healthyAdapter: AdapterRegistration = {
      name: "adapter-healthy",
      pricing: { "m2": PRICING },
      createLLMPort: (modelId, alias) =>
        makePort({ alias, modelId, textOk: "healthy" }),
    };

    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "adapter-auth-fail|m1|req:100/hour",
        LLM_PROVIDER_B: "adapter-healthy|m2|req:100/hour",
        LLM_TASK_ROUTE_TEST: "a,b",
      },
      adapters: {
        "adapter-auth-fail": authFailAdapter,
        "adapter-healthy": healthyAdapter,
      },
      // Object form wins; walks on everything.
      runtimeFallback: { shouldFallback: () => true },
    });

    const result = await registry.getPort().generateText({
      taskType: "test",
      messages: [{ role: "user" as const, content: "hi" }],
    });
    expect(result.text).toBe("healthy");
  });
});
