import { describe, expect, it } from "vitest";
import {
  ConfigError,
  createRegistryFromEnv,
  NoProvidersAvailableError,
  type AdapterRegistration,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const HAIKU_PRICING: ModelPricing = { inputPer1M: 0.8, outputPer1M: 4.0 };

function fakePort(modelId: string, alias: string): LLMPort {
  return {
    async generateText(): Promise<GenerateTextResult> {
      return {
        text: `from ${alias}/${modelId}`,
        usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
        cost: { inputUSD: 0.0008, outputUSD: 0.0004, totalUSD: 0.0012 },
        modelId,
        providerAlias: alias,
        latencyMs: 1,
      };
    },
    async generateStructured() {
      throw new Error("not used in this test");
    },
    async runAgent() {
      throw new Error("not used in this test");
    },
    streamText: async function* () {
      yield "stub";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

const fakeAnthropic: AdapterRegistration = {
  name: "anthropic",
  pricing: { "claude-haiku-4-5": HAIKU_PRICING },
  createLLMPort: fakePort,
};

describe("Registry", () => {
  it("constructs from env config and routes generateText to the configured chain", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:5/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: fakeAnthropic },
    });
    const llm = registry.getPort();
    const result = await llm.generateText({ taskType: "triage", messages: [{ role: "user" as const, content: "hello" }] });
    expect(result.text).toBe("from fast/claude-haiku-4-5");
    expect(result.providerAlias).toBe("fast");
  });

  it("falls back to the next provider when the first hits its budget", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:1/hour",
        LLM_PROVIDER_BACKUP: "anthropic|claude-haiku-4-5|req:5/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast,backup",
      },
      adapters: { anthropic: fakeAnthropic },
    });
    const llm = registry.getPort();

    const first = await llm.generateText({ taskType: "triage", messages: [{ role: "user" as const, content: "1" }] });
    expect(first.providerAlias).toBe("fast");

    // fast is now over budget; second call should land on backup
    const second = await llm.generateText({ taskType: "triage", messages: [{ role: "user" as const, content: "2" }] });
    expect(second.providerAlias).toBe("backup");
  });

  it("throws ConfigError if a provider references an unregistered adapter", () => {
    expect(() =>
      createRegistryFromEnv({
        env: {
          LLM_PROVIDER_FAST: "nonexistent|model|unlimited",
          LLM_TASK_ROUTE_TRIAGE: "fast",
        },
        adapters: { anthropic: fakeAnthropic },
      }),
    ).toThrow(ConfigError);
  });

  it("drops an unconfigured link from a task chain instead of refusing to construct", () => {
    // Behaviour changed in alpha.34. This assertion previously expected a
    // ConfigError. Refusing to construct meant one bad link took down every
    // other correctly configured provider, which two consumers each worked
    // around with ~50 lines of pre-filtering. The strict form is kept below.
    const warnings: string[] = [];
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|unlimited",
        LLM_TASK_ROUTE_TRIAGE: "fast,unknown",
      },
      adapters: { anthropic: fakeAnthropic },
      deprecationWarningHandler: (m) => warnings.push(m),
    });

    // The good link survives and the task is still routable.
    expect(registry.listTasks().map((t) => t.task)).toContain("triage");
    expect(warnings.join(" | ")).toContain("unknown");
  });

  it("still throws under strictConfig, which is the old behaviour by request", () => {
    expect(() =>
      createRegistryFromEnv({
        env: {
          LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|unlimited",
          LLM_TASK_ROUTE_TRIAGE: "fast,unknown",
        },
        adapters: { anthropic: fakeAnthropic },
        strictConfig: true,
      }),
    ).toThrow(ConfigError);
  });

  it("keeps the other eight providers when one adapter is unregistered", () => {
    // The case the change exists for: a deployment that names several
    // vendors and holds a subset of the keys.
    const warnings: string[] = [];
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|unlimited",
        LLM_PROVIDER_MISSING: "openai|gpt-4o|unlimited",
        LLM_TASK_ROUTE_TRIAGE: "missing,fast",
      },
      adapters: { anthropic: fakeAnthropic },
      deprecationWarningHandler: (m) => warnings.push(m),
    });

    expect(registry.listTasks().map((t) => t.task)).toContain("triage");
    expect(warnings.join(" | ")).toContain("openai");
  });

  it("still refuses to construct when nothing is usable", () => {
    // Dropping everything leaves a Registry that cannot serve a single call,
    // so the error belongs next to the misconfiguration rather than at the
    // first request.
    expect(() =>
      createRegistryFromEnv({
        env: {
          LLM_PROVIDER_MISSING: "openai|gpt-4o|unlimited",
          LLM_TASK_ROUTE_TRIAGE: "missing",
        },
        adapters: { anthropic: fakeAnthropic },
        deprecationWarningHandler: () => {},
      }),
    ).toThrow(ConfigError);
  });

  it("throws NoProvidersAvailableError when no chain matches the task type", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|unlimited",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: fakeAnthropic },
    });
    const llm = registry.getPort();
    await expect(
      llm.generateText({ taskType: "no-such-task", messages: [{ role: "user" as const, content: "hi" }] }),
    ).rejects.toBeInstanceOf(NoProvidersAvailableError);
  });

  it("listProviders and listTasks expose configured topology", () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|cost:5/day",
        LLM_PROVIDER_PREMIUM: "anthropic|claude-haiku-4-5|cost:50/day",
        LLM_TASK_ROUTE_TRIAGE: "fast,premium",
      },
      adapters: { anthropic: fakeAnthropic },
    });
    expect(registry.listProviders().map((p) => p.alias).sort()).toEqual(["fast", "premium"]);
    expect(registry.listTasks()).toEqual([{ task: "triage", chain: ["fast", "premium"] }]);
  });
});
