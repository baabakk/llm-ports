/**
 * Alpha.30 §2.7 — core-side streaming instrumentation.
 *
 * Verifies the Registry's `streamText` / `streamStructured`:
 *   - Emit the standard operation + attempt lifecycle (started + completed)
 *     around streamed calls, matching non-streaming methods.
 *   - Compute `stream_stats` (ttft_ms, chunk_count, inter-chunk
 *     percentiles, termination) from real per-chunk timings and attach
 *     it to `llm.attempt.completed`.
 *   - Attach `response_char_count` verbatim and `response_preview`
 *     only when the CapturePolicy allows content + previewMaxChars > 0.
 *   - Emit `llm.stream.chunk` per chunk only when
 *     `stream_chunk_capture === "full"`, with `chunk_content` gated
 *     by the content policy.
 *   - Emit `llm.attempt.failed` + `llm.operation.failed` on a mid-stream
 *     error, and `llm.operation.cancelled` when the consumer aborts.
 *   - Emit fallback events + a fresh `attempt.started` when the first
 *     provider fails at stream-open (chain walk mirrors non-stream
 *     methods).
 *   - Emit the same 4-event happy path for `streamStructured`, with
 *     char accounting via `JSON.stringify`.
 */

import { describe, expect, it } from "vitest";
import {
  createCollectingSink,
  PERMISSIVE_CAPTURE_POLICY,
  type AttemptCompletedData,
  type EventSource,
  type StreamChunkData,
} from "@llm-ports/observability-contract";
import {
  createRegistryFromEnv,
  ProviderUnavailableError,
  readStreamCompleteCallback,
  type AdapterRegistration,
  type AgentResult,
  type GenerateStructuredResult,
  type GenerateTextResult,
  type Instrumentation,
  type LLMPort,
  type ModelPricing,
  type StreamCompleteCallback,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1.0, outputPer1M: 2.0 };
const testSource: EventSource = { library: "test", library_version: "0.0.0" };

function collectingInstrumentation(overrides?: Partial<Instrumentation>): {
  instr: Instrumentation;
  sink: ReturnType<typeof createCollectingSink>;
} {
  const sink = createCollectingSink();
  return {
    instr: { config: { sink, source: testSource }, ...overrides },
    sink,
  };
}

/**
 * Build a streaming port that (a) yields the given chunks with
 * configurable delays between them, (b) fires the stream-complete
 * callback with canned usage/cost, (c) may throw mid-stream if asked.
 */
function makeStreamingPort(opts?: {
  chunks?: string[];
  gapMs?: number;
  fireCallback?: boolean;
  modelId?: string;
  providerAlias?: string;
  throwAt?: number;
  throwError?: () => Error;
}): LLMPort {
  const chunks = opts?.chunks ?? ["hello ", "world"];
  const gapMs = opts?.gapMs ?? 0;
  const fireCallback = opts?.fireCallback ?? true;
  const modelId = opts?.modelId ?? "model-mock";
  const providerAlias = opts?.providerAlias ?? "primary";
  const throwAt = opts?.throwAt;
  const throwError = opts?.throwError ?? (() => new Error("mid-stream boom"));
  return {
    async generateText(): Promise<GenerateTextResult> {
      throw new Error("unused");
    },
    async generateStructured<T>(): Promise<GenerateStructuredResult<T>> {
      throw new Error("unused");
    },
    async runAgent(): Promise<AgentResult> {
      throw new Error("unused");
    },
    streamText: async function* (options) {
      const cb: StreamCompleteCallback | undefined = readStreamCompleteCallback(options);
      for (let i = 0; i < chunks.length; i++) {
        if (throwAt !== undefined && i === throwAt) {
          throw throwError();
        }
        if (i > 0 && gapMs > 0) {
          await new Promise((r) => setTimeout(r, gapMs));
        }
        yield chunks[i]!;
      }
      if (fireCallback && cb) {
        cb({
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          cost: { inputUSD: 0.0001, outputUSD: 0.00004, totalUSD: 0.00014 },
          modelId,
          providerAlias,
          latencyMs: 42,
        });
      }
    },
    streamStructured: async function* (options) {
      const cb: StreamCompleteCallback | undefined = readStreamCompleteCallback(options);
      const partials = [{ a: 1 }, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }];
      for (const p of partials) {
        yield p as never;
      }
      if (fireCallback && cb) {
        cb({
          usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
          cost: { inputUSD: 0.00004, outputUSD: 0.00002, totalUSD: 0.00006 },
          modelId,
          providerAlias,
          latencyMs: 10,
        });
      }
    },
  };
}

