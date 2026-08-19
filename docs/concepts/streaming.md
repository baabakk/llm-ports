# Streaming Observability

`streamText` and `streamStructured` on the Registry emit the same operation + attempt lifecycle as non-streaming methods, plus `AttemptCompletedData.stream_stats` — the load-bearing new metric surface for TTFT (time-to-first-token) and inter-chunk latency percentiles.

Introduced in [`0.1.0-alpha.30`](/migration/alpha-29-to-alpha-30). Before alpha.30 streaming calls emitted nothing to the observability sink; the Registry has been fully instrumented since.

## Event sequence for a streamed call

Consumer calls `registry.getPort().streamText({ ... })`. The Registry emits, in order:

1. `llm.operation.started` — before the first chunk. Carries `task_type`, `method: "streamText"`, `provider_chain`.
2. `llm.attempt.started` — when the winning provider opens its raw stream.
3. **Zero or more `llm.stream.chunk` events** — one per chunk yielded, but ONLY when `CapturePolicy.stream_chunk_capture === "full"`. Off by default.
4. `llm.attempt.completed` — on natural stream close. Carries `stream_stats` (below).
5. `llm.operation.completed` — mirrors the non-streaming lifecycle.

On mid-stream failure: `llm.attempt.failed` + `llm.operation.failed` replace 4 + 5. On consumer abort (an `AbortError` thrown into the stream): `llm.attempt.failed` + `llm.operation.cancelled`.

Chain-walk semantics match non-streaming methods. If sel 1's stream fails at open time (adapter throws before returning the iterable), the Registry emits `llm.attempt.failed` for sel 1, `llm.fallback.selected` sel1→sel2, `llm.attempt.started` for sel 2, then proceeds. Once a stream opens successfully, mid-stream errors propagate to the consumer without walking (the alpha.7 "walk at creation, propagate mid-stream" contract).

## The `stream_stats` field

Attached to `AttemptCompletedData.stream_stats` on natural completion. Not attached on `llm.attempt.failed` — partial telemetry is dropped rather than emitted in the wrong envelope shape.

```ts
interface StreamStats {
  /** Wall-clock ms from stream open to the first chunk (TTFT). */
  ttft_ms: number;

  /** Wall-clock ms from stream open to the last chunk. */
  total_stream_duration_ms: number;

  /** Count of chunks the outer wrapper yielded to the consumer. */
  chunk_count: number;

  /** p50 of inter-chunk gap ms. Omitted when chunk_count < 2. */
  inter_chunk_latency_p50_ms?: number;

  /** p99 of inter-chunk gap ms. Omitted when chunk_count < 2. */
  inter_chunk_latency_p99_ms?: number;

  /** How the stream ended. */
  termination: "complete" | "aborted" | "error";
}
```

TTFT is measured from the moment the outer wrapper first pulls a chunk — the raw iterable is not asked for anything before the consumer starts iterating, so this correctly captures adapter setup + first-token latency. Percentiles are computed via nearest-rank on a sample of positive integers; single-chunk streams have no gaps to sample and both percentiles omit.

## Diagnostic fields on streamed attempts

`response_char_count` and `response_preview` land on every streamed `llm.attempt.completed` too:

