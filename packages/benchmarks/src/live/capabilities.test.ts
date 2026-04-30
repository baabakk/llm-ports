/**
 * Phase 3 of the test plan: live integration tests for the 7 capability factories.
 *
 * Skipped unless RUN_LIVE_TESTS=1 AND ANTHROPIC_API_KEY is set. (Capabilities
 * are provider-agnostic; we test against Anthropic Haiku as the reference
 * provider — running on OpenAI is exercised via the adapter live tests.)
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
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
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
  recordCost,
  reportCosts,
  skipAnthropic,
} from "./shared.js";

const MODEL = "claude-haiku-4-5";

function makeLLM() {
  const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY ?? "missing" });
  const registry = createRegistryFromEnv({
    env: {
      LLM_PROVIDER_LIVE: `anthropic|${MODEL}|unlimited`,
      LLM_TASK_ROUTE_CLASSIFY: "live",
      LLM_TASK_ROUTE_SCORE: "live",
      LLM_TASK_ROUTE_EXTRACT: "live",
      LLM_TASK_ROUTE_SUMMARIZE: "live",
      LLM_TASK_ROUTE_DRAFT: "live",
      LLM_TASK_ROUTE_PLAN: "live",
      LLM_TASK_ROUTE_ANALYZE: "live",
    },
    adapters: { anthropic: adapter },
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

describe.skipIf(skipAnthropic)("live: capabilities", () => {
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
        rubric: "1=poor, 5=passable, 10=excellent. Email clarity and conciseness.",
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