describe("Alpha.30 streamText — happy path emissions", () => {
  it("emits operation.started + attempt.started + attempt.completed + operation.completed", async () => {
    const { instr, sink } = collectingInstrumentation();
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort(),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });
    const collected: string[] = [];
    for await (const chunk of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      collected.push(chunk);
    }
    expect(collected.join("")).toBe("hello world");

    const types = sink.events.map((e) => e.event_type);
    expect(types).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "llm.attempt.completed",
      "llm.operation.completed",
    ]);
  });

  it("attaches stream_stats with ttft_ms, chunk_count, and termination='complete'", async () => {
    const { instr, sink } = collectingInstrumentation();
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () =>
        makeStreamingPort({ chunks: ["a", "b", "c", "d"], gapMs: 5 }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });

    // Drain
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      /* noop */
    }

    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed");
    expect(completed).toBeDefined();
    const data = completed!.data as AttemptCompletedData;
    expect(data.stream_stats).toBeDefined();
    const stats = data.stream_stats!;
    expect(stats.chunk_count).toBe(4);
    expect(stats.termination).toBe("complete");
    expect(stats.ttft_ms).toBeGreaterThanOrEqual(0);
    // 4 chunks → 3 gaps of ~5ms each; percentiles present and non-negative
    expect(stats.inter_chunk_latency_p50_ms).toBeGreaterThanOrEqual(0);
    expect(stats.inter_chunk_latency_p99_ms).toBeGreaterThanOrEqual(
      stats.inter_chunk_latency_p50_ms!,
    );
    expect(stats.total_stream_duration_ms).toBeGreaterThanOrEqual(stats.ttft_ms);
  });

  it("omits percentiles when only one chunk was yielded (no gaps sampled)", async () => {
    const { instr, sink } = collectingInstrumentation();
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort({ chunks: ["only"] }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      /* drain */
    }
    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed");
    const stats = (completed!.data as AttemptCompletedData).stream_stats!;
    expect(stats.chunk_count).toBe(1);
    expect(stats.inter_chunk_latency_p50_ms).toBeUndefined();
    expect(stats.inter_chunk_latency_p99_ms).toBeUndefined();
  });

  it("threads adapter-reported usage + cost + modelId into attempt.completed", async () => {
    const { instr, sink } = collectingInstrumentation();
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort(),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      /* drain */
    }
    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed");
    const data = completed!.data as AttemptCompletedData;
    expect(data.usage.inputTokens).toBe(100);
    expect(data.usage.outputTokens).toBe(20);
    expect(data.cost.totalUSD).toBeCloseTo(0.00014, 6);
    expect(data.final_model_id).toBe("model-mock");
  });
});

describe("Alpha.30 streamText — diagnostic fields", () => {
  it("always emits response_char_count (never gated by policy)", async () => {
    const { instr, sink } = collectingInstrumentation(); // default policy: content off
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort({ chunks: ["hello ", "world"] }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      /* drain */
    }
    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed");
    const data = completed!.data as AttemptCompletedData;
    expect(data.response_char_count).toBe("hello world".length);
    // Preview off in default policy
    expect(data.response_preview).toBeUndefined();
  });

  it("emits response_preview capped to responsePreviewMaxChars under permissive policy", async () => {
    const { instr, sink } = collectingInstrumentation({
      capturePolicy: { ...PERMISSIVE_CAPTURE_POLICY, responsePreviewMaxChars: 8 },
    });
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () =>
        makeStreamingPort({ chunks: ["hello ", "world", "!!!"] }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      /* drain */
    }
    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed");
    const data = completed!.data as AttemptCompletedData;
    // First 8 chars of "hello world!!!" == "hello wo"
    expect(data.response_preview).toBe("hello wo");
    expect(data.response_char_count).toBe("hello world!!!".length);
  });
});

