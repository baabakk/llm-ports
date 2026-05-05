/**
 * Shared utilities for live API integration tests.
 *
 * Each adapter test file gates itself on the relevant API key. Tests skip
 * cleanly when keys are absent so this whole suite is safe to commit and
 * safe to run in CI without secrets (it just skips).
 *
 * To run actually-live: set RUN_LIVE_TESTS=1 plus the relevant provider's
 * API key, then `pnpm test:live` (or per-provider variant).
 */

import { expect } from "vitest";
import type {
  AgentResult,
  GenerateStructuredResult,
  GenerateTextResult,
} from "@llm-ports/core";

export const LIVE = process.env.RUN_LIVE_TESTS === "1";
export const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
export const OPENAI_KEY = process.env.OPENAI_API_KEY;
export const GROQ_KEY = process.env.GROQ_API_KEY;
export const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

// Shorthand skip predicates (truthy = SKIP this test).
export const skipAnthropic = !LIVE || !ANTHROPIC_KEY;
export const skipOpenAI = !LIVE || !OPENAI_KEY;
export const skipGroq = !LIVE || !GROQ_KEY;
export const skipCerebras = !LIVE || !CEREBRAS_KEY;
export const skipOllama = !LIVE; // ollama doesn't need a key, just a daemon

// ─── Standard assertions across adapters ─────────────────────────────

export function assertGenerateTextShape(
  result: GenerateTextResult,
  expectedAlias: string,
  opts: { allowZeroCost?: boolean } = {},
): void {
  expect(result.text).toBeTypeOf("string");
  expect(result.text.length).toBeGreaterThan(0);
  expect(result.usage.inputTokens).toBeGreaterThan(0);
  expect(result.usage.outputTokens).toBeGreaterThan(0);
  expect(result.usage.totalTokens).toBe(
    result.usage.inputTokens + result.usage.outputTokens,
  );
  if (opts.allowZeroCost) {
    expect(result.cost.totalUSD).toBeGreaterThanOrEqual(0);
  } else {
    expect(result.cost.totalUSD).toBeGreaterThan(0);
  }
  expect(result.modelId).toBeTypeOf("string");
  expect(result.providerAlias).toBe(expectedAlias);
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
}

export function assertGenerateStructuredShape<T>(
  result: GenerateStructuredResult<T>,
  expectedAlias: string,
  opts: { allowZeroCost?: boolean; minAttempts?: number; maxAttempts?: number } = {},
): void {
  expect(result.data).toBeDefined();
  expect(result.usage.totalTokens).toBeGreaterThan(0);
  if (opts.allowZeroCost) {
    expect(result.cost.totalUSD).toBeGreaterThanOrEqual(0);
  } else {
    expect(result.cost.totalUSD).toBeGreaterThan(0);
  }
  expect(result.providerAlias).toBe(expectedAlias);
  expect(result.validationAttempts).toBeGreaterThanOrEqual(opts.minAttempts ?? 1);
  if (opts.maxAttempts !== undefined) {
    expect(result.validationAttempts).toBeLessThanOrEqual(opts.maxAttempts);
  }
}

export function assertAgentShape(
  result: AgentResult,
  expectedAlias: string,
  opts: { allowZeroCost?: boolean } = {},
): void {
  expect(result.text).toBeTypeOf("string");
  expect(result.usage.totalTokens).toBeGreaterThan(0);
  if (opts.allowZeroCost) {
    expect(result.cost.totalUSD).toBeGreaterThanOrEqual(0);
  } else {
    expect(result.cost.totalUSD).toBeGreaterThan(0);
  }
  expect(result.providerAlias).toBe(expectedAlias);
  expect(result.stepsTaken).toBeGreaterThanOrEqual(1);
  expect(["completed", "max_steps", "stopped_by_user"]).toContain(
    result.terminationReason,
  );
}

// ─── Test fixtures ───────────────────────────────────────────────────

/**
 * 4×4 solid-red PNG, base64-encoded. Tiny but visible — gpt-5-mini and Claude
 * Haiku will both successfully identify "red" as the dominant color, which
 * gives vision tests something to assert on. The previous 1×1 transparent
 * PNG produced empty responses on some models because there was nothing to
 * describe.
 */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEUlEQVR42mP8/5+hngEEGNFFAA2kAvjEMW1OAAAAAElFTkSuQmCC";

/**
 * Public, stable image URL for vision tests. OpenAI's API has been observed
 * to reject some image hosts (Wikipedia's CDN, GitHub raw URLs) with
 * "invalid_image_url" errors. This GitHub-rendered SVG-as-PNG is reliable
 * and tiny (~10KB).
 *
 * If this URL ever stops working with OpenAI, the fallback is to convert
 * to base64 data URIs in the test rather than chase a stable host.
 */
export const PUBLIC_IMAGE_URL =
  "https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/.github/anthropic-logo.png";

// ─── Cost reporter ───────────────────────────────────────────────────

let totalCost = 0;
const adapterCosts: Record<string, number> = {};

export function recordCost(adapter: string, usd: number): void {
  totalCost += usd;
  adapterCosts[adapter] = (adapterCosts[adapter] ?? 0) + usd;
}

export function reportCosts(): void {
  if (totalCost === 0) return;
  // eslint-disable-next-line no-console
  console.log("\n=== Live test cost summary ===");
  for (const [adapter, cost] of Object.entries(adapterCosts)) {
    // eslint-disable-next-line no-console
    console.log(`  ${adapter.padEnd(15)} $${cost.toFixed(4)}`);
  }
  // eslint-disable-next-line no-console
  console.log(`  ${"TOTAL".padEnd(15)} $${totalCost.toFixed(4)}\n`);
}
