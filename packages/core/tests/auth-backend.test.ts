/**
 * Alpha.31.1 — `RegistryOptions.auth` (AuthBackend).
 *
 * Alpha.30 stored "which aliases have ever authenticated" as a private Set on
 * each Registry instance. That set decides whether an AuthenticationError
 * walks the chain (alias never authenticated, key is simply dead) or aborts
 * (alias authenticated earlier, so something changed underneath the process).
 *
 * Holding two Registry instances therefore meant holding two independent
 * copies, and the same credential on the same alias could be classified
 * differently by each depending on which authenticated first. These tests
 * pin both the defect's absence when a backend is shared and the unchanged
 * default when it is not.
 *
 * See TD-LLMPORTS-AUTH-STATE-NOT-PLUGGABLE.
 */

import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  createRegistryFromEnv,
  InMemoryAuth,
  type AdapterRegistration,
  type AuthBackend,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const HAIKU_PRICING: ModelPricing = { inputPer1M: 0.8, outputPer1M: 4.0 };

function fakeGoodPort(modelId: string, alias: string): LLMPort {
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

function fakeAuthFailingPort(_modelId: string, alias: string): LLMPort {
  const err = () => new AuthenticationError(alias, new Error("Incorrect API key"));
  return {
    async generateText() {
      throw err();
    },
    async generateStructured() {
      throw err();
    },
    async runAgent() {
      throw err();
    },
    streamText: async function* () {
      yield "";
    },
    streamStructured: async function* () {
      yield {} as never;
    },
  };
}

const goodAnthropic: AdapterRegistration = {
  name: "anthropic",
  pricing: { "claude-haiku-4-5": HAIKU_PRICING },
  createLLMPort: fakeGoodPort,
};

const authFailingAnthropic: AdapterRegistration = {
  name: "anthropic",
  pricing: { "claude-haiku-4-5": HAIKU_PRICING },
  createLLMPort: fakeAuthFailingPort,
};

const ENV = {
  LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
  LLM_TASK_ROUTE_TRIAGE: "a",
} as const;

function callOnce(registry: ReturnType<typeof createRegistryFromEnv>) {
  return registry.getPort().generateText({
    taskType: "triage",
    messages: [{ role: "user", content: "hi" }],
  });
}

// ─── Default behavior is alpha.30 behavior ──────────────────────────

describe("RegistryOptions.auth — default (no option passed)", () => {
  it("each Registry gets its own backend, so state does not leak between them", async () => {
    const first = createRegistryFromEnv({ env: { ...ENV }, adapters: { anthropic: goodAnthropic } });
    const second = createRegistryFromEnv({ env: { ...ENV }, adapters: { anthropic: goodAnthropic } });

    await callOnce(first);

    expect(first.hasEverAuthenticated("a")).toBe(true);
    // This isolation IS alpha.30's behavior. It is preserved as the default;
    // the defect was that it could not be opted out of.
    expect(second.hasEverAuthenticated("a")).toBe(false);
  });

  it("still records authentication on the owning Registry", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV },
      adapters: { anthropic: goodAnthropic },
    });
    expect(registry.hasEverAuthenticated("a")).toBe(false);
    await callOnce(registry);
    expect(registry.hasEverAuthenticated("a")).toBe(true);
  });
});

// ─── The fix: a shared backend removes the divergence ───────────────

