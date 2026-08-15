/**
 * Alpha.30 — Diagnostic track §2.3.1 (response_char_count) and §2.3.2
 * (response_preview + CapturePolicy.responsePreviewMaxChars).
 *
 * SalesCoach's TD-LLM-AUTH-ERROR-KILLS-THE-WHOLE-CHAIN closed with
 * an "unrelated observation" that empty-response successes under a
 * permissive schema were undebuggable — GenerateStructuredResult
 * exposes no view of the raw response body. This suite verifies the
 * two fields that close that gap, plus the per-method extractor
 * semantics that make the fields meaningful.
 */

import { describe, expect, it } from "vitest";
import {
  createRegistryFromEnv,
  type AdapterRegistration,
  type AgentResult,
  type GenerateStructuredResult,
  type GenerateTextResult,
  type Instrumentation,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";
import {
  createCollectingSink,
  DEFAULT_CAPTURE_POLICY,
  PERMISSIVE_CAPTURE_POLICY,
  type CapturePolicy,
  type EventSource,
  type ObservabilityEvent,
} from "@llm-ports/observability-contract";

const HAIKU_PRICING: ModelPricing = { inputPer1M: 0.8, outputPer1M: 4.0 };
const testSource: EventSource = { library: "test", library_version: "0.0.0" };

function instrumentationWith(policy?: CapturePolicy): {
  instr: Instrumentation;
  sink: ReturnType<typeof createCollectingSink>;
} {
  const sink = createCollectingSink();
  const instr: Instrumentation = { config: { sink, source: testSource } };
  if (policy) instr.capturePolicy = policy;
  return { instr, sink };
}

function attemptCompleted(
  sink: ReturnType<typeof createCollectingSink>,
): ObservabilityEvent<
  "llm.attempt.completed",
  { response_char_count?: number; response_preview?: string }
> {
  const e = sink.events.find((ev) => ev.event_type === "llm.attempt.completed");
  if (!e) throw new Error("no attempt.completed event found");
  return e as ObservabilityEvent<
    "llm.attempt.completed",
    { response_char_count?: number; response_preview?: string }
  >;
}

// ─── generateText ────────────────────────────────────────────────────

describe("Diagnostic — generateText", () => {
  function makeAdapter(responseText: string): AdapterRegistration {
    return {
      name: "anthropic",
      pricing: { "claude-haiku-4-5": HAIKU_PRICING },
      createLLMPort: (modelId, alias): LLMPort => ({
        async generateText(): Promise<GenerateTextResult> {
          return {
            text: responseText,
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
            cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
            modelId,
            providerAlias: alias,
            latencyMs: 1,
          };
        },
        async generateStructured() {
          throw new Error("nu");
        },
        async runAgent() {
          throw new Error("nu");
        },
        streamText: async function* () {
          yield "";
        },
        streamStructured: async function* () {
          yield {} as never;
        },
      }),
    };
  }

  it("emits response_char_count matching result.text.length", async () => {
    const { instr, sink } = instrumentationWith();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: makeAdapter("hello world") },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(attemptCompleted(sink).data.response_char_count).toBe(11);
  });

  it("does NOT emit response_preview under DEFAULT_CAPTURE_POLICY (content: none)", async () => {
    // Default policy explicitly on the instrumentation for the test —
    // matches what an undefined capturePolicy would produce anyway.
    const { instr, sink } = instrumentationWith(DEFAULT_CAPTURE_POLICY);
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: makeAdapter("hello world") },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    const ev = attemptCompleted(sink);
    expect(ev.data.response_char_count).toBe(11); // count always emits
    expect(ev.data.response_preview).toBeUndefined(); // preview gated
  });

  it("emits response_preview under PERMISSIVE_CAPTURE_POLICY (first 200 chars)", async () => {
    const { instr, sink } = instrumentationWith(PERMISSIVE_CAPTURE_POLICY);
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: makeAdapter("hello world") },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(attemptCompleted(sink).data.response_preview).toBe("hello world");
  });

  it("truncates response_preview to responsePreviewMaxChars", async () => {
    // 500-char response, policy caps at 50.
    const long = "a".repeat(500);
    const policy: CapturePolicy = {
      ...PERMISSIVE_CAPTURE_POLICY,
      responsePreviewMaxChars: 50,
    };
    const { instr, sink } = instrumentationWith(policy);
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: makeAdapter(long) },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    const ev = attemptCompleted(sink);
    expect(ev.data.response_char_count).toBe(500);
    expect(ev.data.response_preview!.length).toBe(50);
    expect(ev.data.response_preview).toBe("a".repeat(50));
  });

  it("responsePreviewMaxChars: 0 disables preview even under content: full", async () => {
    const policy: CapturePolicy = {
      ...PERMISSIVE_CAPTURE_POLICY,
      responsePreviewMaxChars: 0,
    };
    const { instr, sink } = instrumentationWith(policy);
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: makeAdapter("hello world") },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(attemptCompleted(sink).data.response_preview).toBeUndefined();
  });
});

