# streamChat: time-to-first-token overhead

`plans/alpha.32` made a claim: a realtime voice agent can route through the Registry and gain fallback chains, cost ceilings, and task routing without breaking its latency budget. It also gated the realtime design on measuring that, because an unmeasured latency claim is a slogan.

This is the measurement. **The gate passes**, and the numbers move one design decision.

## What is measured, and what deliberately is not

The provider is a stub that yields its first event immediately. That removes network time and model time entirely, which is the point: absolute time-to-first-token in production is dominated by the provider and is not something this library controls. What remains is exactly what routing through the Registry **adds**: chain resolution, budget gating, instrumentation, the scoped-port wrapper, and stream priming.

Figures are microseconds, p50 / p95 / p99, with auto-calibrated iteration counts. Method follows the versioned-store portable benchmark: report percentiles rather than means, and be explicit about machine conditions.

## Results

Windows dev box, 12th Gen Intel Core i7-1270P, 16 cores, Node v24.11.1, **under active load** (a full workspace build and test run in parallel). A contended machine is the honest place to measure, since the interesting number is the bad case rather than the best one.

| | p50 | p95 | p99 | n |
|---|---:|---:|---:|---:|
| direct adapter, no Registry | 0.60 | 1.20 | 3.00 | 20000 |
| through Registry, first provider healthy | 37.00 | 206.70 | 349.40 | 20000 |
| through Registry, one dead provider then healthy | 362.90 | 887.00 | 1240.90 | 20000 |
| through Registry, two dead providers then healthy | 460.80 | 1345.00 | 2677.20 | 13730 |

**Registry overhead at p50: 36.4 µs, which is 0.036 ms.**
**Each additional dead provider in the chain costs roughly 326 µs, or 0.33 ms.**

## Reading the numbers against the budget

Published production telemetry for voice agents runs around 680 ms median end to end, including speech recognition and synthesis. Against that:

- Routing through the Registry costs **0.036 ms**, about **0.005 percent** of the budget.
- A two-hop chain walk costs **0.46 ms**, about **0.07 percent** of the budget.

Even the p99 of a two-hop walk, 2.7 ms on a loaded machine, is under half a percent. There is no version of this where the library's own bookkeeping is what breaks a conversation.

## The finding that changes a design decision

The plan proposed `totalDeadlineMs` as the correct realtime primitive, reasoning that two individually-reasonable per-attempt timeouts can blow a conversational budget. The measurement shows **that risk does not come from this library**.

A dead provider does not cost 326 µs in production. It costs whatever its failure takes: a refused connection is fast, but a hung provider costs the full per-attempt timeout, and the library's default is tuned for batch work. Two attempts at a batch-shaped timeout will indeed blow a voice budget, and it will be the timeout doing it, not the chain walk.

So the real realtime control is **`perAttemptTimeoutMs`**, which already exists, and which a consumer must set to something a conversation can absorb. `@llm-ports/integration-livekit` documents that on its options and explains why.

That makes `totalDeadlineMs` a genuine convenience rather than a necessity: with a correctly-set per-attempt timeout and a chain of known length, the worst case is already bounded and computable. It stays on the roadmap, but it is no longer gating anything, and it should not be built before a consumer reports wanting it.

## What this does not prove

- No real provider was contacted. This isolates the library's overhead deliberately, and says nothing about how any given provider behaves under load.
- One machine, one architecture. The versioned-store benchmark ran across cloud instances and a handset precisely because a single machine is not a claim about portability. This one has not.
- Time-to-first-token only. Sustained throughput across a long stream, and the cost of the per-chunk instrumentation path under `stream_chunk_capture: "full"`, are not measured here.

## Reproducing

```bash
pnpm --filter @llm-ports/core build
node packages/core/bench/stream-chat-latency.mjs --label "your machine"
```

Writes `stream-chat-results.json` beside the script for merging runs across machines.
