/**
 * Alpha.30 §2.7 — contract additions for streaming.
 *
 * Verifies:
 *   - StreamStats type has all required fields plus optional
 *     percentiles.
 *   - StreamChunkData has chunk_index / chars_in_chunk /
 *     time_since_start_ms / optional chunk_content.
 *   - Zod schemas accept well-formed values and reject malformed ones.
 *   - llm.stream.chunk is present in LIFECYCLE_EVENT_TYPES and the
 *     schema map (round-trip integrity with the existing sanity check
 *     at import time).
 *   - AttemptCompletedData.stream_stats round-trips through its Zod
 *     schema.
 */

import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_EVENT_TYPES,
  type StreamChunkData,
  type StreamStats,
} from "../src/index.js";
import {
  attemptCompletedDataSchema,
  lifecycleEventSchemas,
  streamChunkDataSchema,
  streamStatsSchema,
} from "../src/schemas.js";

describe("StreamStats type + schema", () => {
  it("accepts a well-formed StreamStats with all optionals set", () => {
    const s: StreamStats = {
      ttft_ms: 120,
      total_stream_duration_ms: 2500,
      chunk_count: 42,
      inter_chunk_latency_p50_ms: 30,
      inter_chunk_latency_p99_ms: 200,
      termination: "complete",
    };
    expect(streamStatsSchema.parse(s)).toEqual(s);
  });

  it("accepts a minimal StreamStats without percentiles", () => {
    const s: StreamStats = {
      ttft_ms: 5,
      total_stream_duration_ms: 5,
      chunk_count: 1,
      termination: "complete",
    };
    expect(streamStatsSchema.parse(s)).toEqual(s);
  });

  it("accepts all three termination values", () => {
    for (const t of ["complete", "aborted", "error"] as const) {
      const s: StreamStats = {
        ttft_ms: 1,
        total_stream_duration_ms: 1,
        chunk_count: 1,
        termination: t,
      };
      expect(streamStatsSchema.parse(s).termination).toBe(t);
    }
  });

  it("rejects negative ttft_ms", () => {
    expect(() =>
      streamStatsSchema.parse({
        ttft_ms: -1,
        total_stream_duration_ms: 1,
        chunk_count: 1,
        termination: "complete",
      }),
    ).toThrow();
  });

  it("rejects fractional chunk_count", () => {
    expect(() =>
      streamStatsSchema.parse({
        ttft_ms: 1,
        total_stream_duration_ms: 1,
        chunk_count: 1.5,
        termination: "complete",
      }),
    ).toThrow();
  });

  it("rejects an unknown termination value", () => {
    expect(() =>
      streamStatsSchema.parse({
        ttft_ms: 1,
        total_stream_duration_ms: 1,
        chunk_count: 1,
        termination: "made-up",
      }),
    ).toThrow();
  });
});

describe("StreamChunkData type + schema", () => {
  it("accepts a well-formed StreamChunkData without content (aggregate mode)", () => {
    const c: StreamChunkData = {
      chunk_index: 0,
      chars_in_chunk: 42,
      time_since_start_ms: 50,
    };
    expect(streamChunkDataSchema.parse(c)).toEqual(c);
  });

  it("accepts a well-formed StreamChunkData WITH content (full mode)", () => {
    const c: StreamChunkData = {
      chunk_index: 7,
      chars_in_chunk: 42,
      time_since_start_ms: 500,
      chunk_content: "hello world from chunk 7",
    };
    expect(streamChunkDataSchema.parse(c)).toEqual(c);
  });

  it("rejects fractional chunk_index", () => {
    expect(() =>
      streamChunkDataSchema.parse({
        chunk_index: 1.5,
        chars_in_chunk: 1,
        time_since_start_ms: 1,
      }),
    ).toThrow();
  });

  it("rejects negative chars_in_chunk", () => {
    expect(() =>
      streamChunkDataSchema.parse({
        chunk_index: 0,
        chars_in_chunk: -1,
        time_since_start_ms: 1,
      }),
    ).toThrow();
  });
});

describe("llm.stream.chunk integration into lifecycle-event catalog", () => {
  it("is present in LIFECYCLE_EVENT_TYPES", () => {
    expect(LIFECYCLE_EVENT_TYPES).toContain("llm.stream.chunk");
  });

  it("has an entry in lifecycleEventSchemas", () => {
    expect("llm.stream.chunk" in lifecycleEventSchemas).toBe(true);
  });

  it("the schema round-trips a well-formed envelope", () => {
    const envelope = {
      spec_version: "0.1.0-alpha.30",
      event_id: "evt_test123456",
      event_type: "llm.stream.chunk",
      occurred_at: "2026-08-15T00:00:00.000Z",
      emitted_at: "2026-08-15T00:00:00.001Z",
      source: { library: "test", library_version: "0.0.0" },
      operation_id: "op_abcdef123456",
      attempt_id: "att_zyx987654321",
      data: {
        chunk_index: 3,
        chars_in_chunk: 12,
        time_since_start_ms: 250,
      },
    };
    expect(lifecycleEventSchemas["llm.stream.chunk"].parse(envelope)).toEqual(envelope);
  });
});

describe("AttemptCompletedData.stream_stats", () => {
  it("round-trips a completed attempt with stream_stats", () => {
    const data = {
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
      latency_ms: 3000,
      final_model_id: "gpt-4o",
      stream_stats: {
        ttft_ms: 200,
        total_stream_duration_ms: 2800,
        chunk_count: 50,
        inter_chunk_latency_p50_ms: 40,
        inter_chunk_latency_p99_ms: 300,
        termination: "complete" as const,
      },
    };
    expect(attemptCompletedDataSchema.parse(data)).toEqual(data);
  });

  it("stream_stats is optional (non-streaming attempts don't carry it)", () => {
    const data = {
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
      latency_ms: 100,
      final_model_id: "gpt-4o",
    };
    const parsed = attemptCompletedDataSchema.parse(data);
    expect(parsed.stream_stats).toBeUndefined();
  });
});
