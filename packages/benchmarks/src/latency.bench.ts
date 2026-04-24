/**
 * Latency overhead benchmark: BEPA-direct vs BEPA-via-llm-ports.
 *
 * Measures the framework overhead llm-ports adds on top of a direct
 * Anthropic SDK call. Both paths share an identical mock fetch that
 * returns canned responses immediately, so the difference is pure
 * framework cost: registry lookup + budget gating + cost computation
 * + adapter translation + hook dispatch.
 *
 * Methodology per implementation plan v3 §12.4:
 *   - 100 iterations per case after 10 warmup iterations
 *   - Mix: generateText, generateStructured, runAgent (no streaming)
 *   - Anthropic Sonnet shape (lowest natural latency variance)
 *   - Mock fetch eliminates network I/O so the measurement is
 *     framework-only
 *
 * Run: `pnpm bench` from this package.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

const ITERATIONS = 100;
const WARMUP = 10;

// ─── Mock fetch (zero network I/O) ───────────────────────────────────

let callCount = 0;

const mockFetch = (async () => {
  callCount++;
  const body = JSON.stringify({
    id: `msg_bench_${callCount}`,
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [
      {
        type: "text",
        text: '{"intent":"request","reasoning":"benchmark synthetic"}',
      },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as unknown as typeof fetch;

// ─── Direct path: bare Anthropic SDK ─────────────────────────────────

function makeDirect() {
  const client = new Anthropic({
    apiKey: "test-key",
    fetch: mockFetch as Anthropic["fetch"],
  });
  return {
    async generateText(): Promise<string> {
      const r = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      });
      const block = r.content[0] as { type: "text"; text: string };
      return block.text;
    },
    async generateStructured(): Promise<unknown> {
      const r = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "classify: hi" }],
      });
      const block = r.content[0] as { type: "text"; text: string };
      return JSON.parse(block.text);
    },
    async runAgent(): Promise<string> {
      const r = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "agent task" }],
      });
      const block = r.content[0] as { type: "text"; text: string };
      return block.text;
    },
  };
}

// ─── llm-ports path: through registry → adapter → SDK ────────────────

function makeLLMPorts() {
  const adapter = createAnthropicAdapter({
    apiKey: "test-key",
    fetch: mockFetch as never,
  });
  const registry = createRegistryFromEnv({
    env: {
      LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|unlimited",
      LLM_TASK_ROUTE_BENCH_TEXT: "fast",
      LLM_TASK_ROUTE_BENCH_STRUCT: "fast",
      LLM_TASK_ROUTE_BENCH_AGENT: "fast",
    },
    adapters: { anthropic: adapter },
  });
  const llm = registry.getPort();
  const ResponseSchema = z.object({ intent: z.string(), reasoning: z.string() });
  return {
    async generateText(): Promise<string> {
      const r = await llm.generateText({
        taskType: "bench-text",
        prompt: "hi",
      });
      return r.text;
    },
    async generateStructured(): Promise<unknown> {
      const r = await llm.generateStructured({
        taskType: "bench-struct",
        prompt: "classify: hi",
        schema: ResponseSchema,
        schemaName: "bench",
      });
      return r.data;
    },
    async runAgent(): Promise<string> {
      const r = await llm.runAgent({
        taskType: "bench-agent",
        instructions: "be useful",
        messages: [{ role: "user", content: "agent task" }],
        tools: {},
        maxSteps: 1,
      });
      return r.text;
    },
  };
}

// ─── Stats ───────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

interface Stats {
  p50: number;
  p99: number;
  mean: number;
}

async function bench(_label: string, fn: () => Promise<unknown>): Promise<Stats> {
  // Warmup so JIT settles
  for (let i = 0; i < WARMUP; i++) await fn();

  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    p50: percentile(times, 0.5),
    p99: percentile(times, 0.99),
    mean: sum / times.length,
  };
}

function fmt(n: number): string {
  return n.toFixed(3).padStart(9);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const direct = makeDirect();
  const lp = makeLLMPorts();

  process.stdout.write("\nllm-ports latency overhead benchmark\n");
  process.stdout.write(
    `Iterations: ${ITERATIONS} per case (after ${WARMUP} warmup)\n`,
  );
  process.stdout.write(
    `Mock fetch: returns canned response immediately (zero network I/O)\n`,
  );
  process.stdout.write(
    `Node ${process.version}, ${process.platform} ${process.arch}\n\n`,
  );

  process.stdout.write(`Results (milliseconds, lower is better):\n\n`);
  process.stdout.write(
    `operation             | direct p50 | direct p99 | llm-ports p50 | llm-ports p99 | overhead p50 | overhead p99\n`,
  );
  process.stdout.write(
    `---------------------+-----------+-----------+--------------+--------------+--------------+--------------\n`,
  );

  const ops: Array<keyof ReturnType<typeof makeDirect>> = [
    "generateText",
    "generateStructured",
    "runAgent",
  ];

  const summary: Array<{
    op: string;
    direct: Stats;
    lp: Stats;
    overheadP50: number;
    overheadP99: number;
  }> = [];

  for (const op of ops) {
    const directStats = await bench(`direct.${op}`, () => direct[op]());
    const lpStats = await bench(`llm-ports.${op}`, () => lp[op]());
    const overheadP50 = lpStats.p50 - directStats.p50;
    const overheadP99 = lpStats.p99 - directStats.p99;
    summary.push({ op, direct: directStats, lp: lpStats, overheadP50, overheadP99 });

    process.stdout.write(
      `${op.padEnd(20)} | ${fmt(directStats.p50)} | ${fmt(directStats.p99)} | ${fmt(lpStats.p50).padStart(12)} | ${fmt(lpStats.p99).padStart(12)} | ${fmt(overheadP50).padStart(12)} | ${fmt(overheadP99).padStart(12)}\n`,
    );
  }

  // Aggregate worst-case overhead across all three operations
  const maxP99Overhead = Math.max(...summary.map((s) => s.overheadP99));
  const meanP50Overhead =
    summary.reduce((a, s) => a + s.overheadP50, 0) / summary.length;

  process.stdout.write(`\nAggregate:\n`);
  process.stdout.write(`  mean p50 overhead across operations: ${meanP50Overhead.toFixed(3)} ms\n`);
  process.stdout.write(`  max  p99 overhead across operations: ${maxP99Overhead.toFixed(3)} ms\n`);
  process.stdout.write(`  target (per implementation plan v3 §12.4): p99 < 5 ms\n`);
  process.stdout.write(
    `  result: ${maxP99Overhead < 5 ? "PASS" : "FAIL"} (margin: ${(5 - maxP99Overhead).toFixed(3)} ms)\n`,
  );

  process.stdout.write(`\nMethodology:\n`);
  process.stdout.write(`  - Anthropic SDK with custom fetch returning canned responses\n`);
  process.stdout.write(`  - Direct path: Anthropic.messages.create + manual response extraction\n`);
  process.stdout.write(`  - llm-ports path: Registry → AnthropicAdapter → Anthropic.messages.create\n`);
  process.stdout.write(`    + cost computation + budget recording (in-memory) + Zod validation\n`);
  process.stdout.write(`  - Both paths share identical mock fetch (zero network)\n`);
  process.stdout.write(`  - Difference = pure llm-ports framework overhead\n\n`);
}

main().catch((err) => {
  process.stderr.write(`Benchmark failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
