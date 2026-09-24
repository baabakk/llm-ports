/**
 * `createOtelSink` — verify the OTel semconv mapping matches the
 * alpha.30 plan §2.8 table on real event envelopes emitted by the
 * shared instrumentation service.
 */

import { describe, expect, it } from "vitest";
import {
  buildEvent,
  createCollectingSink,
  type AnyObservabilityEvent,
  type EventSource,
  type ObservabilitySink,
} from "@llm-ports/observability-contract";
import {
  createOtelSink,
  SPAN_STATUS_ERROR,
  SPAN_STATUS_OK,
  type Attributes,
  type Counter,
  type CounterOptions,
  type Histogram,
  type HistogramOptions,
  type Meter,
  type Span,
  type SpanOptions,
  type SpanStatus,
  type Tracer,
} from "../src/index.js";

// ─── In-memory Tracer + Meter fakes ─────────────────────────────────

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; attributes: Record<string, unknown> }>;
  exceptions: Array<{ message: string; name?: string }>;
  status?: SpanStatus;
  ended: boolean;
}

function makeFakeTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    startSpan(name: string, options?: SpanOptions): Span {
      const recorded: RecordedSpan = {
        name,
        attributes: { ...(options?.attributes as Record<string, unknown> | undefined) },
        events: [],
        exceptions: [],
        ended: false,
      };
      spans.push(recorded);
      return {
        setAttribute(key, value) {
          recorded.attributes[key] = value;
        },
        setAttributes(attrs) {
          Object.assign(recorded.attributes, attrs);
        },
        addEvent(evName, attrs) {
          recorded.events.push({
            name: evName,
            attributes: { ...(attrs as Record<string, unknown> | undefined) },
          });
        },
        recordException(exc) {
          recorded.exceptions.push({ message: exc.message, name: exc.name });
        },
        setStatus(status) {
          recorded.status = status;
        },
        end() {
          recorded.ended = true;
        },
      };
    },
  };
  return { tracer, spans };
}

interface RecordedSample {
  name: string;
  value: number;
  attributes: Record<string, unknown>;
}

function makeFakeMeter(): { meter: Meter; samples: RecordedSample[]; instruments: string[] } {
  const samples: RecordedSample[] = [];
  const instruments: string[] = [];
  const meter: Meter = {
    createHistogram(name: string, _options?: HistogramOptions): Histogram {
      instruments.push(name);
      return {
        record(value: number, attributes?: Attributes) {
          samples.push({
            name,
            value,
            attributes: { ...(attributes as Record<string, unknown> | undefined) },
          });
        },
      };
    },
    createCounter(name: string, _options?: CounterOptions): Counter {
      instruments.push(name);
      return {
        add(value: number, attributes?: Attributes) {
          samples.push({
            name,
            value,
            attributes: { ...(attributes as Record<string, unknown> | undefined) },
          });
        },
      };
    },
  };
  return { meter, samples, instruments };
}

const testSource: EventSource = { library: "test", library_version: "0.0.0" };

// Helper: build a contract event via the standalone emitter helpers.
function ev(
  sink: ObservabilitySink,
  type:
    | "llm.operation.started"
    | "llm.operation.completed"
    | "llm.operation.failed"
    | "llm.operation.cancelled"
    | "llm.attempt.started"
    | "llm.attempt.completed"
    | "llm.attempt.failed"
    | "llm.stream.chunk"
    | "agent.step.started"
    | "agent.step.completed"
    | "agent.tool.called"
    | "agent.tool.returned",
  correlation: { operation_id: string; attempt_id?: string },
  data: unknown,
): AnyObservabilityEvent {
  const built = buildEvent(
    { source: testSource, sink },
    type,
    correlation,
    data as never,
  );
  return built as AnyObservabilityEvent;
}

