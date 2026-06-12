/**
 * Capability factories (alpha.19.1) now thread `cacheControl` from the per-call
 * input to the underlying `port.generateStructured` / `port.generateText` call.
 *
 * Coverage: all 7 published factories — createClassifier, createScorer,
 * createExtractor, createAnalyzer, createPlanner, createDrafter,
 * createSummarizer. Each test confirms that `input.cacheControl` lands on
 * the recorded port-call options unchanged.
 *
 * Plus: when the port returns `cost.cacheSavingsUSD`, the `onResult` event
 * propagates it. Tested on createClassifier (which destructures cost into
 * individual fields) and createSummarizer (which forwards the whole cost
 * object); the other factories follow one of these two patterns.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CacheControl } from "@llm-ports/core";
import {
  createAnalyzer,
  createClassifier,
  createDrafter,
  createExtractor,
  createPlanner,
  createScorer,
  createSummarizer,
} from "../src/index.js";
import { createFakePort } from "./helpers/fake-port.js";

const TrivialSchema = z.object({ ok: z.boolean() });
const TrivialPayload = { ok: true };

const SAMPLE: CacheControl = {
  mode: "manual",
  ttlSeconds: 3600,
  breakpoints: [{ at: "system" }, { at: "tools" }],
  namespace: "tenant:acme",
};

describe("cacheControl passthrough — alpha.19.1", () => {
  describe("structured-output factories forward cacheControl to generateStructured", () => {
    it("createClassifier", async () => {
      const fake = createFakePort();
      fake.enqueueStructured(TrivialPayload);
      const classify = createClassifier({ port: fake.port, schema: TrivialSchema, schemaName: "x" });
      await classify({ content: "?", cacheControl: SAMPLE });
      expect(fake.calls[0]?.options).toMatchObject({ cacheControl: SAMPLE });
    });

    it("createScorer", async () => {
      const fake = createFakePort();
      fake.enqueueStructured(TrivialPayload);
      const score = createScorer({ port: fake.port, schema: TrivialSchema, schemaName: "x", rubric: "r" });
      await score({ content: "?", cacheControl: SAMPLE });
      expect(fake.calls[0]?.options).toMatchObject({ cacheControl: SAMPLE });
    });

    it("createExtractor", async () => {
      const fake = createFakePort();
      fake.enqueueStructured(TrivialPayload);
      const extract = createExtractor({ port: fake.port, schema: TrivialSchema, schemaName: "x" });
      await extract({ content: "?", cacheControl: SAMPLE });
      expect(fake.calls[0]?.options).toMatchObject({ cacheControl: SAMPLE });
    });

    it("createAnalyzer", async () => {
      const fake = createFakePort();
      fake.enqueueStructured(TrivialPayload);
      const analyze = createAnalyzer({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
        framework: "SWOT",
      });
      await analyze({ content: "?", cacheControl: SAMPLE });
      expect(fake.calls[0]?.options).toMatchObject({ cacheControl: SAMPLE });
    });

    it("createPlanner", async () => {
      const fake = createFakePort();
      fake.enqueueStructured(TrivialPayload);
      const plan = createPlanner({ port: fake.port, schema: TrivialSchema, schemaName: "x" });
      await plan({ goal: "achieve x", cacheControl: SAMPLE });
      expect(fake.calls[0]?.options).toMatchObject({ cacheControl: SAMPLE });
    });
  });

  describe("text-output factories forward cacheControl to generateText", () => {
    it("createDrafter", async () => {
      const fake = createFakePort();
      fake.enqueueText("drafted");
      const draft = createDrafter({ port: fake.port, persona: "concise tester" });
      await draft({ instructions: "say hi", cacheControl: SAMPLE });
      expect(fake.calls[0]?.options).toMatchObject({ cacheControl: SAMPLE });
    });

    it("createSummarizer", async () => {
      const fake = createFakePort();
      fake.enqueueText("summary");
      const summarize = createSummarizer({ port: fake.port });
      await summarize({ content: "long content", cacheControl: SAMPLE });
      expect(fake.calls[0]?.options).toMatchObject({ cacheControl: SAMPLE });
    });
  });

  describe("omitting cacheControl forwards no field", () => {
    it("createClassifier", async () => {
      const fake = createFakePort();
      fake.enqueueStructured(TrivialPayload);
      const classify = createClassifier({ port: fake.port, schema: TrivialSchema, schemaName: "x" });
      await classify({ content: "?" });
      expect((fake.calls[0]?.options as { cacheControl?: unknown }).cacheControl).toBeUndefined();
    });
  });

  describe("onResult event propagates cacheSavingsUSD", () => {
    it("createClassifier (destructured cost shape)", async () => {
      const fake = createFakePort();
      fake.enqueueStructured(TrivialPayload, { cost: { cacheSavingsUSD: 0.0042 } });
      const onResult = vi.fn();
      const classify = createClassifier({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
        onResult,
      });
      await classify({ content: "?" });
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult.mock.calls[0][0].cost.cacheSavingsUSD).toBeCloseTo(0.0042, 6);
    });

    it("createSummarizer (whole-cost forward shape)", async () => {
      const fake = createFakePort();
      fake.enqueueText("summary", { cost: { cacheSavingsUSD: 0.0099 } });
      const onResult = vi.fn();
      const summarize = createSummarizer({ port: fake.port, onResult });
      await summarize({ content: "?" });
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult.mock.calls[0][0].cost.cacheSavingsUSD).toBeCloseTo(0.0099, 6);
    });

    it("onResult event omits cacheSavingsUSD when not populated", async () => {
      const fake = createFakePort();
      fake.enqueueStructured(TrivialPayload);
      const onResult = vi.fn();
      const classify = createClassifier({
        port: fake.port,
        schema: TrivialSchema,
        schemaName: "x",
        onResult,
      });
      await classify({ content: "?" });
      expect(onResult.mock.calls[0][0].cost.cacheSavingsUSD).toBeUndefined();
    });
  });
});
