/**
 * Tests for withObservabilityContext / getObservabilityContext.
 */

import type {
  AgentResult,
  GenerateStructuredOptions,
  GenerateStructuredResult,
  GenerateTextOptions,
  GenerateTextResult,
  LLMPort,
  ProviderModelInfo,
  RunAgentOptions,
  StreamStructuredOptions,
  StreamTextOptions,
} from "@llm-ports/core";
import { getObservabilityContext, withObservabilityContext } from "@llm-ports/core";
import type { ObservabilityContext } from "@llm-ports/observability-contract";
import { describe, expect, it } from "vitest";

// ─── A minimal fake LLMPort for testing ─────────────────────────────

function fakeText(text: string): GenerateTextResult {
  return {
    text,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
    modelId: "fake",
    providerAlias: "fake",
    latencyMs: 0,
  };
}

function makeFakePort(recorder: string[] = []): LLMPort & { recorder: string[] } {
  return {
    recorder,
    async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
      recorder.push("generateText");
      return fakeText("hello");
    },
    async generateStructured<T>(
      _options: GenerateStructuredOptions<T>,
    ): Promise<GenerateStructuredResult<T>> {
      recorder.push("generateStructured");
      return {
        data: {} as T,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
        modelId: "fake",
        providerAlias: "fake",
        latencyMs: 0,
        validationAttempts: 0,
      };
    },
    streamText: async function* (_options: StreamTextOptions): AsyncIterable<string> {
      recorder.push("streamText");
      yield "hello";
    },
    streamStructured: async function* <T>(
      _options: StreamStructuredOptions<T>,
    ): AsyncIterable<T> {
      recorder.push("streamStructured");
      yield {} as T;
    },
    async runAgent(_options: RunAgentOptions): Promise<AgentResult> {
      recorder.push("runAgent");
      return {
        text: "hello",
        messages: [],
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
        modelId: "fake",
        providerAlias: "fake",
        latencyMs: 0,
        stepsTaken: 0,
        terminationReason: "completed",
      };
    },
    async listModels(): Promise<ProviderModelInfo[]> {
      recorder.push("listModels");
      return [];
    },
  };
}