describe("RegistryOptions.auth — shared backend", () => {
  it("a success on one Registry is visible to another sharing the backend", async () => {
    const auth = new InMemoryAuth();
    const first = createRegistryFromEnv({
      env: { ...ENV },
      adapters: { anthropic: goodAnthropic },
      auth,
    });
    const second = createRegistryFromEnv({
      env: { ...ENV },
      adapters: { anthropic: goodAnthropic },
      auth,
    });

    expect(second.hasEverAuthenticated("a")).toBe(false);
    await callOnce(first);

    // This is the assertion the defect made impossible.
    expect(second.hasEverAuthenticated("a")).toBe(true);
  });

  it("both registries reach the same verdict on the same credential", async () => {
    const auth = new InMemoryAuth();
    const healthy = createRegistryFromEnv({
      env: { ...ENV },
      adapters: { anthropic: goodAnthropic },
      auth,
    });
    const failing = createRegistryFromEnv({
      env: { ...ENV },
      adapters: { anthropic: authFailingAnthropic },
      auth,
    });

    // Before any success, both agree the alias is unauthenticated.
    expect(healthy.hasEverAuthenticated("a")).toBe(false);
    expect(failing.hasEverAuthenticated("a")).toBe(false);

    await callOnce(healthy);

    // After one success on either, both agree it HAS authenticated — so a
    // later failure is classified identically rather than depending on which
    // instance the call happened to go through.
    expect(healthy.hasEverAuthenticated("a")).toBe(true);
    expect(failing.hasEverAuthenticated("a")).toBe(true);
  });

  it("exposes the backend so a consumer can inspect or seed it", async () => {
    const auth = new InMemoryAuth();
    const registry = createRegistryFromEnv({
      env: { ...ENV },
      adapters: { anthropic: goodAnthropic },
      auth,
    });
    expect(registry.auth).toBe(auth);

    // Seeding directly is legitimate: a deployment that already knows a key
    // is good can say so without making a call first.
    auth.markAuthenticated("a");
    expect(registry.hasEverAuthenticated("a")).toBe(true);
  });
});

// ─── Custom implementations ─────────────────────────────────────────

describe("RegistryOptions.auth — custom backend", () => {
  it("accepts any implementation of the interface", async () => {
    const seen: string[] = [];
    const recording: AuthBackend = {
      hasEverAuthenticated: (alias) => seen.includes(alias),
      markAuthenticated: (alias) => {
        seen.push(alias);
      },
    };

    const registry = createRegistryFromEnv({
      env: { ...ENV },
      adapters: { anthropic: goodAnthropic },
      auth: recording,
    });

    expect(registry.hasEverAuthenticated("a")).toBe(false);
    await callOnce(registry);

    expect(seen).toContain("a");
    expect(registry.hasEverAuthenticated("a")).toBe(true);
  });

  it("a backend that always reports authenticated is honored", () => {
    const alwaysAuthed: AuthBackend = {
      hasEverAuthenticated: () => true,
      markAuthenticated: () => {},
    };
    const registry = createRegistryFromEnv({
      env: { ...ENV },
      adapters: { anthropic: goodAnthropic },
      auth: alwaysAuthed,
    });
    expect(registry.hasEverAuthenticated("anything-at-all")).toBe(true);
  });
});

// ─── InMemoryAuth in isolation ──────────────────────────────────────

describe("InMemoryAuth", () => {
  it("starts empty", () => {
    expect(new InMemoryAuth().hasEverAuthenticated("a")).toBe(false);
  });

  it("records and reports an alias", () => {
    const auth = new InMemoryAuth();
    auth.markAuthenticated("a");
    expect(auth.hasEverAuthenticated("a")).toBe(true);
    expect(auth.hasEverAuthenticated("b")).toBe(false);
  });

  it("is idempotent on repeat marks", () => {
    const auth = new InMemoryAuth();
    auth.markAuthenticated("a");
    auth.markAuthenticated("a");
    expect(auth.hasEverAuthenticated("a")).toBe(true);
  });

  it("never resets an alias once marked", async () => {
    const auth = new InMemoryAuth();
    const registry = createRegistryFromEnv({
      env: { ...ENV },
      adapters: { anthropic: goodAnthropic },
      auth,
    });
    await callOnce(registry);
    expect(auth.hasEverAuthenticated("a")).toBe(true);
    // No API exists to clear it, by design. Process restart re-verifies.
    expect(auth.hasEverAuthenticated("a")).toBe(true);
  });
});
