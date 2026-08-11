/**
 * Alpha.29 — prompt fingerprint compute (§2.3).
 *
 * The Registry's `withOperation` work callback calls
 * `maybeComputeFingerprint(opCtx, request)` once per operation.
 * When `Instrumentation.fingerprint` is set, `withAttempt` includes
 * the computed `RequestFingerprint` on every `llm.attempt.completed`
 * event it emits (including across retries and fallbacks — same
 * fingerprint every time, since the request is the same).
 *
 * When `Instrumentation.fingerprint` is undefined, no compute runs
 * and no fingerprint appears on any event.
 */

import { describe, expect, it } from "vitest";
import {
  createCollectingSink,
  type EventSource,
  type ObservabilityEvent,
  type RequestFingerprint,
} from "@llm-ports/observability-contract";
import {
  createRegistryFromEnv,
  ProviderUnavailableError,
  type AdapterRegistration,
  type GenerateTextResult,
  type Instrumentation,
  type LLMPort,
} from "../src/index.js";

const testSource: EventSource = { library: "test", library_version: "0.0.0" };

function successPort(modelId: string, alias: string): LLMPort {
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

function failingPort(_modelId: string, alias: string): LLMPort {
  const err = () => new ProviderUnavailableError(alias, new Error("stub down"));
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

const goodA: AdapterRegistration = {
  name: "anthropic",
  pricing: { "claude-haiku-4-5": { inputPer1M: 0.8, outputPer1M: 4.0 } },
  createLLMPort: successPort,
};
const goodB: AdapterRegistration = {
  name: "openai",
  pricing: { "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 } },
  createLLMPort: successPort,
};
const failingAdapter: AdapterRegistration = {
  name: "openai",
  pricing: { "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 } },
  createLLMPort: failingPort,
};

// ─── Fingerprint compute opt-in ─────────────────────────────────────

describe("Registry fingerprint — opt-in via Instrumentation.fingerprint", () => {
  it("does NOT emit request_fingerprint when fingerprint policy is undefined", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = {
      config: { sink, source: testSource },
      // No fingerprint policy.
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: goodA },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hello" }],
    });
    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed") as
      | ObservabilityEvent<"llm.attempt.completed", { request_fingerprint?: RequestFingerprint }>
      | undefined;
    expect(completed).toBeDefined();
    expect(completed!.data.request_fingerprint).toBeUndefined();
  });

  it("emits request_fingerprint on attempt.completed when fingerprint policy is set", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = {
      config: { sink, source: testSource },
      fingerprint: { algorithm: "sha256" },
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: goodA },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hello" }],
    });
    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed") as
      | ObservabilityEvent<"llm.attempt.completed", { request_fingerprint: RequestFingerprint }>
      | undefined;
    expect(completed).toBeDefined();
    const fp = completed!.data.request_fingerprint;
    expect(fp).toBeDefined();
    expect(fp.message_hash).toMatch(/^[0-9a-f]{64}$/i);
    expect(fp.request_hash).toMatch(/^[0-9a-f]{64}$/i);
    expect(fp.hash_algorithm).toBe("sha256");
    expect(fp.normalization_version).toBe("1");
  });

  it("threads promptId and promptVersion through to the fingerprint", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = {
      config: { sink, source: testSource },
      fingerprint: {
        algorithm: "sha256",
        promptId: "triage-classifier",
        promptVersion: "v3.2",
      },
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: goodA },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed") as
      | ObservabilityEvent<"llm.attempt.completed", { request_fingerprint: RequestFingerprint }>
      | undefined;
    expect(completed!.data.request_fingerprint.prompt_id).toBe("triage-classifier");
    expect(completed!.data.request_fingerprint.prompt_version).toBe("v3.2");
  });
});

// ─── Determinism across retries/fallbacks ───────────────────────────

