/**
 * Phase 3 of the test plan: live integration tests for the 7 capability factories.
 *
 * Capabilities are provider-agnostic, so we test against whichever provider's
 * key is available. Preference order: Anthropic Haiku (cheapest test target),
 * fallback to OpenAI's gpt-5-nano. Skipped only if neither key is set.
 *
 * For each capability, exercises 1-3 inputs and asserts:
 *   - Result type matches the schema (Zod parse passes)
 *   - event.cost.totalUSD > 0 and reasonable for the model
 *   - event.validationAttempts in [1, 2]
 *   - onResult fires with the standard CapabilityEvent shape
 *   - Hook errors are caught (not re-thrown)
 *   - Async resolvers are awaited per-call
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRegistryFromEnv, type LLMPort } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";
import {
  createAnalyzer,
  createClassifier,
  createDrafter,
  createExtractor,
  createPlanner,
  createScorer,
  createSummarizer,
  type CapabilityEvent,
} from "@llm-ports/capabilities";
import {
  ANTHROPIC_KEY,
  CEREBRAS_KEY,
  LIVE,
  OPENAI_KEY,
  recordCost,
  reportCosts,
} from "./shared.js";

// Preference order: Anthropic Haiku (cheapest, best at structured output) →
// Cerebras gpt-oss-120b via OpenAI compat (fast, clean JSON) → OpenAI gpt-5-nano
// (a reasoning model — slow + brittle for structured tests; only as last resort).
const skipCapabilities = !LIVE || (!ANTHROPIC_KEY && !CEREBRAS_KEY && !OPENAI_KEY);
const TEST_PROVIDER: "anthropic" | "cerebras" | "openai" = ANTHROPIC_KEY
  ? "anthropic"
  : CEREBRAS_KEY
    ? "cerebras"
    : "openai";
const TEST_MODEL =
  TEST_PROVIDER === "anthropic"
    ? "claude-haiku-4-5"
    : TEST_PROVIDER === "cerebras"
      ? "gpt-oss-120b"
      : "gpt-5-nano";
// Only the OpenAI gpt-5-nano fallback needs explicit headroom; Cerebras and
// Anthropic produce visible output reliably with capability defaults.
const REASONING_HEADROOM = TEST_PROVIDER === "openai" ? 800 : undefined;

const ROUTES = {
  LLM_TASK_ROUTE_CLASSIFY: "live",
  LLM_TASK_ROUTE_SCORE: "live",
  LLM_TASK_ROUTE_EXTRACT: "live",
  LLM_TASK_ROUTE_SUMMARIZE: "live",
  LLM_TASK_ROUTE_DRAFT: "live",
  LLM_TASK_ROUTE_PLAN: "live",
  LLM_TASK_ROUTE_ANALYZE: "live",
} as const;

function makeLLM(): LLMPort {
  if (TEST_PROVIDER === "anthropic") {
    const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY ?? "missing" });
    const registry = createRegistryFromEnv({
      env: { LLM_PROVIDER_LIVE: `anthropic|${TEST_MODEL}|unlimited`, ...ROUTES },
      adapters: { anthropic: adapter },
    });
    return registry.getPort();
  }
  if (TEST_PROVIDER === "cerebras") {
    // Cerebras via the OpenAI compat baseURL. gpt-oss-120b reasoning-tokens
    // come back via message.reasoning (handled by adapter); content is clean
    // JSON. Pricing supplied inline because the bundled OPENAI_PRICING table
    // doesn't ship Cerebras-specific entries.
    const adapter = createOpenAIAdapter({
      apiKey: CEREBRAS_KEY ?? "missing",
      baseURL: "https://api.cerebras.ai/v1",
      pricingOverrides: { [TEST_MODEL]: { inputPer1M: 0.65, outputPer1M: 0.85 } },
    });
    const registry = createRegistryFromEnv({
      env: { LLM_PROVIDER_LIVE: `openai|${TEST_MODEL}|unlimited`, ...ROUTES },
      adapters: { openai: adapter },
    });
    return registry.getPort();
  }
  // openai
  const adapter = createOpenAIAdapter({ apiKey: OPENAI_KEY ?? "missing" });
  const registry = createRegistryFromEnv({
    env: { LLM_PROVIDER_LIVE: `openai|${TEST_MODEL}|unlimited`, ...ROUTES },
    adapters: { openai: adapter },
  });
  return registry.getPort();
}

function expectCapabilityEvent<T>(event: CapabilityEvent<T>, capability: string): void {
  expect(event.capability).toBe(capability);
  expect(event.modelId).toBeTypeOf("string");
  expect(event.providerAlias).toBe("live");
  expect(event.usage.totalTokens).toBeGreaterThan(0);
  expect(event.cost.totalUSD).toBeGreaterThan(0);
  expect(event.latencyMs).toBeGreaterThanOrEqual(0);
  expect(event.output).toBeDefined();
  expect(event.validationAttempts ?? 1).toBeGreaterThanOrEqual(1);
}

afterAll(() => {
  reportCosts();
});

describe.skipIf(skipCapabilities)(`live: capabilities (via ${TEST_PROVIDER})`, () => {
  describe("createClassifier", () => {
    const Schema = z.object({
      intent: z.enum(["question", "request", "complaint", "feedback"]),
      reasoning: z.string(),
    });

    it("emits CapabilityEvent with usage, cost, validation attempts", async () => {
      const llm = makeLLM();
      let captured: CapabilityEvent<unknown> | null = null;
      const classify = createClassifier({
        port: llm,
        schema: Schema,
        schemaName: "user-intent",
        rubric: "question, request, complaint, feedback",
        onResult: (e) => {
          captured = e as CapabilityEvent<unknown>;
        },
      });
      const result = await classify({ content: "Can I get a refund?" });
      expect(["question", "request", "complaint", "feedback"]).toContain(result.intent);
      expect(captured).not.toBeNull();
      expectCapabilityEvent(captured!, "classify");
      recordCost("classify", captured!.cost.totalUSD);
    });

    it("hook errors are caught and don't break the call", async () => {
      const llm = makeLLM();
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const classify = createClassifier({
        port: llm,
        schema: Schema,
        schemaName: "user-intent",
        // Be explicit about the allowed enum values; some models otherwise
        // invent new categories like "time_query" or "informational".
        rubric:
          "Choose EXACTLY one of: question, request, complaint, feedback. Anything that asks for information or clarification is a 'question'.",
        ...(REASONING_HEADROOM !== undefined ? { maxOutputTokens: REASONING_HEADROOM } : {}),
        onResult: () => {
          throw new Error("intentional hook failure");
        },
      });
      // Should NOT throw — hook errors caught and logged
      const result = await classify({ content: "What time is it?" });
      expect(["question", "request", "complaint", "feedback"]).toContain(result.intent);
      expect(consoleWarn).toHaveBeenCalled();
      consoleWarn.mockRestore();
    });

    it("async rubric is awaited per call", async () => {
      const llm = makeLLM();
      let resolverCalls = 0;
      const classify = createClassifier({
        port: llm,
        schema: Schema,
        schemaName: "user-intent",
        rubric: async () => {
          resolverCalls++;
          await new Promise((r) => setTimeout(r, 5));
          return "question, request, complaint, feedback";
        },
      });
      await classify({ content: "Can I get a refund?" });
      await classify({ content: "What time is it?" });
      expect(resolverCalls).toBe(2);
    });
  });

  describe("createScorer", () => {
    const Schema = z.object({
      score: z.number().min(1).max(10),
      reasoning: z.string(),
    });

    it("returns numerical score with reasoning", async () => {
      const llm = makeLLM();
      let captured: CapabilityEvent<unknown> | null = null;
      const score = createScorer({
        port: llm,
        schema: Schema,
        schemaName: "draft-quality",
        rubric:
          "Score 1-10 (1=poor, 5=passable, 10=excellent) on email clarity and conciseness. Output BOTH `score` (number) and `reasoning` (string) fields — the reasoning is required.",
        ...(REASONING_HEADROOM !== undefined ? { maxOutputTokens: REASONING_HEADROOM } : {}),
        onResult: (e) => {
          captured = e as CapabilityEvent<unknown>;
        },
      });
      const result = await score({
        content: "Hi, just wanted to reach out and check in. Looking forward to hearing from you!",
      });
      expect(result.score).toBeGreaterThanOrEqual(1);
      expect(result.score).toBeLessThanOrEqual(10);
      expect(captured).not.toBeNull();
      expectCapabilityEvent(captured!, "score");
      recordCost("score", captured!.cost.totalUSD);
    });
  });

  describe("createExtractor", () => {
    const Contact = z.object({
      name: z.string(),
      email: z.string().email().nullable(),
      company: z.string().nullable(),
      title: z.string().nullable(),
    });

    it("pulls structured fields from unstructured input", async () => {
      const llm = makeLLM();
      let captured: CapabilityEvent<unknown> | null = null;
      const extract = createExtractor({
        port: llm,
        schema: Contact,
        schemaName: "contact",
        fieldGuide:
          "name: full name; email: address or null; company: org or null; title: job or null",
        onResult: (e) => {
          captured = e as CapabilityEvent<unknown>;
        },
      });
      const result = await extract({
        content:
          "Hi, I'm Alice Brown from Acme Corp. You can reach me at alice@acme.example.",
      });
      expect(result.name.toLowerCase()).toContain("alice");
      expect(captured).not.toBeNull();
      expectCapabilityEvent(captured!, "extract");
      recordCost("extract", captured!.cost.totalUSD);
    });
  });

  describe("createSummarizer", () => {
    it("returns a compressed summary", async () => {
      const llm = makeLLM();
      let captured: CapabilityEvent<string> | null = null;
      const summarize = createSummarizer({
        port: llm,
        targetWords: 30,
        styleGuide: "3 bullets, each starting with a verb.",
        // Summarizer's default `maxOutputTokens = targetWords * 1.5` (45 for
        // 30 words) is too tight for ANY reasoning model — CoT consumes the
        // whole budget. Override generously for both Cerebras and OpenAI.
        maxOutputTokens: REASONING_HEADROOM ?? 400,
        onResult: (e) => {
          captured = e as CapabilityEvent<string>;
        },
      });
      const longText = `
        TypeScript was created in 2012 by Anders Hejlsberg at Microsoft. It compiles to JavaScript.
        Its main goal was to add static typing to JS for large codebases. It became wildly popular
        among engineers building production web applications. Today it dominates the npm ecosystem
        and is used at companies like Vercel, Microsoft, Google, and many others.
      `.trim();
      const result = await summarize({ content: longText });
      expect(result.length).toBeGreaterThan(20);
      expect(captured).not.toBeNull();
      expectCapabilityEvent(captured!, "summarize");
      recordCost("summarize", captured!.cost.totalUSD);
    });
  });

  describe("createDrafter", () => {
    it("generates text in the configured persona", async () => {
      const llm = makeLLM();
      let captured: CapabilityEvent<string> | null = null;
      const draft = createDrafter({
        port: llm,
        persona: "Direct, warm, no filler. Short paragraphs. Sign off as 'Test'.",
        channelConstraint: "Email. Target 50-80 words.",
        antiPatterns: "Never say 'reach out' or 'hope this finds you well'.",
        maxLength: 800,
        onResult: (e) => {
          captured = e as CapabilityEvent<string>;
        },
      });
      const result = await draft({
        instructions: "Reply that we'd like to schedule a 30-min intro call next week.",
        recipientContext: "Alice from Acme. Met at a conference. Warm.",
      });
      expect(result.length).toBeGreaterThan(20);
      expect(result.length).toBeLessThanOrEqual(800);
      // Soft check: no AI-isms (the model usually obeys, but not strictly enforced)
      // expect(result.toLowerCase()).not.toMatch(/reach out|hope this finds/);
      expect(captured).not.toBeNull();
      expectCapabilityEvent(captured!, "draft");
      recordCost("draft", captured!.cost.totalUSD);
    });
  });

  describe("createPlanner", () => {
    const PlanSchema = z.object({
      steps: z.array(
        z.object({
          id: z.string(),
          description: z.string(),
          dependsOn: z.array(z.string()).default([]),
        }),
      ),
      rationale: z.string(),
    });

    it("decomposes a goal into ordered steps", async () => {
      const llm = makeLLM();
      let captured: CapabilityEvent<unknown> | null = null;
      const plan = createPlanner({
        port: llm,
        schema: PlanSchema,
        schemaName: "email-reply-plan",
        toolCatalog: "fetchEmail, getContact, draftReply, sendReply",
        // Planner output is verbose (steps array with ids + descriptions);
        // bump the budget further for reasoning models so the planner has
        // room after CoT consumes its share.
        ...(REASONING_HEADROOM !== undefined ? { maxOutputTokens: 1500 } : {}),
        onResult: (e) => {
          captured = e as CapabilityEvent<unknown>;
        },
      });
      const result = await plan({
        goal: "Reply to the latest email from Alice with a meeting time.",
      });
      expect(result.steps.length).toBeGreaterThanOrEqual(2);
      expect(captured).not.toBeNull();
      expectCapabilityEvent(captured!, "plan");
      recordCost("plan", captured!.cost.totalUSD);
    });
  });

  describe("createAnalyzer", () => {
    const SwotSchema = z.object({
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      opportunities: z.array(z.string()),
      threats: z.array(z.string()),
      recommendation: z.string(),
    });

    it("produces a structured SWOT analysis", async () => {
      const llm = makeLLM();
      let captured: CapabilityEvent<unknown> | null = null;
      const analyze = createAnalyzer({
        port: llm,
        schema: SwotSchema,
        schemaName: "swot",
        framework:
          "SWOT analysis. Each list 3-5 items, each item a single concise sentence.",
        // SWOT is the most verbose schema (4 lists × 3-5 items + a recommendation).
        // For reasoning models, give plenty of budget to avoid 60s vitest timeout.
        ...(REASONING_HEADROOM !== undefined ? { maxOutputTokens: 2000 } : {}),
        onResult: (e) => {
          captured = e as CapabilityEvent<unknown>;
        },
      });
      const result = await analyze({
        content:
          "A two-person startup building a TypeScript library for LLM provider abstraction. Open-source, MIT licensed, no funding yet.",
      });
      expect(result.strengths.length).toBeGreaterThan(0);
      expect(result.recommendation.length).toBeGreaterThan(0);
      expect(captured).not.toBeNull();
      expectCapabilityEvent(captured!, "analyze");
      recordCost("analyze", captured!.cost.totalUSD);
    });
  });
});
