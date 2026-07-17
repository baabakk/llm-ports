/**
 * llm-ports — onRetry observability example.
 *
 * Demonstrates the `onRetry` hook added in `@llm-ports/core@0.1.0-alpha.1`.
 * The hook fires whenever an adapter retries an in-flight request for a
 * known transient reason:
 *
 *   - transient-auth         — project-key burst-protection 401 (OpenAI sk-proj-*)
 *   - capability-fallback    — model rejected temperature, json_object, or system message
 *   - reasoning-starvation   — model spent its output budget on hidden reasoning
 *   - validation-feedback    — structured output failed schema; retrying with correction
 *
 * This example wires the hook to two sinks:
 *   1. A human-readable console logger (debug)
 *   2. A Prometheus-shaped counter (production observability)
 *
 * It then drives one happy-path call and one structured-output call against
 * a reasoning model so you can see the validation-feedback / reasoning-
 * starvation events fire when the model output needs correction.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... pnpm --filter @llm-ports/example-with-onretry start
 *
 * The point: when something looks slow or expensive, you can see WHY in your
 * existing logs/metrics without spelunking through adapter source.
 */

import {
  createRegistryFromEnv,
  type OnRetry,
  type RetryEvent,
} from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";
import { createClassifier } from "@llm-ports/capabilities";
import { z } from "zod";

const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) {
  console.error("Set OPENAI_API_KEY before running this example.");
  process.exit(1);
}

// ─── Sink 1: human-readable console logger ─────────────────────────────

const consoleLogger: OnRetry = (event: RetryEvent) => {
  const { reason, attempt, providerAlias, modelId, delayMs } = event;
  const causePart =
    event.cause instanceof Error ? ` (${event.cause.message})` : "";
  console.log(
    `[onRetry] ${reason} attempt=${attempt} provider=${providerAlias} model=${modelId} delayMs=${delayMs}${causePart}`,
  );
};

// ─── Sink 2: Prometheus-shaped counter ─────────────────────────────────

class RetryCounter {
  private counts = new Map<string, number>();

  record(event: RetryEvent): void {
    const key = `${event.reason}|${event.providerAlias}|${event.modelId}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Render as Prometheus exposition format (what you'd return from /metrics). */
  toString(): string {
    const lines: string[] = [
      "# HELP llm_ports_retry_total Total adapter retries by reason and provider.",
      "# TYPE llm_ports_retry_total counter",
    ];
    for (const [key, n] of this.counts) {
      const [reason, providerAlias, modelId] = key.split("|");
      lines.push(
        `llm_ports_retry_total{reason="${reason}",provider="${providerAlias}",model="${modelId}"} ${n}`,
      );
    }
    return lines.join("\n");
  }
}

const counter = new RetryCounter();

// ─── Fan out to both sinks ─────────────────────────────────────────────

const onRetry: OnRetry = (event) => {
  consoleLogger(event);
  counter.record(event);
};

// ─── Adapter wiring with the hook ──────────────────────────────────────

const adapter = createOpenAIAdapter({
  apiKey,
  onRetry,
});

const registry = createRegistryFromEnv({
  env: {
    // gpt-4o for the happy-path call; gpt-5-nano if you want to see
    // reasoning-starvation events fire when maxOutputTokens is small.
    LLM_PROVIDER_PRIMARY: "openai|gpt-4o|cost:1/day",
    LLM_TASK_ROUTE_CLASSIFY: "primary",
    LLM_TASK_ROUTE_TEST: "primary",
  },
  adapters: { openai: adapter },
});

const llm = registry.getPort();

// ─── 1. Happy-path call ────────────────────────────────────────────────

console.log("\n--- happy path: no retries expected ---");
const greeting = await llm.generateText({
  taskType: "test",
  messages: [{ role: "user" as const, content: "In one sentence, greet a TypeScript developer." }],
  maxOutputTokens: 80,
});
console.log("Generated:", greeting.text);

// ─── 2. Structured output with a deliberately tricky schema ────────────

// This schema is strict enough that gpt-4o sometimes flubs it on the first
// try (especially the `reasoning` free-form field paired with the enum). When
// that happens you'll see "validation-feedback" events fire and the registry
// retry with a correction prompt.

const TriageSchema = z.object({
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  category: z.enum(["bug", "feature", "question", "other"]),
  reasoning: z
    .string()
    .min(20)
    .describe("Why this priority was chosen. At least 20 characters."),
});

const classify = createClassifier({
  port: llm,
  schema: TriageSchema,
  schemaName: "support-triage",
  rubric: `
    P0: customer-blocking outage; reply within 1 hour
    P1: significant business impact; same-day
    P2: standard professional ask; within 2 days
    P3: nice-to-have or FYI; no SLA
  `,
});

console.log("\n--- structured output: may emit validation-feedback retries ---");
const triage = await classify({
  content:
    "Our prod API has been returning 500s for the last 20 minutes. " +
    "We're losing customer transactions and our oncall pager is melting. " +
    "Need immediate help.",
});
console.log("Triage:", triage);

// ─── 3. Show the counter snapshot ──────────────────────────────────────

console.log("\n--- Prometheus exposition (what you'd serve from /metrics) ---");
console.log(counter.toString() || "(no retries fired this run)");