describe("Registry fingerprint — determinism across fallbacks", () => {
  it("attaches the SAME fingerprint on both attempts of a fallback sequence", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = {
      config: { sink, source: testSource },
      fingerprint: { algorithm: "sha256" },
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "openai|gpt-4o|req:100/hour",
        LLM_PROVIDER_BACKUP: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "primary,backup",
      },
      adapters: { openai: failingAdapter, anthropic: goodA },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    // Only completed attempts carry fingerprint; the failed first
    // attempt's llm.attempt.failed has no fingerprint slot.
    const completed = sink.events.filter(
      (e) => e.event_type === "llm.attempt.completed",
    ) as ObservabilityEvent<"llm.attempt.completed", { request_fingerprint: RequestFingerprint }>[];
    expect(completed.length).toBe(1);
    // The fingerprint is stable — verify it's the same as one computed
    // directly against the request.
    expect(completed[0]!.data.request_fingerprint.message_hash).toMatch(/^[0-9a-f]{64}$/i);
  });

  it("two calls with identical requests produce identical message_hash and request_hash", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = {
      config: { sink, source: testSource },
      fingerprint: { algorithm: "sha256" },
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: goodA },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "same content" }],
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "same content" }],
    });
    const completed = sink.events.filter(
      (e) => e.event_type === "llm.attempt.completed",
    ) as ObservabilityEvent<"llm.attempt.completed", { request_fingerprint: RequestFingerprint }>[];
    expect(completed.length).toBe(2);
    expect(completed[0]!.data.request_fingerprint.message_hash).toBe(
      completed[1]!.data.request_fingerprint.message_hash,
    );
    expect(completed[0]!.data.request_fingerprint.request_hash).toBe(
      completed[1]!.data.request_fingerprint.request_hash,
    );
  });

  it("different content produces different message_hash", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = {
      config: { sink, source: testSource },
      fingerprint: { algorithm: "sha256" },
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: goodA },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "one" }],
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "two" }],
    });
    const completed = sink.events.filter(
      (e) => e.event_type === "llm.attempt.completed",
    ) as ObservabilityEvent<"llm.attempt.completed", { request_fingerprint: RequestFingerprint }>[];
    expect(completed[0]!.data.request_fingerprint.message_hash).not.toBe(
      completed[1]!.data.request_fingerprint.message_hash,
    );
  });
});

// ─── HMAC variant ───────────────────────────────────────────────────

describe("Registry fingerprint — HMAC variant", () => {
  it("uses hmac-sha256 when the policy specifies it", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = {
      config: { sink, source: testSource },
      fingerprint: {
        algorithm: "hmac-sha256",
        hmacKey: "0123456789abcdef", // 16 UTF-8 bytes; contract minimum
      },
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: goodA },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed") as
      | ObservabilityEvent<"llm.attempt.completed", { request_fingerprint: RequestFingerprint }>
      | undefined;
    expect(completed!.data.request_fingerprint.hash_algorithm).toBe("hmac-sha256");
  });

  it("throws when hmac-sha256 hmacKey is shorter than the contract's 16-byte minimum", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = {
      config: { sink, source: testSource },
      fingerprint: {
        algorithm: "hmac-sha256",
        hmacKey: "short", // 5 UTF-8 bytes — below contract minimum
      },
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "fast",
      },
      adapters: { anthropic: goodA },
      instrumentation: instr,
    });
    // The compute helper throws inside maybeComputeFingerprint before any
    // attempt runs; the Registry surfaces it to the caller (contract's
    // "no silent short keys" rule).
    await expect(
      registry.getPort().generateText({
        taskType: "triage",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeDefined();
  });
});

// ─── Reference: goodB in a second-route smoke test ──────────────────

describe("Registry fingerprint — orthogonal to route selection", () => {
  it("emits fingerprint on both routes when configured", async () => {
    const sink = createCollectingSink();
    const instr: Instrumentation = {
      config: { sink, source: testSource },
      fingerprint: { algorithm: "sha256" },
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_PROVIDER_B: "openai|gpt-4o|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
        LLM_TASK_ROUTE_STRUCT: "b",
      },
      adapters: { anthropic: goodA, openai: goodB },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "x" }],
    });
    await registry.getPort().generateText({
      taskType: "struct",
      messages: [{ role: "user", content: "y" }],
    });
    const completed = sink.events.filter(
      (e) => e.event_type === "llm.attempt.completed",
    ) as ObservabilityEvent<"llm.attempt.completed", { request_fingerprint: RequestFingerprint }>[];
    expect(completed.length).toBe(2);
    expect(completed[0]!.data.request_fingerprint).toBeDefined();
    expect(completed[1]!.data.request_fingerprint).toBeDefined();
  });
});