describe("withObservabilityContext (§4.2 scoped-port wrapper)", () => {
  describe("wraps a port without breaking the LLMPort interface", () => {
    it("forwards generateText to the underlying port", async () => {
      const recorder: string[] = [];
      const port = makeFakePort(recorder);
      const wrapped = withObservabilityContext(port, { operation_id: "op-1" });

      await wrapped.generateText({ taskType: "test", messages: [] });
      expect(recorder).toEqual(["generateText"]);
    });

    it("forwards generateStructured", async () => {
      const recorder: string[] = [];
      const port = makeFakePort(recorder);
      const wrapped = withObservabilityContext(port, { operation_id: "op-1" });

      await wrapped.generateStructured({
        taskType: "test",
        messages: [],
        schema: undefined as never,
      });
      expect(recorder).toEqual(["generateStructured"]);
    });

    it("forwards runAgent", async () => {
      const recorder: string[] = [];
      const port = makeFakePort(recorder);
      const wrapped = withObservabilityContext(port, { operation_id: "op-1" });

      await wrapped.runAgent({
        taskType: "test",
        messages: [],
        tools: {},
      });
      expect(recorder).toEqual(["runAgent"]);
    });

    it("forwards listModels", async () => {
      const recorder: string[] = [];
      const port = makeFakePort(recorder);
      const wrapped = withObservabilityContext(port, { operation_id: "op-1" });

      const models = await wrapped.listModels!();
      expect(models).toEqual([]);
      expect(recorder).toEqual(["listModels"]);
    });

    it("forwards streaming methods", async () => {
      const recorder: string[] = [];
      const port = makeFakePort(recorder);
      const wrapped = withObservabilityContext(port, { operation_id: "op-1" });

      const stream = wrapped.streamText({ taskType: "test", messages: [] });
      for await (const _chunk of stream) {
        // consume
      }
      expect(recorder).toContain("streamText");
    });

    it("preserves `this` binding when methods are destructured", async () => {
      const recorder: string[] = [];
      const port = makeFakePort(recorder);
      const wrapped = withObservabilityContext(port, { operation_id: "op-1" });

      const { generateText } = wrapped;
      await generateText({ taskType: "test", messages: [] });
      expect(recorder).toEqual(["generateText"]);
    });
  });

  describe("getObservabilityContext retrieves the stored context", () => {
    it("returns the context for a wrapped port", () => {
      const port = makeFakePort();
      const ctx: ObservabilityContext = {
        operation_id: "op-1",
        traceparent: "00-abc",
        baggage: [{ key: "tenant_id", value: "acme" }],
      };
      const wrapped = withObservabilityContext(port, ctx);
      const retrieved = getObservabilityContext(wrapped);
      expect(retrieved).toBeDefined();
      expect(retrieved?.operation_id).toBe("op-1");
      expect(retrieved?.traceparent).toBe("00-abc");
      expect(retrieved?.baggage?.[0]?.key).toBe("tenant_id");
    });

    it("returns undefined for an unwrapped port", () => {
      const port = makeFakePort();
      expect(getObservabilityContext(port)).toBeUndefined();
    });

    it("returns undefined for a plain object that happens to look like a port", () => {
      const notAPort: LLMPort = {} as LLMPort;
      expect(getObservabilityContext(notAPort)).toBeUndefined();
    });
  });

  describe("Composition: wrapping a wrapped port merges the contexts", () => {
    it("later scalar fields override earlier ones", () => {
      const port = makeFakePort();
      const outer = withObservabilityContext(port, {
        operation_id: "op-outer",
        parent_operation_id: "op-parent",
      });
      const inner = withObservabilityContext(outer, { operation_id: "op-inner" });

      const ctx = getObservabilityContext(inner);
      expect(ctx?.operation_id).toBe("op-inner");
      expect(ctx?.parent_operation_id).toBe("op-parent"); // inherited from outer
    });

    it("baggage entries are concatenated; right wins on duplicate keys", () => {
      const port = makeFakePort();
      const outer = withObservabilityContext(port, {
        baggage: [
          { key: "tenant_id", value: "acme" },
          { key: "region", value: "us-west" },
        ],
      });
      const inner = withObservabilityContext(outer, {
        baggage: [
          { key: "tenant_id", value: "override" },
          { key: "feature", value: "beta" },
        ],
      });

      const ctx = getObservabilityContext(inner);
      const kvs = new Map(ctx?.baggage?.map((e) => [e.key, e.value]));
      expect(kvs.get("tenant_id")).toBe("override"); // right wins
      expect(kvs.get("region")).toBe("us-west"); // inherited from outer
      expect(kvs.get("feature")).toBe("beta"); // new from inner
    });

    it("attributes are merged with right overriding left", () => {
      const port = makeFakePort();
      const outer = withObservabilityContext(port, {
        attributes: { tier: "gold", region: "us-west" },
      });
      const inner = withObservabilityContext(outer, {
        attributes: { tier: "platinum", experiment: "A" },
      });

      const ctx = getObservabilityContext(inner);
      expect(ctx?.attributes?.tier).toBe("platinum"); // right wins
      expect(ctx?.attributes?.region).toBe("us-west"); // inherited from outer
      expect(ctx?.attributes?.experiment).toBe("A"); // new from inner
    });

    it("wrapping the same underlying port twice returns distinct wrapped instances with distinct contexts", () => {
      const port = makeFakePort();
      const a = withObservabilityContext(port, { operation_id: "op-a" });
      const b = withObservabilityContext(port, { operation_id: "op-b" });

      expect(a).not.toBe(b);
      expect(getObservabilityContext(a)?.operation_id).toBe("op-a");
      expect(getObservabilityContext(b)?.operation_id).toBe("op-b");
      // The underlying port itself is unaffected.
      expect(getObservabilityContext(port)).toBeUndefined();
    });
  });

  describe("HMAC fingerprint key passthrough", () => {
    it("stores fingerprint_key on the context", () => {
      const port = makeFakePort();
      const wrapped = withObservabilityContext(port, {
        operation_id: "op-1",
        fingerprint_key: "0123456789abcdef0123456789abcdef",
      });

      const ctx = getObservabilityContext(wrapped);
      expect(ctx?.fingerprint_key).toBe("0123456789abcdef0123456789abcdef");
    });
  });

  describe("conversation_id passthrough", () => {
    it("stores conversation_id on the context", () => {
      const port = makeFakePort();
      const wrapped = withObservabilityContext(port, {
        operation_id: "op-1",
        conversation_id: "conv-42",
      });

      expect(getObservabilityContext(wrapped)?.conversation_id).toBe("conv-42");
    });
  });
});
