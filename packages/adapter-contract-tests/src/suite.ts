/**
 * The shared contract test suite. Adapters call `runContractTests()` from
 * their own test files; this function calls vitest's describe/it APIs to
 * register the conformance assertions.
 */

import type { LLMPort, OnRetry, RetryEvent, TokenUsage } from "@llm-ports/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// ─── Mock-control surface adapters provide ──────────────────────────────

/** Adapter says: "the next generateText call will return this." */
export interface MockedGenerateText {
  text: string;
  usage: TokenUsage;
  modelId?: string;
}

export interface MockedGenerateStructured {
  /** The JSON object the adapter should hand back as parsed data. */
  data: unknown;
  usage: TokenUsage;
  modelId?: string;
  /** When set, the first attempt returns this invalid object; the second returns `data`. */
  invalidFirstAttempt?: unknown;
}

export interface MockedRunAgent {
  text: string;
  usage: TokenUsage;
  modelId?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; output: unknown }>;
  stepsTaken?: number;
  terminationReason?: "completed" | "max_steps" | "stopped_by_user";
}

export interface MockedStreamText {
  chunks: string[];
  usage: TokenUsage;
}

export interface MockedStreamStructured<T = unknown> {
  partials: Array<Partial<T>>;
  finalUsage: TokenUsage;
}

/**
 * Whatever a contract test needs from the adapter under test.
 * The adapter provides the port instance and a way to control mock responses.
 */
export interface ContractTestContext {
  port: LLMPort;
  /** Adapter alias used in env config; reflected in `result.providerAlias`. */
  expectedAlias: string;
  /** Model id the adapter is configured to use. */
  expectedModelId: string;

  // Mock setters. Adapters wire these to whatever HTTP mocking they use.
  setupGenerateText(response: MockedGenerateText): void;
  setupGenerateStructured(response: MockedGenerateStructured): void;
  setupStreamText(response: MockedStreamText): void;
  setupStreamStructured(response: MockedStreamStructured): void;
  setupRunAgent(response: MockedRunAgent): void;
  /** Make the next request fail with a network-style error. */
  setupNetworkError(error: Error): void;
  /**
   * Optional. When the adapter supports the {@link OnRetry} observability hook,
   * implement this to return a fresh port wired to the given hook. The
   * conformance suite uses this to verify the hook fires for the universal
   * `validation-feedback` retry reason. Adapters that do not support onRetry
   * (e.g. adapter-anthropic, adapter-ollama in v0.1) should leave it unset
   * and the corresponding conformance tests will skip.
   */
  createPortWithOnRetry?: (hook: OnRetry) => LLMPort;

  /**
   * Optional. Declares the adapter's image-content support. Used to gate the
   * conformance suite's image-pipeline tests:
   *   - `"base64"`: adapter accepts base64 ImageBlocks only (Ollama).
   *   - `"url"`: adapter accepts URL ImageBlocks only (no known adapter today).
   *   - `"base64+url"`: adapter accepts both (Anthropic, OpenAI).
   *   - `"none"` (or undefined): adapter does not pass image blocks through to
   *     the underlying model (Vercel v0.1 — degrades to text placeholder).
   * When set to anything other than `"none"` / undefined, the conformance suite
   * asserts that `generateText` with an image+text prompt completes without
   * throwing and returns the expected response. Adapters that degrade images
   * to text placeholders should leave this unset so the test skips.
   */
  imageContentSupport?: "none" | "base64" | "url" | "base64+url";

  /**
   * Optional. Declares the adapter's AbortSignal cancellation support.
   *   - `"entry-only"`: adapter checks signal.aborted at entry but cannot
   *     cancel an in-flight provider HTTP fetch (Ollama in v0.1: the
   *     ollama-js SDK only exposes a coarse client.abort(), not per-call).
   *   - `"entry+inflight"`: full cancellation — entry-time check AND signal
   *     threaded into the SDK's fetch options. The contract suite runs
   *     mid-flight cancellation tests against these adapters.
   *   - `"none"` (or undefined): adapter ignores signal entirely. Tests skip.
   *
   * Available since `0.1.0-alpha.6`. Tests are conditional; adapters that
   * pre-date abort-signal support leave this unset to keep their old test
   * shapes valid.
   */
  signalSupport?: "none" | "entry-only" | "entry+inflight";
}