describe("createOtelSink — operation lifecycle", () => {
  it("opens a span on llm.operation.started with gen_ai.operation.name", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });

    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "triage",
        method: "generateText",
        provider_chain: ["openai", "anthropic"],
      }),
    );

    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.name).toBe("gen_ai.generateText");
    expect(s.attributes["gen_ai.operation.name"]).toBe("generateText");
    expect(s.attributes["gen_ai.task_type"]).toBe("triage");
    expect(s.attributes["gen_ai.provider_chain"]).toBe("openai,anthropic");
    expect(s.ended).toBe(false);
  });

  it("annotates the open span on llm.attempt.completed with gen_ai.* usage attributes", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });

    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "triage",
        method: "generateText",
        provider_chain: ["openai"],
      }),
    );
    otel.emit(
      ev(capture, "llm.attempt.completed", { operation_id: "op1", attempt_id: "att1" }, {
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        latency_ms: 500,
        final_model_id: "gpt-4o",
        provider_response_id: "chatcmpl-abc",
      }),
    );

    const s = spans[0]!;
    expect(s.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(s.attributes["gen_ai.response.model"]).toBe("gpt-4o");
    expect(s.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(s.attributes["gen_ai.usage.output_tokens"]).toBe(20);
    expect(s.attributes["gen_ai.usage.total_tokens"]).toBe(120);
    expect(s.attributes["gen_ai.response.id"]).toBe("chatcmpl-abc");
  });

  it("closes the span with OK on llm.operation.completed", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "generateText",
        provider_chain: ["openai"],
      }),
    );
    otel.emit(
      ev(capture, "llm.operation.completed", { operation_id: "op1" }, {
        aggregate_usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        aggregate_cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
        attempts_made: 1,
        final_provider_alias: "openai",
        total_duration_ms: 500,
      }),
    );
    expect(spans[0]!.status?.code).toBe(SPAN_STATUS_OK);
    expect(spans[0]!.ended).toBe(true);
  });

  it("closes the span with ERROR + recordException on llm.operation.failed", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "generateText",
        provider_chain: ["openai"],
      }),
    );
    otel.emit(
      ev(capture, "llm.operation.failed", { operation_id: "op1" }, {
        error: {
          error_type: "AuthenticationError",
          message: "401",
          cause_category: "authentication",
          retryable: false,
          fallback_worthy: false,
        },
        attempts_made: 1,
        providers_tried: ["openai"],
        total_duration_ms: 100,
      }),
    );
    expect(spans[0]!.status?.code).toBe(SPAN_STATUS_ERROR);
    expect(spans[0]!.status?.message).toBe("401");
    expect(spans[0]!.exceptions).toEqual([{ message: "401", name: "AuthenticationError" }]);
    expect(spans[0]!.ended).toBe(true);
  });

  it("closes the span with ERROR + 'cancelled' message on llm.operation.cancelled", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "generateText",
        provider_chain: ["openai"],
      }),
    );
    otel.emit(
      ev(capture, "llm.operation.cancelled", { operation_id: "op1" }, {
        cancelled_at_attempt: 1,
        providers_tried_before_cancel: ["openai"],
        total_duration_ms: 100,
      }),
    );
    expect(spans[0]!.status?.code).toBe(SPAN_STATUS_ERROR);
    expect(spans[0]!.status?.message).toBe("cancelled");
    expect(spans[0]!.ended).toBe(true);
  });

  it("cleans the internal span map so a completed op_id can be reused later", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "generateText",
        provider_chain: ["openai"],
      }),
    );
    otel.emit(
      ev(capture, "llm.operation.completed", { operation_id: "op1" }, {
        aggregate_usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        aggregate_cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
        attempts_made: 1,
        final_provider_alias: "openai",
        total_duration_ms: 100,
      }),
    );
    // Reopen with the same op_id — this should produce a NEW span (not
    // reuse the closed one). The fake tracer records each startSpan call.
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "generateText",
        provider_chain: ["openai"],
      }),
    );
    expect(spans).toHaveLength(2);
  });
});