// ─── generateStructured ──────────────────────────────────────────────

describe("Diagnostic — generateStructured", () => {
  function makeAdapter<T>(data: T): AdapterRegistration {
    return {
      name: "anthropic",
      pricing: { "claude-haiku-4-5": HAIKU_PRICING },
      createLLMPort: (modelId, alias): LLMPort => ({
        async generateText() {
          throw new Error("nu");
        },
        async generateStructured(): Promise<GenerateStructuredResult<T>> {
          return {
            data,
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
            cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
            modelId,
            providerAlias: alias,
            latencyMs: 1,
            validationAttempts: 1,
          };
        },
        async runAgent() {
          throw new Error("nu");
        },
        streamText: async function* () {
          yield "";
        },
        streamStructured: async function* () {
          yield {} as never;
        },
      }),
    };
  }

  it("empty-object success reports char_count 2 (the JSON.stringify of {})", async () => {
    const { instr, sink } = instrumentationWith();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: makeAdapter({}) },
      instrumentation: instr,
    });
    await registry.getPort().generateStructured({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
      schema: {} as never,
    });
    expect(attemptCompleted(sink).data.response_char_count).toBe(2); // "{}"
  });

  it("populated-object success reports non-trivial char_count", async () => {
    const { instr, sink } = instrumentationWith();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: {
        anthropic: makeAdapter({ intent: "question", confidence: 0.87 }),
      },
      instrumentation: instr,
    });
    await registry.getPort().generateStructured({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
      schema: {} as never,
    });
    const ev = attemptCompleted(sink);
    expect(ev.data.response_char_count).toBeGreaterThan(20);
  });

  it("preview under permissive policy shows the JSON.stringify text", async () => {
    const { instr, sink } = instrumentationWith(PERMISSIVE_CAPTURE_POLICY);
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: { anthropic: makeAdapter({ ok: true }) },
      instrumentation: instr,
    });
    await registry.getPort().generateStructured({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
      schema: {} as never,
    });
    expect(attemptCompleted(sink).data.response_preview).toBe('{"ok":true}');
  });
});

// ─── runAgent ────────────────────────────────────────────────────────

