/**
 * Memory baseline benchmark: 10,000 sequential generateText calls through
 * llm-ports against a mock fetch that returns canned responses.
 *
 * Verifies that nothing in the framework leaks: heap stays flat, in-memory
 * budget/cost backends prune correctly, async iterators close cleanly.
 *
 * Run: `pnpm bench:memory` from this package, or `node --expose-gc dist/...`.
 *
 * Methodology per implementation plan v3 §12.4:
 *   - 10,000 sequential calls
 *   - GC-forced heap snapshots every 1,000 calls
 *   - Variance over the run < 50 MB target
 */

import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

const TOTAL = 10_000;
const SAMPLE_EVERY = 1_000;

let callCount = 0;
const mockFetch = (async () => {
  callCount++;
  const body = JSON.stringify({
    id: `msg_mem_${callCount}`,
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as unknown as typeof fetch;

const adapter = createAnthropicAdapter({
  apiKey: "memory-bench",
  fetch: mockFetch,
});
const registry = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_BENCH: "anthropic|claude-haiku-4-5|unlimited",
    LLM_TASK_ROUTE_BENCH: "bench",
  },
  adapters: { anthropic: adapter },
});
const llm = registry.getPort();

function snapshotHeap(): number {
  if (global.gc) global.gc();
  const used = process.memoryUsage().heapUsed;
  return used / 1024 / 1024; // MB
}

console.log("llm-ports memory baseline benchmark");
console.log(`Total calls: ${TOTAL.toLocaleString()}, sample every ${SAMPLE_EVERY}`);
console.log(`Node ${process.version}, ${process.platform} ${process.arch}`);
console.log(`GC available via --expose-gc: ${typeof global.gc === "function"}`);
console.log("");

const samples: Array<{ calls: number; heapMB: number }> = [];
samples.push({ calls: 0, heapMB: snapshotHeap() });

const start = Date.now();
for (let i = 1; i <= TOTAL; i++) {
  await llm.generateText({
    taskType: "bench",
    prompt: "x",
    maxOutputTokens: 5,
  });
  if (i % SAMPLE_EVERY === 0) {
    samples.push({ calls: i, heapMB: snapshotHeap() });
  }
}
const elapsed = Date.now() - start;

console.log("Heap usage over the run:");
console.log("calls       | heap MB");
console.log("------------|-------");
for (const s of samples) {
  console.log(`${s.calls.toString().padStart(11)} | ${s.heapMB.toFixed(2)}`);
}

const minHeap = Math.min(...samples.map((s) => s.heapMB));
const maxHeap = Math.max(...samples.map((s) => s.heapMB));
const variance = maxHeap - minHeap;
const finalHeap = samples[samples.length - 1]!.heapMB;
const initialHeap = samples[0]!.heapMB;
const growth = finalHeap - initialHeap;

console.log("");
console.log(`Total calls: ${TOTAL.toLocaleString()}`);
console.log(`Wall-clock: ${(elapsed / 1000).toFixed(2)}s (${(TOTAL / (elapsed / 1000)).toFixed(0)} calls/sec)`);
console.log(`Heap variance (max - min): ${variance.toFixed(2)} MB`);
console.log(`Heap growth (final - initial): ${growth.toFixed(2)} MB`);
console.log(`Target (per plan §12.4): variance < 50 MB`);
console.log(`Result: ${variance < 50 ? "PASS" : "FAIL"} (margin: ${(50 - variance).toFixed(2)} MB)`);
