/**
 * The shared contract test suite. Adapters call `runContractTests()` from
 * their own test files; this function calls vitest's describe/it APIs to
 * register the conformance assertions.
 */

import { ConfigError, ValidationError } from "@llm-ports/core";
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

  /**
   * Optional. Report what the adapter transmitted on the most recent
   * `runAgent` call, so the suite can check that required inputs were not
   * silently dropped.
   *
   * Gated the same way as {@link imageContentSupport}: an adapter that cannot
   * observe its own outbound request leaves this unset and the
   * honoured-or-refused tests skip, rather than failing every adapter that
   * predates the field.
   *
   * Added for `1.0.0-rc.36`. See
   * `TD-LLMPORTS-CLI-ADAPTERS-DISCARD-REQUIRED-INPUTS-AND-SIT-OUTSIDE-THE-CONTRACT-SUITE`.
   */
  inspectLastRunAgentRequest?: () => RunAgentTransmission;

  /**
   * Optional. Port methods this adapter deliberately does not implement.
   *
   * The suite otherwise assumes every adapter serves every method, which is
   * true of the in-process adapters and false of the subprocess ones: a
   * coding-agent CLI serves `runAgent` and nothing else. Without this, such an
   * adapter fails most of the suite for entirely legitimate reasons.
   *
   * Declaring a method here does two things. The suite skips that method's
   * conformance tests, and it asserts the method **throws** when called, so a
   * declared refusal is a real one rather than a silent degradation. That is
   * the same rule as the honoured-or-refused tests, applied one level up: an
   * adapter may refuse a capability and may not pretend to have it.
   *
   * Added for `1.0.0-rc.36`.
   */
  unsupportedMethods?: readonly ("generateText" | "generateStructured" | "streamText" | "streamStructured")[];

  /**
   * Optional. How the provider behind this adapter is billed.
   *
   * The suite otherwise asserts a per-call dollar cost is reported, which is
   * right for a metered API and impossible for a subscription CLI: there is no
   * per-call price to report, and inventing a zero is the lie `alpha.34`
   * removed everywhere else.
   *
   * Three values, because two collapsed a distinction that matters.
   *
   * - `"metered"` (the default): a per-call price exists and the adapter can
   *   report it. The cost assertion applies.
   * - `"flat_rate"`: no per-call price exists at all, which is a subscription.
   *   A cost gate configured against such a provider can never fire, so it
   *   should be refused at construction rather than enforce nothing silently.
   * - `"unknown"`: a price exists at the provider and this adapter cannot
   *   observe it, which is a CLI that does not report what a run cost. A cost
   *   gate here is not meaningless, it is unenforceable, and that is a
   *   different thing to tell an operator.
   *
   * Both non-metered values relax the cost assertion and keep the token one,
   * because tokens are the only way to compare them against a metered
   * provider.
   *
   * Added for `1.0.0-rc.36`, from a consumer requirement: a cost gate
   * configured against a flat-rate provider enforces nothing, silently and
   * forever. See
   * `TD-LLMPORTS-CONSUMER-REQUIREMENTS-FOR-THE-SUBPROCESS-ADAPTER-FAMILY`.
   */
  billing?: "metered" | "flat_rate" | "unknown";

  /**
   * Optional. Whether this adapter can observe token usage at all.
   *
   * `"observed"` (the default) means the provider reports usage and the suite
   * asserts the adapter passes it through faithfully. `"unavailable"` means the
   * provider's protocol carries no usage, which is true of a CLI emitting plain
   * text, and the suite then only requires the field be present and
   * non-negative.
   *
   * **This exists because the honest value is `undefined` and the contract has
   * no way to say it.** `TokenUsage` requires numbers, so an adapter that
   * cannot observe usage reports zeros, and a zero is indistinguishable from a
   * genuinely free call: the same substitution `alpha.34` removed for cost and
   * left in place for tokens. Declaring it here does not fix that; it stops the
   * suite asserting a number the adapter was never able to know, and marks
   * where the real fix belongs. A consumer requirement names it directly: see
   * `TD-LLMPORTS-CONSUMER-REQUIREMENTS-FOR-THE-SUBPROCESS-ADAPTER-FAMILY`.
   */
  usageReporting?: "observed" | "unavailable";
}

/**
 * What an adapter actually transmitted on the last `runAgent` call.
 *
 * Reported by the adapter's test harness, not inferred by the suite, because
 * only the adapter knows what its provider protocol looked like on the wire.
 */
