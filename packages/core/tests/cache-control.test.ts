/**
 * CacheControl shape lock + cacheSavingsUSD rename — alpha.19.
 *
 * These tests verify the public surface of the locked CacheControl
 * shape and the renamed cost field. Per-adapter behavior tests for
 * each mode (auto / manual / preCreated / off) ship in beta.x as
 * adapters wire each mode end-to-end.
 */

import { describe, it, expect } from "vitest";
import type {
  CacheControl,
  GenerateStructuredOptions,
  GenerateTextOptions,
  RunAgentOptions,
  StreamStructuredOptions,
  StreamTextOptions,
} from "../src/index.js";
import { computeChatCost } from "../src/index.js";
import { z } from "zod";

describe("CacheControl shape (alpha.19 lock)", () => {
  it("accepts all four modes as literal values", () => {
    const auto: CacheControl = { mode: "auto" };
    const manual: CacheControl = { mode: "manual" };
    const preCreated: CacheControl = { mode: "preCreated" };
    const off: CacheControl = { mode: "off" };
    expect(auto.mode).toBe("auto");
    expect(manual.mode).toBe("manual");
    expect(preCreated.mode).toBe("preCreated");
    expect(off.mode).toBe("off");
  });

  it("carries TTL, breakpoints, handle, and namespace as optional fields", () => {
    const full: CacheControl = {
      mode: "manual",
      ttlSeconds: 3600,
      breakpoints: [
        { at: "tools" },
        { at: "system" },
        { at: "message-index", index: 4 },
      ],
      cachedContentHandle: "cached-content-handle-xyz",
      namespace: "tenant:acme-corp",
    };
    expect(full.ttlSeconds).toBe(3600);
    expect(full.breakpoints).toHaveLength(3);
    expect(full.cachedContentHandle).toBe("cached-content-handle-xyz");
    expect(full.namespace).toBe("tenant:acme-corp");
  });

  it("breakpoints support all three section discriminators", () => {
    const cc: CacheControl = {
      mode: "manual",
      breakpoints: [
        { at: "tools" },
        { at: "system" },
        { at: "message-index", index: 0 },
        { at: "message-index", index: 5 },
      ],
    };
    expect(cc.breakpoints?.map((b) => b.at)).toEqual([
      "tools",
      "system",
      "message-index",
      "message-index",
    ]);
  });
});

describe("CacheControl is accepted on all 5 request option types (alpha.19)", () => {
  const baseCC: CacheControl = { mode: "auto", ttlSeconds: 300 };

  it("GenerateTextOptions carries cacheControl", () => {
    const opts: GenerateTextOptions = {
      taskType: "triage",
      prompt: "hello",
      cacheControl: baseCC,
    };
    expect(opts.cacheControl?.mode).toBe("auto");
  });

  it("GenerateStructuredOptions carries cacheControl", () => {
    const opts: GenerateStructuredOptions<{ ok: boolean }> = {
      taskType: "score",
      prompt: "hello",
      schema: z.object({ ok: z.boolean() }),
      cacheControl: baseCC,
    };
    expect(opts.cacheControl?.mode).toBe("auto");
  });

  it("StreamTextOptions carries cacheControl", () => {
    const opts: StreamTextOptions = {
      taskType: "draft",
      prompt: "hello",
      cacheControl: baseCC,
    };
    expect(opts.cacheControl?.mode).toBe("auto");
  });

  it("StreamStructuredOptions carries cacheControl", () => {
    const opts: StreamStructuredOptions<{ ok: boolean }> = {
      taskType: "draft",
      prompt: "hello",
      schema: z.object({ ok: z.boolean() }),
      cacheControl: baseCC,
    };
    expect(opts.cacheControl?.mode).toBe("auto");
  });

  it("RunAgentOptions carries cacheControl", () => {
    const opts: RunAgentOptions = {
      taskType: "agent",
      instructions: "do the thing",
      messages: [],
      tools: {},
      cacheControl: baseCC,
    };
    expect(opts.cacheControl?.mode).toBe("auto");
  });
});

describe("cost.cacheSavingsUSD rename (alpha.19 BREAKING)", () => {
  const PRICING = {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
  };

  it("populates cacheSavingsUSD when cache reads are present", () => {
    const cost = computeChatCost(
      {
        inputTokens: 100_000,
        outputTokens: 1000,
        totalTokens: 101_000,
        cacheReadTokens: 80_000,
      },
      PRICING,
    );
    // 80k cache reads at $0.30 instead of $3.00 = saves (3.0 - 0.3) * 0.08 = $0.216
    expect(cost.cacheSavingsUSD).toBeCloseTo(0.216, 6);
  });

  it("omits cacheSavingsUSD when no cache reads occurred", () => {
    const cost = computeChatCost(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      PRICING,
    );
    expect(cost.cacheSavingsUSD).toBeUndefined();
  });

  it("does not emit the legacy cacheDiscountUSD field", () => {
    const cost = computeChatCost(
      {
        inputTokens: 1000,
        outputTokens: 100,
        totalTokens: 1100,
        cacheReadTokens: 500,
      },
      PRICING,
    );
    // alpha.19 BREAKING: the old field name no longer exists.
    expect((cost as Record<string, unknown>).cacheDiscountUSD).toBeUndefined();
    expect(cost.cacheSavingsUSD).toBeDefined();
  });
});