describe("createOtelSink — metric samples", () => {
  it("creates all three semconv histograms on construction when meter is supplied", () => {
    const { tracer } = makeFakeTracer();
    const { meter, instruments } = makeFakeMeter();
    createOtelSink({ tracer, meter });
    expect(instruments).toContain("gen_ai.client.token.usage");
    expect(instruments).toContain("gen_ai.client.operation.duration");
    expect(instruments).toContain("gen_ai.client.cache.read_tokens");
  });

  it("records token-usage + duration histograms on attempt.completed", () => {
    const { tracer } = makeFakeTracer();
    const { meter, samples } = makeFakeMeter();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer, meter });
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "generateText",
        provider_chain: ["openai"],
      }),
    );
    otel.emit(
      ev(capture, "llm.attempt.completed", { operation_id: "op1", attempt_id: "att1" }, {
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        latency_ms: 500,
        final_model_id: "gpt-4o",
      }),
    );

    const tokenSamples = samples.filter((s) => s.name === "gen_ai.client.token.usage");
    expect(tokenSamples).toHaveLength(2);
    expect(tokenSamples.find((s) => s.attributes["gen_ai.token.type"] === "input")?.value).toBe(100);
    expect(tokenSamples.find((s) => s.attributes["gen_ai.token.type"] === "output")?.value).toBe(20);
    const durSample = samples.find((s) => s.name === "gen_ai.client.operation.duration");
    expect(durSample?.value).toBe(0.5); // seconds
    expect(durSample?.attributes["gen_ai.response.model"]).toBe("gpt-4o");
  });

  it("records provider-cache-read histogram when cache_stats.provider_cache.read_input_tokens > 0", () => {
    const { tracer } = makeFakeTracer();
    const { meter, samples } = makeFakeMeter();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer, meter });
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "generateText",
        provider_chain: ["openai"],
      }),
    );
    otel.emit(
      ev(capture, "llm.attempt.completed", { operation_id: "op1", attempt_id: "att1" }, {
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        latency_ms: 500,
        final_model_id: "gpt-4o",
        cache_stats: {
          provider_cache: {
            status: "hit",
            read_input_tokens: 80,
            provider_reported: true,
          },
        },
      }),
    );
    const cacheSample = samples.find((s) => s.name === "gen_ai.client.cache.read_tokens");
    expect(cacheSample?.value).toBe(80);
  });

  it("suppresses metrics entirely when meter is omitted (tracing-only mode)", () => {
    const { tracer } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer }); // no meter
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "generateText",
        provider_chain: ["openai"],
      }),
    );
    // Should not throw.
    otel.emit(
      ev(capture, "llm.attempt.completed", { operation_id: "op1", attempt_id: "att1" }, {
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        latency_ms: 500,
        final_model_id: "gpt-4o",
      }),
    );
  });
});

