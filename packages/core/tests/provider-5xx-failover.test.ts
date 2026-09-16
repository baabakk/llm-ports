/**
 * A provider HTTP 5xx must fail over.
 *
 * `wrapProviderError` turns every provider 500 to 599 into a
 * `ServiceUnavailableError`, documented as safe to fail over. Since alpha.18
 * neither the Registry's default policy nor the `"aggressive"` preset walked on
 * that class: the default named only its subclass `ProviderUnavailableError`,
 * and the preset named two subclasses but never the parent. So the most common
 * transient outage there is did not use the configured chain.
 *
 * **The existing preset tests could not catch this.** They modelled a 5xx as a
 * raw object, `{ status: 503 }`, which the preset's duck-typed status check
 * does handle. In production every 5xx is wrapped first and arrives without a
 * `status` field. The tests below throw what an adapter actually throws: the
 * output of `wrapProviderError` applied to a real 5xx shape.
 */

import { describe, expect, it } from "vitest";
import {
  createRegistryFromEnv,
  defaultShouldFallback,
  ServiceUnavailableError,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type RegistryOptions,
} from "../src/index.js";
import { wrapProviderError } from "../src/utils/wrap-provider-error.js";

const healthy = {
  generateText: async () =>
    ({
      text: "answered by the second provider",
      modelId: "m",
      providerAlias: "beta",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }) as GenerateTextResult,
} as unknown as LLMPort;

/** A provider that fails the way a real SDK does, wrapped the way adapters wrap it. */
function failsWith(status: number): LLMPort {
  const sdkError = Object.assign(new Error(`HTTP ${status}`), { status });
  return {
    generateText: async () => {
      throw wrapProviderError("alpha", sdkError);
    },
  } as unknown as LLMPort;
}

function adapter(name: string, port: LLMPort): AdapterRegistration {
  return { name, pricing: { m: { inputPer1M: 1, outputPer1M: 1 } }, createLLMPort: () => port };
}

const env = {
  LLM_PROVIDER_A: "alpha|m|req:100/hour",
  LLM_PROVIDER_B: "beta|m|req:100/hour",
  LLM_TASK_ROUTE_CHAT: "a,b",
};
const call = { taskType: "chat", messages: [{ role: "user" as const, content: "hi" }] };

const policies: Array<[string, RegistryOptions["runtimeFallback"]]> = [
  ["the default policy", undefined],
  ["the aggressive preset", "aggressive"],
  ["the opt-in defaultShouldFallback table", { shouldFallback: defaultShouldFallback }],
];

describe("the test setup", () => {
  it("throws what a real adapter throws for a 5xx, which carries no status field", () => {
    // If this ever changes, the tests below may stop exercising the defect.
    const wrapped = wrapProviderError("alpha", Object.assign(new Error("HTTP 503"), { status: 503 }));
    expect(wrapped).toBeInstanceOf(ServiceUnavailableError);
    expect("status" in wrapped).toBe(false);
  });
});

for (const [label, runtimeFallback] of policies) {
  describe(`a provider 5xx under ${label}`, () => {
    for (const status of [500, 502, 503, 504]) {
      it(`fails over on HTTP ${status}`, async () => {
        const registry = createRegistryFromEnv({
          env,
          adapters: { alpha: adapter("alpha", failsWith(status)), beta: adapter("beta", healthy) },
          ...(runtimeFallback !== undefined ? { runtimeFallback } : {}),
        });
        const res = await registry.getPort().generateText(call);
        expect(res.text).toBe("answered by the second provider");
      });
    }
  });
}

describe("what must still not fail over", () => {
  it("a 400 stays with the caller under the default policy", async () => {
    // Widening the walk to the 5xx parent must not widen it to client errors.
    const registry = createRegistryFromEnv({
      env,
      adapters: { alpha: adapter("alpha", failsWith(400)), beta: adapter("beta", healthy) },
    });
    await expect(registry.getPort().generateText(call)).rejects.toThrow();
  });

  it("a 400 stays with the caller under the aggressive preset", async () => {
    const registry = createRegistryFromEnv({
      env,
      adapters: { alpha: adapter("alpha", failsWith(400)), beta: adapter("beta", healthy) },
      runtimeFallback: "aggressive",
    });
    await expect(registry.getPort().generateText(call)).rejects.toThrow();
  });
});