describe("Alpha.30 streamText — per-chunk emission", () => {
  it("emits llm.stream.chunk per chunk when stream_chunk_capture is 'full'", async () => {
    const { instr, sink } = collectingInstrumentation({
      capturePolicy: {
        ...PERMISSIVE_CAPTURE_POLICY,
        stream_chunk_capture: "full",
      },
    });
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort({ chunks: ["a", "bb", "ccc"] }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      /* drain */
    }
    const chunkEvents = sink.events.filter((e) => e.event_type === "llm.stream.chunk");
    expect(chunkEvents).toHaveLength(3);
    const contents = chunkEvents.map((e) => (e.data as StreamChunkData).chunk_content);
    expect(contents).toEqual(["a", "bb", "ccc"]);
    const idxs = chunkEvents.map((e) => (e.data as StreamChunkData).chunk_index);
    expect(idxs).toEqual([0, 1, 2]);
  });

  it("suppresses chunk_content when content policy is 'none' even under stream_chunk_capture='full'", async () => {
    // Default capture policy has content: "none" but we override
    // stream_chunk_capture to "full" — the aggregate per-chunk telemetry
    // still emits, but the content field must NOT.
    const { instr, sink } = collectingInstrumentation({
      capturePolicy: {
        content: "none",
        fingerprint: "sha256",
        baggage_allowlist: [],
        error_body_capture: "redacted",
        stream_chunk_capture: "full",
      },
    });
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort({ chunks: ["a", "b"] }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      /* drain */
    }
    const chunkEvents = sink.events.filter((e) => e.event_type === "llm.stream.chunk");
    expect(chunkEvents).toHaveLength(2);
    for (const ev of chunkEvents) {
      const data = ev.data as StreamChunkData;
      expect(data.chunk_content).toBeUndefined();
      expect(data.chars_in_chunk).toBeGreaterThan(0);
    }
  });

  it("does NOT emit llm.stream.chunk when stream_chunk_capture is 'off' (default)", async () => {
    const { instr, sink } = collectingInstrumentation();
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort({ chunks: ["a", "b", "c"] }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      /* drain */
    }
    const chunkEvents = sink.events.filter((e) => e.event_type === "llm.stream.chunk");
    expect(chunkEvents).toHaveLength(0);
  });
});

describe("Alpha.30 streamText — failure and cancellation paths", () => {
  it("emits attempt.failed + operation.failed on mid-stream error (no stream_stats leaked to failure event)", async () => {
    const { instr, sink } = collectingInstrumentation();
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () =>
        makeStreamingPort({
          chunks: ["ok ", "boom"],
          throwAt: 1,
          throwError: () => new Error("mid-stream boom"),
        }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of registry
        .getPort()
        .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
        /* drain */
      }
    }).rejects.toThrow(/mid-stream boom/);

    const types = sink.events.map((e) => e.event_type);
    expect(types).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "llm.attempt.failed",
      "llm.operation.failed",
    ]);
    // No stream_stats on failure envelope (contract only carries it on
    // attempt.completed today; failure event has no such field).
    const failed = sink.events.find((e) => e.event_type === "llm.attempt.failed")!;
    expect((failed.data as unknown as { stream_stats?: unknown }).stream_stats).toBeUndefined();
  });

  it("emits operation.cancelled when the consumer aborts mid-stream (AbortError)", async () => {
    const { instr, sink } = collectingInstrumentation();
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () =>
        makeStreamingPort({
          chunks: ["a ", "b ", "c"],
          throwAt: 1,
          throwError: () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            return e;
          },
        }),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of registry
        .getPort()
        .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
        /* drain */
      }
    }).rejects.toThrow(/aborted/);

    const types = sink.events.map((e) => e.event_type);
    expect(types).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "llm.attempt.failed",
      "llm.operation.cancelled",
    ]);
  });
});