- `response_char_count` — sums character lengths across all chunks. Always emitted verbatim (never gated by capture policy — it's a count, not content).
- `response_preview` — the first `CapturePolicy.responsePreviewMaxChars` characters of the streamed text, buffered inside the outer wrapper. Gated by BOTH `CapturePolicy.content === "full" | "redacted"` AND `responsePreviewMaxChars > 0`. Default policy has both off in strict mode.

For `streamStructured`, char accounting uses `JSON.stringify(chunk)` per chunk (partial JSON has no natural text form otherwise). Circular / un-serializable partials count as zero for that chunk.

## Per-chunk telemetry (opt-in, volume-sensitive)

Set `CapturePolicy.stream_chunk_capture = "full"` to emit an `llm.stream.chunk` event per chunk. Default is `"off"` — aggregate `stream_stats` only.

```ts
interface StreamChunkData {
  /** 0-indexed position in the stream. */
  chunk_index: number;

  /** Character length of this chunk. */
  chars_in_chunk: number;

  /** Wall-clock ms from stream open to this chunk. */
  time_since_start_ms: number;

  /**
   * Chunk text. Emitted only when the content policy allows it
   * (content === "full" | "redacted"). Absent when the aggregate
   * count is on but the content policy is strict.
   */
  chunk_content?: string;
}
```

A 5000-chunk stream fires 5000 events at `stream_chunk_capture: "full"`. Reserve this for low-volume diagnostic runs; production consumers typically stay on `"off"` and rely on the aggregate `stream_stats` field.

## Wiring it

```ts
import { createRegistryFromEnv } from "@llm-ports/core";
import {
  createCollectingSink,
  PERMISSIVE_CAPTURE_POLICY,
} from "@llm-ports/observability-contract";

const sink = createCollectingSink();

const registry = createRegistryFromEnv({
  env: process.env as Record<string, string>,
  adapters: { /* ... */ },
  instrumentation: {
    config: { sink, source: { library: "my-app", library_version: "1.0.0" } },
    // Strict default: response_char_count emits, response_preview does not,
    // per-chunk events do not.
    //
    // To emit response_preview + per-chunk events in dev:
    // capturePolicy: {
    //   ...PERMISSIVE_CAPTURE_POLICY,
    //   stream_chunk_capture: "full",
    //   responsePreviewMaxChars: 200,
    // },
  },
});

// Drain a stream — every chunk yields to your consumer as normal.
for await (const chunk of registry
  .getPort()
  .streamText({ taskType: "briefing", messages: [{ role: "user", content: "..." }] })) {
  process.stdout.write(chunk);
}

// After the loop exits, sink.events contains:
//   [ operation.started, attempt.started, attempt.completed, operation.completed ]
// The attempt.completed's data.stream_stats has ttft_ms, chunk_count, etc.
```

## OpenTelemetry mapping

When you wire the [`@llm-ports/telemetry-otel`](/adapters/telemetry-otel) sink, streaming events map to:

- `llm.operation.started` → `startSpan("gen_ai.streamText" | "gen_ai.streamStructured")`.
- `llm.attempt.completed` → span attributes (`gen_ai.usage.*`) + histogram samples (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, `gen_ai.client.cache.read_tokens` when applicable). `stream_stats` fields land as span attributes too (`gen_ai.stream.ttft_ms`, etc. — mapping continues to firm up as the OTel gen_ai stream semconv stabilizes).
- `llm.stream.chunk` → `Span.addEvent("gen_ai.stream.chunk", chunkData)`. Toggle via `emitStreamChunkEvents` (default true; set false to bound span size for high-chunk-count streams).
- `llm.attempt.failed` → `recordException` on the open span.
- `llm.operation.cancelled` → `setStatus(ERROR, "cancelled")` + `end()`.

## Cost + budget still land at stream completion

The alpha.25 stream-complete callback path (`buildStreamCompleteCallback`) continues to fire the alpha.21 fire-and-forget hooks (`onCost`, `onTokenUsage`, `onCacheHit`) and record streamed cost against the budget backend. Alpha.30's `stream_stats` layer is additive on top of that surface; both fire on natural stream close.

The Registry's outer wrapper waits one microtask after the raw iterator exits before reading the callback's meta — Vercel-AI-shaped adapters fire onFinish from their own iterator's finally block, and that ordering lands before our `completeAttempt` emit.

## Field reference summary

| Field | Type | Where | Notes |
|---|---|---|---|
| `stream_stats.ttft_ms` | `number` | `AttemptCompletedData` | Always present on streamed attempts. |
| `stream_stats.total_stream_duration_ms` | `number` | `AttemptCompletedData` | Always present. |
| `stream_stats.chunk_count` | `number` | `AttemptCompletedData` | Always present. |
| `stream_stats.inter_chunk_latency_p50_ms` | `number?` | `AttemptCompletedData` | Omitted when chunk_count < 2. |
| `stream_stats.inter_chunk_latency_p99_ms` | `number?` | `AttemptCompletedData` | Omitted when chunk_count < 2. |
| `stream_stats.termination` | `"complete" \| "aborted" \| "error"` | `AttemptCompletedData` | Only `"complete"` is emitted on `attempt.completed`; `"aborted"` / `"error"` classifications live on the `attempt.failed` path via `ErrorInfo`. |
| `response_char_count` | `number` | `AttemptCompletedData` | Always emitted verbatim. |
| `response_preview` | `string?` | `AttemptCompletedData` | Gated by content policy + `responsePreviewMaxChars > 0`. |
| `chunk_index` | `number` | `llm.stream.chunk` | 0-indexed. |
| `chars_in_chunk` | `number` | `llm.stream.chunk` | Characters, not tokens. |
| `time_since_start_ms` | `number` | `llm.stream.chunk` | From stream open, not the previous chunk. |
| `chunk_content` | `string?` | `llm.stream.chunk` | Gated by content policy. |

## Related

- [Observability concepts](/concepts/observability) — the full lifecycle event catalog.
- [Cache Control](/concepts/cache) — `cache_stats.provider_cache` also lands on streamed attempts via the same shared helper.
- [`@llm-ports/telemetry-otel` guide](/adapters/telemetry-otel) — OTel semconv mapping for stream events.
- [alpha.29 → alpha.30 migration](/migration/alpha-29-to-alpha-30) — what changed for existing consumers.
