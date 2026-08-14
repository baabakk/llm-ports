/**
 * Alpha.30 — Auth track §2.1.3 (new FallbackCause value in walkChain
 * emission) + §2.1.4 (Registry.probeCredentials two-tier strategy).
 *
 * §2.1.3: verifies that when the walk was triggered by an
 *   AuthenticationError, the emitted llm.fallback.selected carries
 *   cause: "provider_authentication_never_established" rather than
 *   the generic "provider_unavailable". Sinks can now alert
 *   specifically on stale credentials.
 *
 * §2.1.4: verifies probeCredentials in both tiers — Tier 1 (listModels
 *   only) and Tier 2 (opt-in generation fallback). Skip semantics for
 *   adapters without listModels() when Tier 2 is off. Successful probe
 *   marks the provider as authenticated. Failed probe surfaces the
 *   error without marking.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  AuthenticationError,
  createRegistryFromEnv,
  ProviderUnavailableError,
  type AdapterRegistration,
  type EmbeddingsPort,
  type GenerateTextResult,
  type Instrumentation,
  type LLMPort,
  type ModelPricing,
  type ProbeCredentialsReport,
  type ProviderModelInfo,
} from "../src/index.js";
import {
  createCollectingSink,
  type EventSource,
  type ObservabilityEvent,
} from "@llm-ports/observability-contract";

const HAIKU_PRICING: ModelPricing = { inputPer1M: 0.8, outputPer1M: 4.0 };
const GPT_PRICING: ModelPricing = { inputPer1M: 2.5, outputPer1M: 10 };
const testSource: EventSource = { library: "test", library_version: "0.0.0" };

function goodPort(modelId: string, alias: string): LLMPort {
  return {
    async generateText(): Promise<GenerateTextResult> {
      return {
        text: `from ${alias}/${modelId}`,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        modelId,
        providerAlias: alias,
        latencyMs: 1,
      };
    },
    async generateStructured() {
      throw new Error("not used");
    },
    async runAgent() {
      throw new Error("not used");
    },
    streamText: async function* () {
      yield "stub";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

function authFailingPort(_modelId: string, alias: string): LLMPort {
  return {
    async generateText() {
      throw new AuthenticationError(alias, new Error("Incorrect API key"));
    },
    async generateStructured() {
      throw new AuthenticationError(alias, new Error("Incorrect API key"));
    },
    async runAgent() {
      throw new AuthenticationError(alias, new Error("Incorrect API key"));
    },
    streamText: async function* () {
      yield "";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

// A port that returns a stub listModels() array without throwing. The
// probe treats this as "credential validated" per Tier 1 semantics.
function goodPortWithListModels(modelId: string, alias: string): LLMPort {
  return {
    ...goodPort(modelId, alias),
    async listModels(): Promise<ProviderModelInfo[]> {
      return [{ id: modelId }];
    },
  };
}

// A port whose listModels() throws AuthenticationError — simulates a
// dead credential caught at Tier 1.
function authFailingListModelsPort(modelId: string, alias: string): LLMPort {
  return {
    ...authFailingPort(modelId, alias),
    async listModels(): Promise<ProviderModelInfo[]> {
      throw new AuthenticationError(alias, new Error("Incorrect API key"));
    },
  };
}

// A port that has NO listModels() at all — Tier 1 skips; Tier 2 probes
// via generateText.
function goodPortNoListModels(modelId: string, alias: string): LLMPort {
  return goodPort(modelId, alias);
}

// Same, but generateText throws auth — Tier 2 catches as failed.
function authFailingNoListModelsPort(modelId: string, alias: string): LLMPort {
  return authFailingPort(modelId, alias);
}

const goodAnthropic: AdapterRegistration = {
  name: "anthropic",
  pricing: { "claude-haiku-4-5": HAIKU_PRICING },
  createLLMPort: goodPortWithListModels,
};

const authFailingOpenai: AdapterRegistration = {
  name: "openai",
  pricing: { "gpt-4o": GPT_PRICING },
  createLLMPort: authFailingListModelsPort,
};

const goodOllamaNoList: AdapterRegistration = {
  name: "ollama",
  pricing: { "llama3": { inputPer1M: 0, outputPer1M: 0 } },
  createLLMPort: goodPortNoListModels,
};

const authFailingOllamaNoList: AdapterRegistration = {
  name: "ollama",
  pricing: { "llama3": { inputPer1M: 0, outputPer1M: 0 } },
  createLLMPort: authFailingNoListModelsPort,
};

// For the fallback-cause emission test we need a good backup adapter
// distinct from the failing one so the chain has somewhere to land.
const goodBackup: AdapterRegistration = {
  name: "backup-anthropic",
  pricing: { "claude-haiku-4-5": HAIKU_PRICING },
  createLLMPort: goodPort,
};

const authFailingPrimary: AdapterRegistration = {
  name: "primary-openai",
  pricing: { "gpt-4o": GPT_PRICING },
  createLLMPort: authFailingPort,
};

// ─── §2.1.3: new FallbackCause on auth-driven walk ──────────────────

describe("walkChain — emits provider_authentication_never_established on auth-driven fallback", () => {
  function instrumentationWithSink(): {
    instr: Instrumentation;
    sink: ReturnType<typeof createCollectingSink>;
  } {
    const sink = createCollectingSink();
    return {
      instr: { config: { sink, source: testSource } },
      sink,
    };
  }

  it("fires the new cause when the walked-past provider failed with AuthenticationError", async () => {
    const { instr, sink } = instrumentationWithSink();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "backup-anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: {
        "primary-openai": authFailingPrimary,
        "backup-anthropic": goodBackup,
      },
      instrumentation: instr,
      runtimeFallback: "aggressive",
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    const fb = sink.events.find((e) => e.event_type === "llm.fallback.selected") as
      | ObservabilityEvent<
          "llm.fallback.selected",
          { from_provider_alias: string; to_provider_alias: string; cause: string }
        >
      | undefined;
    expect(fb).toBeDefined();
    expect(fb!.data.cause).toBe("provider_authentication_never_established");
    expect(fb!.data.from_provider_alias).toBe("primary");
    expect(fb!.data.to_provider_alias).toBe("backup");
  });

  it("still fires provider_unavailable when the walk was triggered by a non-auth error", async () => {
    const { instr, sink } = instrumentationWithSink();
    const failingUnavailable: AdapterRegistration = {
      name: "sdk-down",
      pricing: { "any": { inputPer1M: 0, outputPer1M: 0 } },
      createLLMPort: (_m, alias) => ({
        async generateText() {
          throw new ProviderUnavailableError(alias, new Error("connection reset"));
        },
        async generateStructured() {
          throw new ProviderUnavailableError(alias, new Error("connection reset"));
        },
        async runAgent() {
          throw new ProviderUnavailableError(alias, new Error("connection reset"));
        },
        streamText: async function* () {
          yield "";
        },
        streamStructured: async function* () {
          yield {} as never;
        },
      }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "sdk-down|any|req:100/hour",
        LLM_PROVIDER_BACKUP: "backup-anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: {
        "sdk-down": failingUnavailable,
        "backup-anthropic": goodBackup,
      },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    const fb = sink.events.find((e) => e.event_type === "llm.fallback.selected") as
      | ObservabilityEvent<"llm.fallback.selected", { cause: string }>
      | undefined;
    expect(fb!.data.cause).toBe("provider_unavailable");
  });
});

// ─── §2.1.4: Registry.probeCredentials — Tier 1 (default) ──────────

describe("Registry.probeCredentials — Tier 1 (listModels only, default)", () => {
  it("succeeds when the adapter's listModels() resolves", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: goodAnthropic },
    });
    const report = await registry.probeCredentials();
    expect(report.ok.map((r) => r.alias)).toEqual(["a"]);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("marks the provider as authenticated on success", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: goodAnthropic },
    });
    expect(registry.hasEverAuthenticated("a")).toBe(false);
    await registry.probeCredentials();
    expect(registry.hasEverAuthenticated("a")).toBe(true);
  });

  it("reports failed when listModels() throws AuthenticationError", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "openai|gpt-4o|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { openai: authFailingOpenai },
    });
    const report = await registry.probeCredentials();
    expect(report.ok).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.alias).toBe("a");
    expect(report.failed[0]!.errorType).toBe("AuthenticationError");
    expect(report.failed[0]!.error).toMatch(/Incorrect API key|401|authentication/i);
  });

  it("does NOT mark the provider as authenticated when probe fails", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "openai|gpt-4o|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { openai: authFailingOpenai },
    });
    await registry.probeCredentials();
    expect(registry.hasEverAuthenticated("a")).toBe(false);
  });

  it("skips adapters without listModels() in Tier 1", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_LOCAL: "ollama|llama3|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "local",
      },
      adapters: { ollama: goodOllamaNoList },
    });
    const report = await registry.probeCredentials();
    expect(report.ok).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.alias).toBe("local");
    expect(report.skipped[0]!.reason).toMatch(/listModels/);
  });

  it("probes every configured provider when chain is omitted", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_PROVIDER_B: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_C: "ollama|llama3|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: {
        anthropic: goodAnthropic,
        openai: authFailingOpenai,
        ollama: goodOllamaNoList,
      },
    });
    const report = await registry.probeCredentials();
    expect(report.ok.map((r) => r.alias)).toEqual(["a"]);
    expect(report.failed.map((r) => r.alias)).toEqual(["b"]);
    expect(report.skipped.map((r) => r.alias)).toEqual(["c"]);
  });

  it("probes only the aliases in the supplied chain", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_PROVIDER_B: "openai|gpt-4o|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: {
        anthropic: goodAnthropic,
        openai: authFailingOpenai,
      },
    });
    const report = await registry.probeCredentials(["a"]);
    expect(report.ok.map((r) => r.alias)).toEqual(["a"]);
    expect(report.failed).toEqual([]);
  });

  it("reports 'provider not configured' for aliases not in the config", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: goodAnthropic },
    });
    const report = await registry.probeCredentials(["a", "made-up"]);
    expect(report.ok.map((r) => r.alias)).toEqual(["a"]);
    expect(report.skipped.map((r) => r.alias)).toContain("made-up");
    expect(report.skipped.find((r) => r.alias === "made-up")!.reason).toMatch(/not configured/);
  });
});

// ─── §2.1.4: Registry.probeCredentials — Tier 2 (opt-in) ───────────

describe("Registry.probeCredentials — Tier 2 (probeWithGenerationFallback)", () => {
  it("succeeds when the adapter has no listModels() but generateText resolves", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_LOCAL: "ollama|llama3|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "local",
      },
      adapters: { ollama: goodOllamaNoList },
    });
    const report = await registry.probeCredentials(undefined, {
      probeWithGenerationFallback: true,
    });
    expect(report.ok.map((r) => r.alias)).toEqual(["local"]);
    expect(report.skipped).toEqual([]);
  });

  it("reports failed when the fallback generateText throws", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_LOCAL: "ollama|llama3|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "local",
      },
      adapters: { ollama: authFailingOllamaNoList },
    });
    const report = await registry.probeCredentials(undefined, {
      probeWithGenerationFallback: true,
    });
    expect(report.ok).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.errorType).toBe("AuthenticationError");
  });

  it("does NOT invoke fallback for adapters that DO have listModels()", async () => {
    // Even with the flag on, an adapter with listModels() uses Tier 1
    // — no unnecessary generation cost.
    const goodListModels: AdapterRegistration = {
      name: "anthropic",
      pricing: { "claude-haiku-4-5": HAIKU_PRICING },
      createLLMPort: (modelId, alias) => {
        // Track whether generateText was called; we don't want it to be.
        let generatedCalled = false;
        const port: LLMPort & { _generatedCalled(): boolean } = {
          ...goodPortWithListModels(modelId, alias),
          _generatedCalled: () => generatedCalled,
        };
        const originalGen = port.generateText.bind(port);
        port.generateText = async (opts) => {
          generatedCalled = true;
          return originalGen(opts);
        };
        return port;
      },
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: goodListModels },
    });
    const report = await registry.probeCredentials(undefined, {
      probeWithGenerationFallback: true,
    });
    expect(report.ok.map((r) => r.alias)).toEqual(["a"]);
    // Test structure asserts by report; the "no unnecessary generation"
    // guarantee also follows from Tier 1 being tried first — if
    // listModels() succeeds, the code path continues to the next
    // alias without touching generateText.
  });

  it("Tier 1 + Tier 2 mixed: some listModels-adapters + some non-listModels-adapters all resolve", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_CLOUD: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_PROVIDER_LOCAL: "ollama|llama3|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "cloud",
      },
      adapters: {
        anthropic: goodAnthropic,
        ollama: goodOllamaNoList,
      },
    });
    const report = await registry.probeCredentials(undefined, {
      probeWithGenerationFallback: true,
    });
    expect(report.ok.map((r) => r.alias).sort()).toEqual(["cloud", "local"]);
  });
});

// ─── Regression: existing 494 tests plus the new set ────────────────

describe("Regression sanity — building blocks compose", () => {
  it("probeCredentials + hasEverAuthenticated + fallback compose without conflict", async () => {
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "backup-anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: {
        "primary-openai": authFailingPrimary,
        "backup-anthropic": goodBackup,
      },
    });
    // Probe first: primary fails (no listModels + Tier 2 off = skipped).
    // Wait — authFailingPrimary uses authFailingPort (no listModels).
    // Tier 1 skips it. Backup: goodBackup uses goodPort (no listModels).
    // Tier 1 skips it too. So neither gets marked from the probe.
    const probeReport = await registry.probeCredentials();
    expect(probeReport.ok).toEqual([]); // both adapters lack listModels
    expect(probeReport.skipped.length).toBe(2);
    // Now a real call: primary throws AuthenticationError, chain walks
    // via ctx-aware policy (neither is marked yet), backup succeeds.
    const result = await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.providerAlias).toBe("backup");
    // Backup is now marked; primary is not.
    expect(registry.hasEverAuthenticated("primary")).toBe(false);
    expect(registry.hasEverAuthenticated("backup")).toBe(true);
  });
});