describe("createOtelSink — span events (stream + agent)", () => {
  it("adds a gen_ai.stream.chunk span event on llm.stream.chunk", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "streamText",
        provider_chain: ["openai"],
      }),
    );
    otel.emit(
      ev(capture, "llm.stream.chunk", { operation_id: "op1", attempt_id: "att1" }, {
        chunk_index: 3,
        chars_in_chunk: 12,
        time_since_start_ms: 250,
        chunk_content: "hello world!",
      }),
    );
    const evtnames = spans[0]!.events.map((e) => e.name);
    expect(evtnames).toEqual(["gen_ai.stream.chunk"]);
    expect(spans[0]!.events[0]!.attributes["gen_ai.stream.chunk_index"]).toBe(3);
    expect(spans[0]!.events[0]!.attributes["gen_ai.stream.chars_in_chunk"]).toBe(12);
    expect(spans[0]!.events[0]!.attributes["gen_ai.stream.chunk_content"]).toBe("hello world!");
  });

  it("suppresses stream-chunk events when emitStreamChunkEvents is false", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer, emitStreamChunkEvents: false });
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "streamText",
        provider_chain: ["openai"],
      }),
    );
    otel.emit(
      ev(capture, "llm.stream.chunk", { operation_id: "op1", attempt_id: "att1" }, {
        chunk_index: 0,
        chars_in_chunk: 5,
        time_since_start_ms: 10,
      }),
    );
    expect(spans[0]!.events).toEqual([]);
  });

  it("adds gen_ai.agent.step.* + tool.* events on agent lifecycle emissions", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "runAgent",
        provider_chain: ["openai"],
      }),
    );
    otel.emit(
      ev(capture, "agent.step.started", { operation_id: "op1" }, {
        step_index: 1,
        step_type: "llm",
      }),
    );
    otel.emit(
      ev(capture, "agent.step.completed", { operation_id: "op1" }, {
        step_index: 1,
        duration_ms: 42,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    );
    otel.emit(
      ev(capture, "agent.tool.called", { operation_id: "op1" }, {
        tool_name: "search",
        tool_call_id: "call_1",
        arguments_digest: "abcd",
      }),
    );
    otel.emit(
      ev(capture, "agent.tool.returned", { operation_id: "op1" }, {
        tool_name: "search",
        tool_call_id: "call_1",
        result_digest: "efgh",
        duration_ms: 10,
      }),
    );

    const evtnames = spans[0]!.events.map((e) => e.name);
    expect(evtnames).toEqual([
      "gen_ai.agent.step.started",
      "gen_ai.agent.step.completed",
      "gen_ai.agent.tool.called",
      "gen_ai.agent.tool.returned",
    ]);
  });

  it("suppresses agent events when emitAgentEvents is false", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer, emitAgentEvents: false });
    otel.emit(
      ev(capture, "llm.operation.started", { operation_id: "op1" }, {
        task_type: "t",
        method: "runAgent",
        provider_chain: ["openai"],
      }),
    );
    otel.emit(
      ev(capture, "agent.step.started", { operation_id: "op1" }, {
        step_index: 1,
        step_type: "llm",
      }),
    );
    expect(spans[0]!.events).toEqual([]);
  });

  it("silently drops events for operation IDs that never opened a span (unknown outer scope)", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });
    // No llm.operation.started for op_ghost.
    otel.emit(
      ev(capture, "llm.stream.chunk", { operation_id: "op_ghost" }, {
        chunk_index: 0,
        chars_in_chunk: 1,
        time_since_start_ms: 0,
      }),
    );
    otel.emit(
      ev(capture, "agent.step.started", { operation_id: "op_ghost" }, {
        step_index: 1,
        step_type: "llm",
      }),
    );
    expect(spans).toHaveLength(0);
    // No throw.
  });
});