/** A factory for the test context. Called fresh for each test. */
export type ContractTestSetup = () => Promise<ContractTestContext> | ContractTestContext;

// ─── The shared suite ──────────────────────────────────────────────────

/**
 * Register the conformance suite under the given name.
 * Call this from each adapter package's test file.
 */
export function runContractTests(name: string, setup: ContractTestSetup): void {
  describe(`adapter contract: ${name}`, () => {
    describe("generateText", () => {
      it("returns the populated GenerateTextResult shape", async () => {
        const ctx = await setup();
        ctx.setupGenerateText({
          text: "hello world",
          usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
        });

        const result = await ctx.port.generateText({
          taskType: "test-text",
          prompt: "say hello",
        });

        expect(result.text).toBe("hello world");
        expect(result.usage.totalTokens).toBe(17);
        // >= 0: local-model adapters (e.g. Ollama) legitimately report zero cost
        expect(result.cost.totalUSD).toBeGreaterThanOrEqual(0);
        expect(result.modelId).toBe(ctx.expectedModelId);
        expect(result.providerAlias).toBe(ctx.expectedAlias);
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      });

      it("propagates adapter errors with informative messages", async () => {
        const ctx = await setup();
        ctx.setupNetworkError(new Error("simulated network failure"));

        await expect(
          ctx.port.generateText({ taskType: "test-text", prompt: "hi" }),
        ).rejects.toThrow(/network|failure|unavailable/i);
      });
    });

    describe("generateStructured", () => {
      const Schema = z.object({
        intent: z.enum(["question", "request"]),
        urgency: z.enum(["low", "high"]),
      });

      it("validates output against the Zod schema and returns typed data", async () => {
        const ctx = await setup();
        ctx.setupGenerateStructured({
          data: { intent: "request", urgency: "high" },
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });

        const result = await ctx.port.generateStructured({
          taskType: "test-classify",
          prompt: "classify this",
          schema: Schema,
          schemaName: "TestSchema",
        });

        expect(result.data).toEqual({ intent: "request", urgency: "high" });
        expect(result.usage.totalTokens).toBe(70);
        // >= 0: local-model adapters (e.g. Ollama) legitimately report zero cost
        expect(result.cost.totalUSD).toBeGreaterThanOrEqual(0);
        // Regression pin for TD-LLMPORTS-VALIDATION-ATTEMPTS (resolved alpha.11):
        // first-try success MUST report exactly 1 attempt (not 0, not 2+).
        expect(result.validationAttempts).toBe(1);
      });

      it("retries with feedback when first attempt fails validation", async () => {
        const ctx = await setup();
        ctx.setupGenerateStructured({
          invalidFirstAttempt: { intent: "WRONG_VALUE", urgency: "high" },
          data: { intent: "request", urgency: "high" },
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });

        const result = await ctx.port.generateStructured({
          taskType: "test-classify",
          prompt: "classify this",
          schema: Schema,
          schemaName: "TestSchema",
        });

        expect(result.data).toEqual({ intent: "request", urgency: "high" });
        // Regression pin for TD-LLMPORTS-VALIDATION-ATTEMPTS: after 1 retry the
        // counter MUST be exactly 2 (initial attempt + 1 retry), not just >=2.
        // Catches re-introduction of the "overwrites instead of accumulates" bug.
        expect(result.validationAttempts).toBe(2);
      });
    });

    describe("streamText", () => {
      it("yields chunks in order and consumes cleanly", async () => {
        const ctx = await setup();
        ctx.setupStreamText({
          chunks: ["hel", "lo ", "wor", "ld"],
          usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
        });

        const collected: string[] = [];
        for await (const chunk of ctx.port.streamText({
          taskType: "test-stream",
          prompt: "stream a greeting",
        })) {
          collected.push(chunk);
        }

        expect(collected.join("")).toBe("hello world");
      });
    });

    describe("streamStructured", () => {
      const Schema = z.object({ ready: z.boolean(), message: z.string() });

      it("yields successively more complete partial objects", async () => {
        const ctx = await setup();
        ctx.setupStreamStructured({
          partials: [{ ready: false }, { ready: true, message: "done" }],
          finalUsage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
        });

        const collected: Array<Partial<{ ready: boolean; message: string }>> = [];
        for await (const partial of ctx.port.streamStructured({
          taskType: "test-stream-structured",
          prompt: "stream a status",
          schema: Schema,
        })) {
          collected.push(partial);
        }

        expect(collected.length).toBeGreaterThan(0);
        expect(collected[collected.length - 1]).toMatchObject({
          ready: true,
          message: "done",
        });
      });
    });

    describe("onRetry observability (conditional)", () => {
      const Schema = z.object({
        intent: z.enum(["question", "request"]),
        urgency: z.enum(["low", "high"]),
      });

      it("fires for validation-feedback when adapter retries a structured response", async () => {
        const ctx = await setup();
        if (!ctx.createPortWithOnRetry) {
          // Adapter does not support onRetry; skip without failing.
          return;
        }
        ctx.setupGenerateStructured({
          invalidFirstAttempt: { intent: "WRONG_VALUE", urgency: "high" },
          data: { intent: "request", urgency: "high" },
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });

        const events: RetryEvent[] = [];
        const hookedPort = ctx.createPortWithOnRetry((e) => {
          events.push(e);
        });

        const result = await hookedPort.generateStructured({
          taskType: "test-classify",
          prompt: "classify this",
          schema: Schema,
          schemaName: "TestSchema",
        });

        expect(result.data).toEqual({ intent: "request", urgency: "high" });
        expect(events.some((e) => e.reason === "validation-feedback")).toBe(true);
        const ev = events.find((e) => e.reason === "validation-feedback")!;
        expect(ev.providerAlias).toBe(ctx.expectedAlias);
        expect(ev.modelId).toBe(ctx.expectedModelId);
      });

      it("hook errors do NOT cancel the retry (observability only)", async () => {
        const ctx = await setup();
        if (!ctx.createPortWithOnRetry) return;
        ctx.setupGenerateStructured({
          invalidFirstAttempt: { intent: "WRONG_VALUE", urgency: "high" },
          data: { intent: "request", urgency: "high" },
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });

        const hookedPort = ctx.createPortWithOnRetry(() => {
          throw new Error("hook exploded");
        });

        const result = await hookedPort.generateStructured({
          taskType: "test-classify",
          prompt: "classify this",
          schema: Schema,
          schemaName: "TestSchema",
        });

        // Despite the hook throwing, the retry succeeded.
        expect(result.data).toEqual({ intent: "request", urgency: "high" });
      });

      it("async hook rejections do NOT cancel the retry", async () => {
        const ctx = await setup();
        if (!ctx.createPortWithOnRetry) return;
        ctx.setupGenerateStructured({
          invalidFirstAttempt: { intent: "WRONG_VALUE", urgency: "high" },
          data: { intent: "request", urgency: "high" },
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });

        const hookedPort = ctx.createPortWithOnRetry(async () => {
          await Promise.resolve();
          throw new Error("hook rejected");
        });

        const result = await hookedPort.generateStructured({
          taskType: "test-classify",
          prompt: "classify this",
          schema: Schema,
          schemaName: "TestSchema",
        });

        expect(result.data).toEqual({ intent: "request", urgency: "high" });
      });
    });

    describe("image content blocks (conditional)", () => {
      // A 1×1 transparent PNG, base64-encoded. Smallest possible image payload —
      // works on every vision-capable model the adapters target.
      const tinyPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      it("generateText accepts a base64 ImageBlock in the prompt", async () => {
        const ctx = await setup();
        if (
          ctx.imageContentSupport === undefined ||
          ctx.imageContentSupport === "none" ||
          ctx.imageContentSupport === "url"
        ) {
          return;
        }

        ctx.setupGenerateText({
          text: "I see a 1x1 image",
          usage: { inputTokens: 200, outputTokens: 10, totalTokens: 210 },
        });

        const result = await ctx.port.generateText({
          taskType: "test-vision",
          prompt: [
            { type: "text", text: "What is in this image?" },
            {
              type: "image",
              source: { kind: "base64", mediaType: "image/png", data: tinyPng },
            },
          ],
        });

        expect(result.text).toBe("I see a 1x1 image");
        expect(result.usage.totalTokens).toBe(210);
        expect(result.providerAlias).toBe(ctx.expectedAlias);
      });

      it("generateText accepts a URL ImageBlock in the prompt", async () => {
        const ctx = await setup();
        if (
          ctx.imageContentSupport === undefined ||
          ctx.imageContentSupport === "none" ||
          ctx.imageContentSupport === "base64"
        ) {
          return;
        }

        ctx.setupGenerateText({
          text: "I see a cat",
          usage: { inputTokens: 250, outputTokens: 8, totalTokens: 258 },
        });

        const result = await ctx.port.generateText({
          taskType: "test-vision-url",
          prompt: [
            { type: "text", text: "What is in this image?" },
            { type: "image", source: { kind: "url", url: "https://example.com/cat.png" } },
          ],
        });

        expect(result.text).toBe("I see a cat");
        expect(result.providerAlias).toBe(ctx.expectedAlias);
      });
    });

    describe("AbortSignal cancellation (conditional)", () => {
      it("throws at entry when the signal is already aborted (generateText)", async () => {
        const ctx = await setup();
        if (
          ctx.signalSupport === undefined ||
          ctx.signalSupport === "none"
        ) {
          return;
        }
        // Set up a response just in case; the test asserts the adapter
        // throws BEFORE consuming it.
        ctx.setupGenerateText({
          text: "should not be returned",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });

        const controller = new AbortController();
        controller.abort();

        await expect(
          ctx.port.generateText({
            taskType: "test-signal",
            prompt: "hi",
            signal: controller.signal,
          }),
        ).rejects.toBeDefined();
      });

      it("throws at entry when the signal is already aborted (generateStructured)", async () => {
        const ctx = await setup();
        if (
          ctx.signalSupport === undefined ||
          ctx.signalSupport === "none"
        ) {
          return;
        }
        ctx.setupGenerateStructured({
          data: { intent: "request", urgency: "high" },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });

        const Schema = z.object({
          intent: z.enum(["request", "info"]),
          urgency: z.enum(["high", "medium", "low"]),
        });
        const controller = new AbortController();
        controller.abort();

        await expect(
          ctx.port.generateStructured({
            taskType: "test-signal-structured",
            prompt: "hi",
            schema: Schema,
            schemaName: "TestSchema",
            signal: controller.signal,
          }),
        ).rejects.toBeDefined();
      });

      it("throws at entry when the signal is already aborted (runAgent)", async () => {
        const ctx = await setup();
        if (
          ctx.signalSupport === undefined ||
          ctx.signalSupport === "none"
        ) {
          return;
        }
        ctx.setupRunAgent({
          text: "should not be returned",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          stepsTaken: 1,
          terminationReason: "completed",
        });

        const controller = new AbortController();
        controller.abort();

        await expect(
          ctx.port.runAgent({
            taskType: "test-signal-agent",
            instructions: "You are helpful.",
            messages: [{ role: "user", content: "hi" }],
            tools: {},
            maxSteps: 3,
            signal: controller.signal,
          }),
        ).rejects.toBeDefined();
      });
    });

    describe("runAgent", () => {
      it("returns the populated AgentResult shape", async () => {
        const ctx = await setup();
        ctx.setupRunAgent({
          text: "I have looked it up.",
          usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
          stepsTaken: 1,
          terminationReason: "completed",
        });

        const result = await ctx.port.runAgent({
          taskType: "test-agent",
          instructions: "You are a helpful agent.",
          messages: [{ role: "user", content: "What is 2+2?" }],
          tools: {},
          maxSteps: 3,
        });

        expect(result.text).toBeDefined();
        expect(result.stepsTaken).toBeGreaterThanOrEqual(0);
        expect(["completed", "max_steps", "stopped_by_user"]).toContain(
          result.terminationReason,
        );
        expect(result.usage.totalTokens).toBe(250);
        // >= 0: local-model adapters (e.g. Ollama) legitimately report zero cost
        expect(result.cost.totalUSD).toBeGreaterThanOrEqual(0);
      });
    });
  });
}
