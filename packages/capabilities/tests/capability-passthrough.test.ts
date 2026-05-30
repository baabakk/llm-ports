/**
 * Capability factories now thread `reasoningEffort` (per-factory) +
 * `signal` / `forceProviderAlias` (per-call) through to the underlying
 * `port.generateStructured` / `port.generateText` call. Added in alpha.13
 * after BEPA observed that `createScorer` silently dropped `reasoningEffort`
 * even when set on the factory config.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createClassifier,
  createScorer,
  createExtractor,
  createAnalyzer,
  createPlanner,
  createDrafter,
  createSummarizer,
} from "../src/index.js";
import { createFakePort } from "./helpers/fake-port.js";

const TrivialSchema = z.object({ ok: z.boolean() });

describe("capability factories — alpha.13 passthrough", () => {
  describe("reasoningEffort (per-factory)", () => {
    it.each([
      ["createClassifier", () => createClassifier({
        port: createFakePort().port,
        schema: TrivialSchema,
        schemaName: "x",
        reasoningEffort: "high" as const,
      })],
    ])("%s forwards reasoningEffort to port.generateStructured", async (_name, factoryBuilder) => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const classifier = createClassifier({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
        reasoningEffort: "high",
      });
      await classifier({ content: "?" });
      expect(fake.calls[0]?.options).toMatchObject({ reasoningEffort: "high" });
      void factoryBuilder;
    });

    it("createScorer forwards reasoningEffort", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const score = createScorer({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
        rubric: "r",
        reasoningEffort: "medium",
      });
      await score({ content: "?" });
      expect(fake.calls[0]?.options).toMatchObject({ reasoningEffort: "medium" });
    });

    it("createExtractor forwards reasoningEffort", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const extract = createExtractor({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
        reasoningEffort: "low",
      });
      await extract({ content: "?" });
      expect(fake.calls[0]?.options).toMatchObject({ reasoningEffort: "low" });
    });

    it("createPlanner forwards reasoningEffort", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const plan = createPlanner({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
        reasoningEffort: "high",
      });
      await plan({ goal: "?" });
      expect(fake.calls[0]?.options).toMatchObject({ reasoningEffort: "high" });
    });

    it("createAnalyzer forwards reasoningEffort", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const analyze = createAnalyzer({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
        framework: "SWOT",
        reasoningEffort: "high",
      });
      await analyze({ content: "?" });
      expect(fake.calls[0]?.options).toMatchObject({ reasoningEffort: "high" });
    });

    it("createDrafter forwards reasoningEffort", async () => {
      const fake = createFakePort();
      fake.enqueueText("ok");
      const draft = createDrafter({
        port: fake.port,
        persona: "neutral",
        reasoningEffort: "low",
      });
      await draft({ instructions: "?" });
      expect(fake.calls[0]?.options).toMatchObject({ reasoningEffort: "low" });
    });

    it("createSummarizer forwards reasoningEffort", async () => {
      const fake = createFakePort();
      fake.enqueueText("ok");
      const summarize = createSummarizer({
        port: fake.port,
        reasoningEffort: "medium",
      });
      await summarize({ content: "?" });
      expect(fake.calls[0]?.options).toMatchObject({ reasoningEffort: "medium" });
    });

    it("reasoningEffort is omitted from the SDK call when not configured", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const classifier = createClassifier({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
      });
      await classifier({ content: "?" });
      const call = fake.calls[0]?.options as Record<string, unknown>;
      expect("reasoningEffort" in call).toBe(false);
    });
  });

  describe("signal + forceProviderAlias (per-call)", () => {
    it("createClassifier forwards signal + forceProviderAlias from the input arg", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const classifier = createClassifier({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
      });
      const controller = new AbortController();
      await classifier({
        content: "?",
        signal: controller.signal,
        forceProviderAlias: "smart",
      });
      expect(fake.calls[0]?.options).toMatchObject({
        signal: controller.signal,
        forceProviderAlias: "smart",
      });
    });

    it("createScorer forwards per-call signal + forceProviderAlias", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const score = createScorer({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
        rubric: "r",
      });
      const controller = new AbortController();
      await score({
        content: "?",
        signal: controller.signal,
        forceProviderAlias: "expensive",
      });
      expect(fake.calls[0]?.options).toMatchObject({
        signal: controller.signal,
        forceProviderAlias: "expensive",
      });
    });

    it("createDrafter forwards per-call signal + forceProviderAlias (generateText path)", async () => {
      const fake = createFakePort();
      fake.enqueueText("ok");
      const draft = createDrafter({
        port: fake.port,
        persona: "neutral",
      });
      const controller = new AbortController();
      await draft({
        instructions: "?",
        signal: controller.signal,
        forceProviderAlias: "creative",
      });
      expect(fake.calls[0]?.options).toMatchObject({
        signal: controller.signal,
        forceProviderAlias: "creative",
      });
    });

    it("per-call options are omitted when not supplied", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const classifier = createClassifier({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
      });
      await classifier({ content: "?" });
      const call = fake.calls[0]?.options as Record<string, unknown>;
      expect("signal" in call).toBe(false);
      expect("forceProviderAlias" in call).toBe(false);
    });
  });

  describe("providerExtras (per-call, alpha.16)", () => {
    const VLLM_THINKING = { chat_template_kwargs: { enable_thinking: true } };

    it("createClassifier forwards providerExtras from the input arg", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const classifier = createClassifier({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
      });
      await classifier({ content: "?", providerExtras: VLLM_THINKING });
      expect(fake.calls[0]?.options).toMatchObject({ providerExtras: VLLM_THINKING });
    });

    it("createScorer forwards providerExtras", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const score = createScorer({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
        rubric: "r",
      });
      await score({ content: "?", providerExtras: { regex: "[0-9]+" } });
      expect(fake.calls[0]?.options).toMatchObject({
        providerExtras: { regex: "[0-9]+" },
      });
    });

    it("createExtractor forwards providerExtras", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const extract = createExtractor({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
      });
      await extract({ content: "?", providerExtras: VLLM_THINKING });
      expect(fake.calls[0]?.options).toMatchObject({ providerExtras: VLLM_THINKING });
    });

    it("createPlanner forwards providerExtras", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const plan = createPlanner({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
      });
      await plan({ goal: "?", providerExtras: VLLM_THINKING });
      expect(fake.calls[0]?.options).toMatchObject({ providerExtras: VLLM_THINKING });
    });

    it("createAnalyzer forwards providerExtras", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const analyze = createAnalyzer({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
        framework: "SWOT",
      });
      await analyze({ content: "?", providerExtras: VLLM_THINKING });
      expect(fake.calls[0]?.options).toMatchObject({ providerExtras: VLLM_THINKING });
    });

    it("createDrafter forwards providerExtras (generateText path)", async () => {
      const fake = createFakePort();
      fake.enqueueText("ok");
      const draft = createDrafter({
        port: fake.port,
        persona: "neutral",
      });
      await draft({ instructions: "?", providerExtras: { repetition_penalty: 1.1 } });
      expect(fake.calls[0]?.options).toMatchObject({
        providerExtras: { repetition_penalty: 1.1 },
      });
    });

    it("createSummarizer forwards providerExtras (generateText path)", async () => {
      const fake = createFakePort();
      fake.enqueueText("ok");
      const summarize = createSummarizer({
        port: fake.port,
      });
      await summarize({ content: "?", providerExtras: VLLM_THINKING });
      expect(fake.calls[0]?.options).toMatchObject({ providerExtras: VLLM_THINKING });
    });

    it("providerExtras is omitted when not supplied on the call", async () => {
      const fake = createFakePort();
      fake.enqueueStructured({ ok: true });
      const classifier = createClassifier({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
      });
      await classifier({ content: "?" });
      const call = fake.calls[0]?.options as Record<string, unknown>;
      expect("providerExtras" in call).toBe(false);
    });
  });
});
