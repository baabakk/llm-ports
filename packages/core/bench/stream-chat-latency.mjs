// streamChat time-to-first-token overhead benchmark.
//
// The realtime claim in plans/alpha.32 is that a voice agent can route
// through the Registry and gain fallback chains, cost ceilings, and task
// routing. Published voice telemetry runs around 680ms median end to end,
// including speech recognition and synthesis, so the LLM segment has very
// little room. An unmeasured claim about fitting inside that budget is a
// slogan, so this is the measurement.
//
// WHAT IS MEASURED, and what deliberately is not: the provider is a stub
// that yields immediately. That removes network and model time entirely,
// which is the point. What remains is exactly what routing through the
// Registry ADDS: chain resolution, budget gating, instrumentation, the
// scoped-port wrapper, and stream priming. Absolute time-to-first-token
// in production is dominated by the provider and is not something this
// library controls; the overhead is.
//
// Figures are MICROSECONDS, p50 / p95 / p99. Iteration counts
// auto-calibrate so a slow machine and a fast one finish in similar wall
// time. Method borrowed from the versioned-store portable benchmark.
//
// Usage:
//   node stream-chat-latency.mjs
//   node stream-chat-latency.mjs --quick
//   node stream-chat-latency.mjs --label "Hetzner CCX13"

import os from "node:os";
import { hrtime } from "node:process";
import { writeFileSync } from "node:fs";
import { createRegistryFromEnv, ProviderUnavailableError } from "../dist/index.mjs";

const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const labelIdx = args.indexOf("--label");
const LABEL = labelIdx >= 0 ? args[labelIdx + 1] : `${os.type()} ${os.arch()}`;

const PRICING = { inputPer1M: 1, outputPer1M: 2 };

/** A provider that yields its first event immediately. */
function stubPort(text = "hello") {
  return {
    async generateText() { throw new Error("unused"); },
    async generateStructured() { throw new Error("unused"); },
    async runAgent() { throw new Error("unused"); },
    streamText: async function* () { yield text; },
    streamStructured: async function* () { yield {}; },
    streamChat: async function* () {
      yield { type: "text-delta", text };
      yield { type: "step-finish", stopReason: "stop" };
    },
  };
}

/** A provider that refuses to open, forcing a chain walk. */
function deadPort() {
  return {
    ...stubPort(),
    streamChat: async function* () {
      // A real instance, not a name-spoofed Error: the fallback
      // classifier matches on the error class, so a look-alike would
      // abort the chain instead of walking it and quietly measure the
      // wrong thing.
      throw new ProviderUnavailableError("dead", new Error("provider down"));
    },
  };
}

function adapter(name, port) {
  return { name, pricing: { "model-x": PRICING }, createLLMPort: () => port };
}

function buildRegistry({ dead = 0, healthy = 1 } = {}) {
  const adapters = {};
  const providerEnv = {};
  const aliases = [];
  for (let i = 0; i < dead; i++) {
    const alias = `d${i}`;
    adapters[`dead${i}`] = adapter(`dead${i}`, deadPort());
    providerEnv[`LLM_PROVIDER_${alias.toUpperCase()}`] = `dead${i}|model-x|req:1000000/hour`;
    aliases.push(alias);
  }
  for (let i = 0; i < healthy; i++) {
    const alias = `h${i}`;
    adapters[`live${i}`] = adapter(`live${i}`, stubPort());
    providerEnv[`LLM_PROVIDER_${alias.toUpperCase()}`] = `live${i}|model-x|req:1000000/hour`;
    aliases.push(alias);
  }
  return createRegistryFromEnv({
    env: { ...providerEnv, LLM_TASK_ROUTE_CHAT: aliases.join(",") },
    adapters,
    runtimeFallback: "aggressive",
  });
}

const CALL = { taskType: "chat", messages: [{ role: "user", content: "hi" }] };

/** Pull only the first event, then stop. That IS time-to-first-token. */
async function firstEvent(stream) {
  const it = stream[Symbol.asyncIterator]();
  await it.next();
  if (typeof it.return === "function") await it.return();
}

async function timeOne(fn) {
  const t0 = hrtime.bigint();
  await fn();
  return Number(hrtime.bigint() - t0) / 1000; // microseconds
}

function pct(samples, p) {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/**
 * Auto-calibrate: sample briefly, then choose an iteration count that
 * lands near a target wall time. A fast machine and a slow one then
 * produce comparable confidence rather than comparable runtime.
 */
async function calibrate(fn) {
  const probe = [];
  for (let i = 0; i < 20; i++) probe.push(await timeOne(fn));
  const median = pct(probe, 50) || 1;
  const targetMs = QUICK ? 150 : 1200;
  return Math.max(50, Math.min(20000, Math.round((targetMs * 1000) / median)));
}

async function measure(name, fn) {
  // Warm up: first calls pay JIT and lazy-init costs that no production
  // process pays per request.
  for (let i = 0; i < 50; i++) await fn();
  const iterations = await calibrate(fn);
  const samples = [];
  for (let i = 0; i < iterations; i++) samples.push(await timeOne(fn));
  return {
    name,
    iterations,
    p50: +pct(samples, 50).toFixed(2),
    p95: +pct(samples, 95).toFixed(2),
    p99: +pct(samples, 99).toFixed(2),
  };
}

const direct = stubPort();
const oneProvider = buildRegistry({ dead: 0, healthy: 1 }).getPort();
const walkOne = buildRegistry({ dead: 1, healthy: 1 }).getPort();
const walkTwo = buildRegistry({ dead: 2, healthy: 1 }).getPort();

const rows = [];
rows.push(await measure("direct adapter (no Registry)", () => firstEvent(direct.streamChat(CALL))));
rows.push(await measure("through Registry, first provider healthy", () => firstEvent(oneProvider.streamChat(CALL))));
rows.push(await measure("through Registry, 1 dead provider then healthy", () => firstEvent(walkOne.streamChat(CALL))));
rows.push(await measure("through Registry, 2 dead providers then healthy", () => firstEvent(walkTwo.streamChat(CALL))));

const baseline = rows[0].p50;
const overhead = +(rows[1].p50 - baseline).toFixed(2);

console.log(`\nstreamChat time-to-first-token — ${LABEL}`);
console.log(`node ${process.version}, ${os.cpus()[0]?.model?.trim() ?? "unknown CPU"}, ${os.cpus().length} cores\n`);
console.log("microseconds".padEnd(48), "p50".padStart(9), "p95".padStart(9), "p99".padStart(9), "n".padStart(8));
for (const r of rows) {
  console.log(
    r.name.padEnd(48),
    String(r.p50).padStart(9),
    String(r.p95).padStart(9),
    String(r.p99).padStart(9),
    String(r.iterations).padStart(8),
  );
}
console.log(`\nRegistry overhead at p50: ${overhead} µs (${(overhead / 1000).toFixed(3)} ms)`);
console.log(`Each dead provider adds roughly ${((rows[2].p50 - rows[1].p50)).toFixed(2)} µs at p50.\n`);

writeFileSync(
  new URL("./stream-chat-results.json", import.meta.url),
  JSON.stringify(
    {
      label: LABEL,
      node: process.version,
      cpu: os.cpus()[0]?.model?.trim(),
      cores: os.cpus().length,
      unit: "microseconds",
      rows,
      registryOverheadP50: overhead,
    },
    null,
    2,
  ) + "\n",
);