describe("Alpha.30 streamText — fallback chain across providers", () => {
  it("emits failed+fallback+started+completed when the first provider fails at stream-open", async () => {
    const { instr, sink } = collectingInstrumentation();
    const failingAdapter: AdapterRegistration = {
      name: "failing-adapter",
      pricing: { "model-bad": { inputPer1M: 1, outputPer1M: 1 } },
      createLLMPort: (_modelId, alias) => ({
        async generateText(): Promise<GenerateTextResult> {
          throw new Error("unused");
        },
        async generateStructured<T>(): Promise<GenerateStructuredResult<T>> {
          throw new Error("unused");
        },
        async runAgent() {
          throw new Error("unused");
        },
        streamText: () => {
          throw new ProviderUnavailableError(alias, new Error("stub down"));
        },
        streamStructured: () => {
          throw new ProviderUnavailableError(alias, new Error("stub down"));
        },
      }),
    };
    const goodAdapter: AdapterRegistration = {
      name: "good-adapter",
      pricing: { "model-good": PRICING },
      createLLMPort: () => makeStreamingPort({ chunks: ["fallback ok"] }),
    };

    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "failing-adapter|model-bad|req:100/hour",
        LLM_PROVIDER_BACKUP: "good-adapter|model-good|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary,backup",
      },
      adapters: { "failing-adapter": failingAdapter, "good-adapter": goodAdapter },
      instrumentation: instr,
    });

    const collected: string[] = [];
    for await (const chunk of registry
      .getPort()
      .streamText({ taskType: "test", messages: [{ role: "user", content: "hi" }] })) {
      collected.push(chunk);
    }
    expect(collected.join("")).toBe("fallback ok");

    const types = sink.events.map((e) => e.event_type);
    expect(types).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "llm.attempt.failed",
      "llm.fallback.selected",
      "llm.attempt.started",
      "llm.attempt.completed",
      "llm.operation.completed",
    ]);
  });
});

describe("Alpha.30 streamStructured — happy path and char accounting", () => {
  it("emits the 4-event lifecycle and stream_stats with chunk_count from partials", async () => {
    const { instr, sink } = collectingInstrumentation();
    const adapter: AdapterRegistration = {
      name: "primary-adapter",
      pricing: { "model-mock": PRICING },
      createLLMPort: () => makeStreamingPort(),
    };
    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_PRIMARY: "primary-adapter|model-mock|req:100/hour",
        LLM_TASK_ROUTE_TEST: "primary",
      },
      adapters: { "primary-adapter": adapter },
      instrumentation: instr,
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of registry
      .getPort()
      .streamStructured({
        taskType: "test",
        messages: [{ role: "user", content: "hi" }],
        // Structured stream needs a schema on the caller side; the mock
        // ignores it, so an empty passthrough is fine.
        schema: {
          _def: {},
          parse: (v: unknown) => v,
          safeParse: (v: unknown) => ({ success: true as const, data: v }),
        } as never,
      })) {
      /* drain */
    }

    const types = sink.events.map((e) => e.event_type);
    expect(types).toEqual([
      "llm.operation.started",
      "llm.attempt.started",
      "llm.attempt.completed",
      "llm.operation.completed",
    ]);

    const completed = sink.events.find((e) => e.event_type === "llm.attempt.completed");
    const data = completed!.data as AttemptCompletedData;
    expect(data.stream_stats!.chunk_count).toBe(3);
    // Chars accounted via JSON.stringify of the partials.
    // {"a":1} + {"a":1,"b":2} + {"a":1,"b":2,"c":3} = 7 + 13 + 19 = 39
    expect(data.response_char_count).toBe(7 + 13 + 19);
  });
});
