/**
 * An unreachable provider must fail over.
 *
 * Native `fetch` reports a request that never reached the server as a
 * `TypeError` with the message `fetch failed`, and puts the real reason
 * (connection refused, DNS failure, connect timeout) in `cause`. The `ollama`
 * and `@google/genai` client libraries let that error through unchanged.
 *
 * Since alpha.28, `wrapProviderError` has classified every `TypeError` as
 * `AdapterInternalError`, on the reasoning that a `TypeError` is almost
 * always a bug in adapter code. That class stops the chain under every
 * policy, so a stopped Ollama daemon or an unreachable Google endpoint never
 * failed over, and the caller was told the adapter was broken.
 *
 * The errors below are built in the exact shape those libraries throw,
 * including `cause` and its `code`, as recorded by running the real libraries
 * against a closed port. The adapter packages also test the real libraries
 * directly, so this file is not the only line of defence against a shape
 * that has drifted.
 */

import { describe, expect, it } from "vitest";
import {
  AdapterInternalError,
  createRegistryFromEnv,
  defaultShouldFallback,
  ProviderUnavailableError,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type RegistryOptions,
} from "../src/index.js";
import { wrapProviderError } from "../src/utils/wrap-provider-error.js";

/** What Node's fetch throws when the request never reached the server. */
function fetchFailed(code: string, detail: string): TypeError {
  const cause = Object.assign(new Error(detail), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

const NETWORK_FAILURES: Array<[string, TypeError]> = [
  ["connection refused", fetchFailed("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:11434")],
  ["DNS failure", fetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND ollama.internal")],
  ["connect timeout", fetchFailed("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error")],
];

/** The messages browsers use for the same condition. They carry no cause. */
const BROWSER_MESSAGES = [
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
];

describe("classifying a request that never reached the server", () => {
  for (const [label, err] of NETWORK_FAILURES) {
    it(`treats ${label} as an unreachable provider`, () => {
      const wrapped = wrapProviderError("local", err);
      expect(wrapped).toBeInstanceOf(ProviderUnavailableError);
      expect(wrapped).not.toBeInstanceOf(AdapterInternalError);
      // The reason must survive, or an operator cannot tell refused from DNS.
      expect((wrapped as ProviderUnavailableError).cause).toBe(err);
    });
  }

  for (const message of BROWSER_MESSAGES) {
    it(`treats the browser message "${message}" as an unreachable provider`, () => {
      expect(wrapProviderError("local", new TypeError(message))).toBeInstanceOf(ProviderUnavailableError);
    });
  }

  it("still treats a TypeError from adapter code as a bug", () => {
    // The alpha.28 rule this change narrows. It must keep working.
    const bug = new TypeError("Cannot read properties of undefined (reading 'content')");
    expect(wrapProviderError("local", bug)).toBeInstanceOf(AdapterInternalError);
  });

  it("does not treat a TypeError that merely mentions fetch as a network failure", () => {
    const bug = new TypeError("fetch is not a function");
    expect(wrapProviderError("local", bug)).toBeInstanceOf(AdapterInternalError);
  });
});

const healthy = {
  generateText: async () =>
    ({
      text: "answered by the second provider",
      modelId: "m",
      providerAlias: "beta",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }) as GenerateTextResult,
} as unknown as LLMPort;

/** A provider whose client library throws `err`, wrapped the way adapters wrap it. */
function throwing(err: Error): LLMPort {
  return {
    generateText: async () => {
      throw wrapProviderError("alpha", err);
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

for (const [policy, runtimeFallback] of policies) {
  describe(`an unreachable provider under ${policy}`, () => {
    for (const [label, err] of NETWORK_FAILURES) {
      it(`fails over on ${label}`, async () => {
        const registry = createRegistryFromEnv({
          env,
          adapters: { alpha: adapter("alpha", throwing(err)), beta: adapter("beta", healthy) },
          ...(runtimeFallback !== undefined ? { runtimeFallback } : {}),
        });
        const res = await registry.getPort().generateText(call);
        expect(res.text).toBe("answered by the second provider");
      });
    }

    it("still stops on a bug in adapter code", async () => {
      const registry = createRegistryFromEnv({
        env,
        adapters: {
          alpha: adapter("alpha", throwing(new TypeError("Cannot convert undefined or null to object"))),
          beta: adapter("beta", healthy),
        },
        ...(runtimeFallback !== undefined ? { runtimeFallback } : {}),
      });
      await expect(registry.getPort().generateText(call)).rejects.toBeInstanceOf(AdapterInternalError);
    });
  });
}