export interface RunAgentTransmission {
  /** The system/developer instruction text as transmitted, if any. */
  instructions: string | undefined;
  /** Names of the tools made available to the model. */
  toolNames: readonly string[];
  /** Message roles in transmitted order, e.g. `["user","assistant","user"]`. */
  messageRoles: readonly string[];
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
        if (ctx.unsupportedMethods?.includes("generateText")) return;
        ctx.setupGenerateText({
          text: "hello world",
          usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
        });

        const result = await ctx.port.generateText({
          taskType: "test-text",
          messages: [{ role: "user" as const, content: "say hello" }],
        });

        expect(result.text).toBe("hello world");
        expect(result.usage.totalTokens).toBe(17);
        // >= 0: local-model adapters (e.g. Ollama) legitimately report zero cost
        // These fixtures give the adapter a real pricing table, so cost is
        // knowable and must actually be reported. Asserting it is defined
        // is stronger than coalescing, which would pass for an adapter that
        // silently stopped computing cost at all.
        expect(result.cost).toBeDefined();
        expect(result.cost?.totalUSD).toBeGreaterThanOrEqual(0);
        expect(result.modelId).toBe(ctx.expectedModelId);
        expect(result.providerAlias).toBe(ctx.expectedAlias);
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      });

      it("propagates adapter errors with informative messages", async () => {
        const ctx = await setup();
        if (ctx.unsupportedMethods?.includes("generateText")) return;
        ctx.setupNetworkError(new Error("simulated network failure"));

        await expect(
          ctx.port.generateText({ taskType: "test-text", messages: [{ role: "user" as const, content: "hi" }] }),
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
        if (ctx.unsupportedMethods?.includes("generateStructured")) return;
        ctx.setupGenerateStructured({
          data: { intent: "request", urgency: "high" },
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });

        const result = await ctx.port.generateStructured({
          taskType: "test-classify",
          messages: [{ role: "user" as const, content: "classify this" }],
          schema: Schema,
          schemaName: "TestSchema",
        });

        expect(result.data).toEqual({ intent: "request", urgency: "high" });
        expect(result.usage.totalTokens).toBe(70);
        // >= 0: local-model adapters (e.g. Ollama) legitimately report zero cost
        // These fixtures give the adapter a real pricing table, so cost is
        // knowable and must actually be reported. Asserting it is defined
        // is stronger than coalescing, which would pass for an adapter that
        // silently stopped computing cost at all.
        expect(result.cost).toBeDefined();
        expect(result.cost?.totalUSD).toBeGreaterThanOrEqual(0);
        // Regression pin for TD-LLMPORTS-VALIDATION-ATTEMPTS (resolved alpha.11):
        // first-try success MUST report exactly 1 attempt (not 0, not 2+).
        expect(result.validationAttempts).toBe(1);
      });

      // ── The JSON Schema input form (alpha.35) ───────────────────────
      //
      // `jsonSchema` is an alternative to `schema`, and it shipped in all five
      // adapters that serve generateStructured while being tested in one of
      // them. That is the gap these three close: the decision about neither
      // and both lives in one shared resolver in core, but each adapter wires
      // it up itself, and the wiring is the part that can be wrong.
      //
      // Deliberately NOT asserted here: that the schema reaches the provider
      // in any particular wire shape. That is per-provider and belongs in each
      // adapter's own quirk tests. What every adapter must agree on is the
      // behaviour a caller sees.
      it("accepts a JSON Schema in place of a Zod schema, reporting one attempt", async () => {
        const ctx = await setup();
        if (ctx.unsupportedMethods?.includes("generateStructured")) return;
        ctx.setupGenerateStructured({
          data: { intent: "request", urgency: "high" },
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });

        const result = await ctx.port.generateStructured<{ intent: string; urgency: string }>({
          taskType: "test-classify",
          messages: [{ role: "user" as const, content: "classify this" }],
          jsonSchema: {
            type: "object",
            additionalProperties: false,
            required: ["intent", "urgency"],
            properties: {
              intent: { type: "string", enum: ["question", "request"] },
              urgency: { type: "string", enum: ["low", "high"] },
            },
          },
          schemaName: "TestSchema",
        });

        expect(result.data).toEqual({ intent: "request", urgency: "high" });
        expect(result.usage.totalTokens).toBe(70);
        // One attempt is the honest number on this path: no local validation
        // round ran, because the library carries no JSON Schema validator, so
        // reporting more would overstate what was checked.
        expect(result.validationAttempts).toBe(1);
      });

      it("refuses a call carrying both schema forms", async () => {
        const ctx = await setup();
        if (ctx.unsupportedMethods?.includes("generateStructured")) return;
        ctx.setupGenerateStructured({
          data: { intent: "request", urgency: "high" },
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });

        // Rejected rather than resolved by precedence: a call with both
        // carries two intentions, and honouring one silently makes the other a
        // bug nobody can see.
        await expect(
          ctx.port.generateStructured({
            taskType: "test-classify",
            messages: [{ role: "user" as const, content: "classify this" }],
            schema: Schema,
            jsonSchema: { type: "object", properties: {} },
          }),
        ).rejects.toBeInstanceOf(ConfigError);
      });

      it("refuses a call carrying neither schema form", async () => {
        const ctx = await setup();
        if (ctx.unsupportedMethods?.includes("generateStructured")) return;
        ctx.setupGenerateStructured({
          data: { intent: "request", urgency: "high" },
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });

        await expect(
          ctx.port.generateStructured({
            taskType: "test-classify",
            messages: [{ role: "user" as const, content: "classify this" }],
          } as never),
        ).rejects.toBeInstanceOf(ConfigError);
      });

      it("retries with feedback when first attempt fails validation", async () => {
        const ctx = await setup();
        if (ctx.unsupportedMethods?.includes("generateStructured")) return;
        ctx.setupGenerateStructured({
          invalidFirstAttempt: { intent: "WRONG_VALUE", urgency: "high" },
          data: { intent: "request", urgency: "high" },
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });

        const result = await ctx.port.generateStructured({
          taskType: "test-classify",
          messages: [{ role: "user" as const, content: "classify this" }],
          schema: Schema,
          schemaName: "TestSchema",
        });

        expect(result.data).toEqual({ intent: "request", urgency: "high" });
        // Regression pin for TD-LLMPORTS-VALIDATION-ATTEMPTS: after 1 retry the
        // counter MUST be exactly 2 (initial attempt + 1 retry), not just >=2.
        // Catches re-introduction of the "overwrites instead of accumulates" bug.
        expect(result.validationAttempts).toBe(2);
      });

      /**
       * Alpha.35, alpha.28 item 15 (BEPA): every adapter must surface the same
       * error for a schema that never validates, carrying the field-level
       * issues, so one error handler works across providers.
       *
       * A bare message is the failure this pins. A consumer that gets only
       * "validation failed" has to parse prose to learn which field was wrong,
       * and the shape of that prose is per-adapter, which is how a handler
       * ends up written twice.
       *
       * This is a beta-gate item: cross-adapter behaviour is frozen at the
       * freeze whether or not a test pins it, so it gets pinned first.
       */
      it("surfaces a ValidationError carrying the Zod issues when no attempt validates", async () => {
        const ctx = await setup();
        if (ctx.unsupportedMethods?.includes("generateStructured")) return;
        // Both queued responses are invalid, so the retry cannot rescue it.
        ctx.setupGenerateStructured({
          invalidFirstAttempt: { intent: "NOT_AN_INTENT", urgency: "high" },
          data: { intent: "STILL_NOT", urgency: "high" },
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        });

        const error = await ctx.port
          .generateStructured({
            taskType: "test-classify",
            messages: [{ role: "user" as const, content: "classify this" }],
            schema: Schema,
            schemaName: "TestSchema",
          })
          .then(
            () => undefined,
            (e: unknown) => e,
          );

        expect(error).toBeInstanceOf(ValidationError);
        const validation = error as ValidationError;
        expect(Array.isArray(validation.issues)).toBe(true);
        expect(validation.issues.length).toBeGreaterThan(0);
        // The issue must name the field, not merely describe the failure.
        expect(validation.issues[0]).toHaveProperty("path");
        expect(validation.issues[0]).toHaveProperty("message");
        expect(validation.issues.some((issue) => issue.path.includes("intent"))).toBe(true);
        // And the attempt count must be reported, so a caller can tell one
        // bad response from a model that cannot produce the shape at all.
        expect(validation.attempts).toBeGreaterThanOrEqual(1);
      });
    });

    describe("streamText", () => {
      it("yields chunks in order and consumes cleanly", async () => {
        const ctx = await setup();
        if (ctx.unsupportedMethods?.includes("streamText")) return;
        ctx.setupStreamText({
          chunks: ["hel", "lo ", "wor", "ld"],
          usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
        });

        const collected: string[] = [];
        for await (const chunk of ctx.port.streamText({
          taskType: "test-stream",
          messages: [{ role: "user" as const, content: "stream a greeting" }],
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
        if (ctx.unsupportedMethods?.includes("streamStructured")) return;
        ctx.setupStreamStructured({
          partials: [{ ready: false }, { ready: true, message: "done" }],
          finalUsage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
        });

        const collected: Array<Partial<{ ready: boolean; message: string }>> = [];
        for await (const partial of ctx.port.streamStructured({
          taskType: "test-stream-structured",
          messages: [{ role: "user" as const, content: "stream a status" }],
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
          messages: [{ role: "user" as const, content: "classify this" }],
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
          messages: [{ role: "user" as const, content: "classify this" }],
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
          messages: [{ role: "user" as const, content: "classify this" }],
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
          messages: [
            {
              role: "user" as const,
              content: [
                { type: "text", text: "What is in this image?" },
                {
                  type: "image",
                  source: { kind: "base64", mediaType: "image/png", data: tinyPng },
                },
              ],
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
          messages: [
            {
              role: "user" as const,
              content: [
                { type: "text", text: "What is in this image?" },
                { type: "image", source: { kind: "url", url: "https://example.com/cat.png" } },
              ],
            },
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
            messages: [{ role: "user" as const, content: "hi" }],
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
            messages: [{ role: "user" as const, content: "hi" }],
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
        if ((ctx.usageReporting ?? "observed") === "unavailable") {
          // The provider's protocol carries no usage, so there is nothing to
          // pass through. Zero is what gets reported and undefined is what
          // would be true, which is the gap this declaration marks.
          expect(result.usage.totalTokens).toBeGreaterThanOrEqual(0);
        } else {
          expect(result.usage.totalTokens).toBe(250);
        }
        // >= 0: local-model adapters (e.g. Ollama) legitimately report zero cost
        // These fixtures give the adapter a real pricing table, so cost is
        // knowable and must actually be reported. Asserting it is defined
        // is stronger than coalescing, which would pass for an adapter that
        // silently stopped computing cost at all.
        // A flat-rate provider has no per-call price. Reporting zero would be
        // indistinguishable from a genuinely free call, which is the exact
        // substitution alpha.34 removed, so such an adapter reports nothing
        // and is checked on tokens instead.
        if ((ctx.billing ?? "metered") !== "metered") {
          expect(result.usage.totalTokens).toBeGreaterThanOrEqual(0);
        } else {
          expect(result.cost).toBeDefined();
          expect(result.cost?.totalUSD).toBeGreaterThanOrEqual(0);
        }
      });
    });

    // ─── Inputs are honoured or refused, never ignored ──────────────────
    //
    // An adapter may refuse an input it cannot serve. It may not accept one
    // and quietly drop it. The difference is the whole rule: a dropped input
    // yields a well-formed, successful-looking result from a call that did
    // not do what the caller asked, and nothing in the result says so.
    //
    // `instructions` and `tools` are REQUIRED on RunAgentOptions, so an
    // adapter reading neither still satisfies the type. Two subprocess
    // adapters did exactly that for five releases, and nothing caught it
    // because they were the only publishable adapters outside this suite.
    describe("inputs are honoured or refused, never ignored", () => {
      const BASE = { taskType: "test-agent", maxSteps: 3 } as const;

      async function attempt(
        ctx: ContractTestContext,
        options: Parameters<LLMPort["runAgent"]>[0],
      ): Promise<{ sent?: RunAgentTransmission; error?: Error }> {
        ctx.setupRunAgent({
          text: "ack",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });
        try {
          await ctx.port.runAgent(options);
        } catch (err) {
          return { error: err as Error };
        }
        return { sent: ctx.inspectLastRunAgentRequest!() };
      }

      it("carries `instructions`, or refuses and says so", async () => {
        const ctx = await setup();
        if (!ctx.inspectLastRunAgentRequest) return;

        const marker = "SYSTEM-MARKER-7f3a";
        const { sent, error } = await attempt(ctx, {
          ...BASE,
          instructions: marker,
          messages: [{ role: "user", content: "hello" }],
          tools: {},
        });

        // Refusing is allowed. Refusing without naming what was refused is
        // not, because the caller cannot act on it.
        if (error) {
          expect(error.message.toLowerCase()).toContain("instruction");
          return;
        }
        expect(sent?.instructions ?? "").toContain(marker);
      });

      it("carries `tools`, or refuses and says so", async () => {
        const ctx = await setup();
        if (!ctx.inspectLastRunAgentRequest) return;

        const { sent, error } = await attempt(ctx, {
          ...BASE,
          instructions: "be helpful",
          messages: [{ role: "user", content: "look it up" }],
          tools: {
            lookup_invoice: {
              name: "lookup_invoice",
              description: "Look up an invoice by id",
              inputSchema: z.object({ id: z.string() }),
              execute: async () => ({ ok: true }),
            },
          },
        });

        if (error) {
          expect(error.message.toLowerCase()).toContain("tool");
          return;
        }
        expect(sent?.toolNames ?? []).toContain("lookup_invoice");
      });

      it("carries assistant turns, or refuses rather than dropping them", async () => {
        const ctx = await setup();
        if (!ctx.inspectLastRunAgentRequest) return;

        const { sent, error } = await attempt(ctx, {
          ...BASE,
          instructions: "be helpful",
          messages: [
            { role: "user", content: "what is 2+2?" },
            { role: "assistant", content: "4" },
            { role: "user", content: "and times 3?" },
          ],
          tools: {},
        });

        // A silent drop here is the worst of the three: the model is asked to
        // continue a conversation whose own previous answers it cannot see,
        // and the only symptom is that it appears to have forgotten.
        if (error) {
          expect(error.message.length).toBeGreaterThan(0);
          return;
        }
        expect(sent?.messageRoles ?? []).toContain("assistant");
      });

      it("accepts a tool described by JSON Schema, or refuses it as it would a Zod one", async () => {
        const ctx = await setup();
        if (!ctx.inspectLastRunAgentRequest) return;

        // A gateway forwarding its own clients' tools holds JSON Schema and
        // cannot convert to Zod and back without losing what it was given.
        // Added in 1.0.0-rc.36 from TD-LLMPORTS-TOOLS-ARE-ZOD-ONLY.
        const { sent, error } = await attempt(ctx, {
          ...BASE,
          instructions: "be helpful",
          messages: [{ role: "user", content: "look it up" }],
          tools: {
            lookup_invoice: {
              name: "lookup_invoice",
              description: "Look up an invoice by id",
              inputJsonSchema: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string" } },
              },
              execute: async () => ({ ok: true }),
            },
          },
        });

        // An adapter with no tool channel refuses either form, which is
        // consistent rather than a gap. What must not happen is accepting the
        // Zod form and dropping this one.
        if (error) {
          expect(error.message.toLowerCase()).toContain("tool");
          return;
        }
        expect(sent?.toolNames ?? []).toContain("lookup_invoice");
      });

      it("throws for every method it declares unsupported", async () => {
        const ctx = await setup();
        const declared = ctx.unsupportedMethods ?? [];
        if (declared.length === 0) return;

        for (const method of declared) {
          let threw = false;
          try {
            if (method === "generateText") {
              await ctx.port.generateText({ taskType: "t", messages: [{ role: "user", content: "x" }] });
            } else if (method === "generateStructured") {
              await ctx.port.generateStructured({
                taskType: "t",
                messages: [{ role: "user", content: "x" }],
                schema: z.object({ ok: z.boolean() }),
              });
            } else if (method === "streamText") {
              // Prime the generator without binding a value: a streaming
              // adapter throws on the first `next()`, not at call time.
              await ctx.port
                .streamText({ taskType: "t", messages: [{ role: "user", content: "x" }] })
                [Symbol.asyncIterator]()
                .next();
            } else {
              await ctx.port
                .streamStructured({
                  taskType: "t",
                  messages: [{ role: "user", content: "x" }],
                  schema: z.object({ ok: z.boolean() }),
                })
                [Symbol.asyncIterator]()
                .next();
            }
          } catch {
            threw = true;
          }
          // A declared refusal that silently succeeds is worse than an
          // undeclared one, because the declaration invites a consumer to
          // trust the boundary.
          expect(threw, `${method} is declared unsupported and must throw`).toBe(true);
        }
      });
    });
  });
}