describe("Diagnostic — runAgent (first message for preview, final for char_count)", () => {
  function makeAgentAdapter(agentResult: AgentResult): AdapterRegistration {
    return {
      name: "anthropic",
      pricing: { "claude-haiku-4-5": HAIKU_PRICING },
      createLLMPort: (modelId, alias): LLMPort => ({
        async generateText() {
          throw new Error("nu");
        },
        async generateStructured() {
          throw new Error("nu");
        },
        async runAgent(): Promise<AgentResult> {
          return { ...agentResult, modelId, providerAlias: alias };
        },
        streamText: async function* () {
          yield "";
        },
        streamStructured: async function* () {
          yield {} as never;
        },
      }),
    };
  }

  it("char_count comes from the FINAL assistant message (result.text)", async () => {
    const agentResult: AgentResult = {
      text: "Final answer is 42.",
      messages: [
        { role: "user", content: "compute" },
        { role: "assistant", content: "First I need to invoke the calculator tool." },
        { role: "tool", content: "{\"result\": 42}" },
        { role: "assistant", content: "Final answer is 42." },
      ],
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
      modelId: "claude-haiku-4-5",
      providerAlias: "a",
      latencyMs: 1,
      stepsTaken: 2,
      terminationReason: "completed",
    };
    const { instr, sink } = instrumentationWith();
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_AGENT: "a",
      },
      adapters: { anthropic: makeAgentAdapter(agentResult) },
      instrumentation: instr,
    });
    await registry.getPort().runAgent({
      taskType: "agent",
      messages: [{ role: "user", content: "compute" }],
      tools: {},
    });
    expect(attemptCompleted(sink).data.response_char_count).toBe("Final answer is 42.".length);
  });

  it("preview shows the FIRST assistant message under permissive policy", async () => {
    const agentResult: AgentResult = {
      text: "Final answer is 42.",
      messages: [
        { role: "user", content: "compute" },
        { role: "assistant", content: "First I need to invoke the calculator tool." },
        { role: "tool", content: "{\"result\": 42}" },
        { role: "assistant", content: "Final answer is 42." },
      ],
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
      modelId: "claude-haiku-4-5",
      providerAlias: "a",
      latencyMs: 1,
      stepsTaken: 2,
      terminationReason: "completed",
    };
    const { instr, sink } = instrumentationWith(PERMISSIVE_CAPTURE_POLICY);
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_AGENT: "a",
      },
      adapters: { anthropic: makeAgentAdapter(agentResult) },
      instrumentation: instr,
    });
    await registry.getPort().runAgent({
      taskType: "agent",
      messages: [{ role: "user", content: "compute" }],
      tools: {},
    });
    expect(attemptCompleted(sink).data.response_preview).toBe(
      "First I need to invoke the calculator tool.",
    );
  });

  it("falls back to final text when messages array has no assistant message", async () => {
    // Unusual case: agent produced no assistant turn. Both fields fall
    // back to result.text so we still get something meaningful.
    const agentResult: AgentResult = {
      text: "(no assistant response)",
      messages: [{ role: "user", content: "compute" }],
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
      modelId: "claude-haiku-4-5",
      providerAlias: "a",
      latencyMs: 1,
      stepsTaken: 0,
      terminationReason: "completed",
    };
    const { instr, sink } = instrumentationWith(PERMISSIVE_CAPTURE_POLICY);
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_AGENT: "a",
      },
      adapters: { anthropic: makeAgentAdapter(agentResult) },
      instrumentation: instr,
    });
    await registry.getPort().runAgent({
      taskType: "agent",
      messages: [{ role: "user", content: "compute" }],
      tools: {},
    });
    expect(attemptCompleted(sink).data.response_preview).toBe("(no assistant response)");
  });
});

// ─── content: redacted also allows preview ─────────────────────────

describe("Diagnostic — content: redacted allows preview (redactor applies downstream)", () => {
  it("preview emits when policy.content === 'redacted'", async () => {
    const policy: CapturePolicy = {
      ...DEFAULT_CAPTURE_POLICY,
      content: "redacted",
      responsePreviewMaxChars: 100,
    };
    const { instr, sink } = instrumentationWith(policy);
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_A: "anthropic|claude-haiku-4-5|req:100/hour",
        LLM_TASK_ROUTE_TRIAGE: "a",
      },
      adapters: {
        anthropic: {
          name: "anthropic",
          pricing: { "claude-haiku-4-5": HAIKU_PRICING },
          createLLMPort: (modelId, alias): LLMPort => ({
            async generateText(): Promise<GenerateTextResult> {
              return {
                text: "hello",
                usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
                cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
                modelId,
                providerAlias: alias,
                latencyMs: 1,
              };
            },
            async generateStructured() {
              throw new Error("nu");
            },
            async runAgent() {
              throw new Error("nu");
            },
            streamText: async function* () {
              yield "";
            },
            streamStructured: async function* () {
              yield {} as never;
            },
          }),
        },
      },
      instrumentation: instr,
    });
    await registry.getPort().generateText({
      taskType: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(attemptCompleted(sink).data.response_preview).toBe("hello");
  });
});