describe("createOtelSink — dollar cost on the span", () => {
  // Alpha.35 item 12. The mapping carried tokens but not money, which is
  // plausibly the reason a team turns this bridge on at all.
  //
  // Every test here is really about one rule: a span may say what a call cost
  // only when somebody knew. An absent price means unknown, and a zero written
  // into a tracing backend is read as "this call was free", which is a
  // confident answer to a question nobody had the data for.

  function started(sink: ObservabilitySink): AnyObservabilityEvent {
    return ev(sink, "llm.operation.started", { operation_id: "op1" }, {
      task_type: "triage",
      method: "generateText",
      provider_chain: ["openai"],
    });
  }

  it("writes input, output and total cost when the price is known", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });

    otel.emit(started(capture));
    otel.emit(
      ev(capture, "llm.attempt.completed", { operation_id: "op1", attempt_id: "att1" }, {
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        latency_ms: 500,
        final_model_id: "gpt-4o",
      }),
    );

    const s = spans[0]!;
    expect(s.attributes["gen_ai.usage.cost.input_usd"]).toBe(0.001);
    expect(s.attributes["gen_ai.usage.cost.output_usd"]).toBe(0.002);
    expect(s.attributes["gen_ai.usage.cost.total_usd"]).toBe(0.003);
  });

  it("omits cost entirely for a model with no pricing, rather than writing zero", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });

    otel.emit(started(capture));
    // A self-hosted or unpriced model: real tokens, no price. Since alpha.34
    // the cost field is absent in exactly this case instead of zero-filled.
    otel.emit(
      ev(capture, "llm.attempt.completed", { operation_id: "op1", attempt_id: "att1" }, {
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        latency_ms: 500,
        final_model_id: "llama-3.3-70b",
      }),
    );

    const s = spans[0]!;
    // Absent, not zero. A spend dashboard summing this attribute must not be
    // able to report a confident $0.00 for a call nobody priced.
    expect(s.attributes).not.toHaveProperty("gen_ai.usage.cost.input_usd");
    expect(s.attributes).not.toHaveProperty("gen_ai.usage.cost.output_usd");
    expect(s.attributes).not.toHaveProperty("gen_ai.usage.cost.total_usd");
    // The tokens are still there: unknown price does not mean unknown usage.
    expect(s.attributes["gen_ai.usage.total_tokens"]).toBe(120);
  });

  it("records the cache-read saving when the adapter reported one", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });

    otel.emit(started(capture));
    otel.emit(
      ev(capture, "llm.attempt.completed", { operation_id: "op1", attempt_id: "att1" }, {
        usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 },
        cost: { inputUSD: 0.0002, outputUSD: 0.002, totalUSD: 0.0022, savingsUSD: 0.0008 },
        latency_ms: 500,
        final_model_id: "gpt-4o",
      }),
    );

    // What the prompt cache was worth in money, which is the number that
    // justifies keeping a cache-friendly prompt shape.
    expect(spans[0]!.attributes["gen_ai.usage.cost.savings_usd"]).toBe(0.0008);
  });

  it("omits the saving when there was none to report", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });

    otel.emit(started(capture));
    otel.emit(
      ev(capture, "llm.attempt.completed", { operation_id: "op1", attempt_id: "att1" }, {
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        cost: { inputUSD: 0.001, outputUSD: 0.002, totalUSD: 0.003 },
        latency_ms: 500,
        final_model_id: "gpt-4o",
      }),
    );

    expect(spans[0]!.attributes).not.toHaveProperty("gen_ai.usage.cost.savings_usd");
  });

  it("puts the whole operation's spend on the span before closing it", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });

    otel.emit(started(capture));
    otel.emit(
      ev(capture, "llm.operation.completed", { operation_id: "op1" }, {
        aggregate_usage: { inputTokens: 300, outputTokens: 60, totalTokens: 360 },
        aggregate_cost: { inputUSD: 0.003, outputUSD: 0.006, totalUSD: 0.009 },
        attempts_made: 3,
        final_provider_alias: "openai",
        total_duration_ms: 1500,
      }),
    );

    const s = spans[0]!;
    // Three attempts were paid for, and the operation span is where the total
    // belongs: a query summing attempt spans would double count a retried call
    // against the operation, and summing operations is the usual question.
    expect(s.attributes["gen_ai.usage.cost.total_usd"]).toBe(0.009);
    expect(s.ended).toBe(true);
  });

  it("writes no aggregate when the operation was never priced", () => {
    const { tracer, spans } = makeFakeTracer();
    const capture = createCollectingSink();
    const otel = createOtelSink({ tracer });

    otel.emit(started(capture));
    // The shape an unpriced operation actually produces. The contract requires
    // `aggregate_cost`, and the instrumentation starts it at zero and only adds
    // costs it knew, so zeros here mean "nothing was ever known" rather than
    // "this was free". Guarding on that is why the attribute is absent.
    otel.emit(
      ev(capture, "llm.operation.completed", { operation_id: "op1" }, {
        aggregate_usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        aggregate_cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
        attempts_made: 1,
        final_provider_alias: "ollama",
        total_duration_ms: 500,
      }),
    );

    const s = spans[0]!;
    expect(s.attributes).not.toHaveProperty("gen_ai.usage.cost.total_usd");
    // The span still closes normally: an unknown price is not a failure.
    expect(s.status?.code).toBe(SPAN_STATUS_OK);
    expect(s.ended).toBe(true);
  });
});
