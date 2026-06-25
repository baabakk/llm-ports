/**
 * Behavioral model fingerprinting (alpha.24+).
 *
 * The catalog architectural redesign: drop static-catalog dependence as the
 * load-bearing correctness mechanism. Runtime detection (alpha.22) is the
 * universal correctness path; behavioral fingerprinting is the optimization
 * that skips the first-call discovery penalty.
 *
 * Three CoT field conventions exist across the OpenAI-compat ecosystem
 * (see docs/research/reasoning-models-survey-2026-06.md):
 *   - `message.reasoning` — Cerebras, Groq, SambaNova
 *   - `message.reasoning_content` — DeepInfra, Parasail (vLLM substrate)
 *   - `usage.completion_tokens_details.reasoning_tokens` — OpenAI native
 *   - inline `<think>...</think>` — legacy R1 distills
 *
 * The fingerprint analyzer detects all four shapes from existing in-flight
 * responses — no extra probe call needed when the model already produced a
 * response we can read.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFingerprintKey,
  FileFingerprintCache,
  InMemoryFingerprintCache,
  inspectResponseForFingerprint,
  type ModelFingerprint,
} from "../../src/fingerprint.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import {
  buildOpenAIChatResponse,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { createOpenAIAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("inspectResponseForFingerprint", () => {
  it("detects OpenAI-native reasoning via usage.completion_tokens_details.reasoning_tokens", () => {
    const shape = inspectResponseForFingerprint({
      choices: [{ message: { content: "ok" } }],
      usage: { completion_tokens_details: { reasoning_tokens: 42 } },
    });
    expect(shape.reasoningModel).toBe(true);
    expect(shape.reasoningField).toBe("reasoning_tokens");
  });

  it("detects vLLM-style reasoning via message.reasoning_content", () => {
    const shape = inspectResponseForFingerprint({
      choices: [{ message: { content: "ok", reasoning_content: "thinking" } }],
    });
    expect(shape.reasoningModel).toBe(true);
    expect(shape.reasoningField).toBe("reasoning_content");
  });

  it("detects Cerebras-style reasoning via message.reasoning", () => {
    const shape = inspectResponseForFingerprint({
      choices: [{ message: { content: "ok", reasoning: "thinking" } }],
    });
    expect(shape.reasoningModel).toBe(true);
    expect(shape.reasoningField).toBe("reasoning");
  });

  it("detects inline-think via <think>...</think> in content", () => {
    const shape = inspectResponseForFingerprint({
      choices: [{ message: { content: "<think>I'm thinking</think>The answer is 4." } }],
    });
    expect(shape.reasoningModel).toBe(true);
    expect(shape.reasoningField).toBe("inline-think");
  });

  it("returns reasoningModel: false for non-reasoning responses", () => {
    const shape = inspectResponseForFingerprint({
      choices: [{ message: { content: "4" } }],
      usage: { completion_tokens_details: { reasoning_tokens: 0 } },
    });
    expect(shape.reasoningModel).toBe(false);
    expect(shape.reasoningField).toBeUndefined();
  });

  it("handles null/undefined gracefully (no crash)", () => {
    expect(inspectResponseForFingerprint(null)).toEqual({ reasoningModel: false });
    expect(inspectResponseForFingerprint(undefined)).toEqual({ reasoningModel: false });
    expect(inspectResponseForFingerprint("not an object")).toEqual({ reasoningModel: false });
  });

  it("priority: reasoning_tokens beats reasoning_content beats reasoning (when multiple present)", () => {
    const shape = inspectResponseForFingerprint({
      choices: [
        {
          message: { content: "ok", reasoning: "cerebras", reasoning_content: "vllm" },
        },
      ],
      usage: { completion_tokens_details: { reasoning_tokens: 10 } },
    });
    // Highest priority: usage-level reasoning_tokens
    expect(shape.reasoningField).toBe("reasoning_tokens");
  });
});

describe("buildFingerprintKey", () => {
  it("uses 'openai-native' sentinel when baseURL is undefined", () => {
    expect(buildFingerprintKey(undefined, "gpt-5")).toBe("openai-native::gpt-5");
  });

  it("strips trailing slashes from baseURL", () => {
    expect(buildFingerprintKey("https://api.cerebras.ai/v1/", "gpt-oss-120b")).toBe(
      "https://api.cerebras.ai/v1::gpt-oss-120b",
    );
    expect(buildFingerprintKey("https://api.cerebras.ai/v1///", "gpt-oss-120b")).toBe(
      "https://api.cerebras.ai/v1::gpt-oss-120b",
    );
  });

  it("normalizes modelId (strips namespace prefix)", () => {
    expect(
      buildFingerprintKey("https://api.deepinfra.com/v1/openai", "openai/gpt-oss-120b"),
    ).toBe("https://api.deepinfra.com/v1/openai::gpt-oss-120b");
    expect(
      buildFingerprintKey("https://api.parasail.io/v1", "XiaomiMiMo/MiMo-V2.5"),
    ).toBe("https://api.parasail.io/v1::MiMo-V2.5");
  });

  it("produces distinct keys for same canonical model across providers", () => {
    // Cerebras gpt-oss-120b vs DeepInfra openai/gpt-oss-120b — same weights,
    // different serving, different fingerprint expected.
    const cerebras = buildFingerprintKey("https://api.cerebras.ai/v1", "gpt-oss-120b");
    const deepinfra = buildFingerprintKey(
      "https://api.deepinfra.com/v1/openai",
      "openai/gpt-oss-120b",
    );
    expect(cerebras).not.toBe(deepinfra);
  });
});

describe("InMemoryFingerprintCache", () => {
  it("returns null for missing entries", () => {
    const cache = new InMemoryFingerprintCache();
    expect(cache.get("missing")).toBeNull();
  });

  it("stores and retrieves entries", () => {
    const cache = new InMemoryFingerprintCache();
    const fp: ModelFingerprint = {
      modelId: "gpt-oss-120b",
      baseURL: "https://api.cerebras.ai/v1",
      reasoningModel: true,
      reasoningField: "reasoning",
      fingerprintedAt: "2026-06-24T18:00:00.000Z",
      schemaVersion: 1,
    };
    cache.set("key1", fp);
    expect(cache.get("key1")).toEqual(fp);
  });

  it("delete removes entries", () => {
    const cache = new InMemoryFingerprintCache();
    cache.set("key1", {
      modelId: "x",
      baseURL: "y",
      reasoningModel: false,
      fingerprintedAt: "now",
      schemaVersion: 1,
    });
    cache.delete("key1");
    expect(cache.get("key1")).toBeNull();
  });
});

describe("FileFingerprintCache", () => {
  let tmpPath: string;

  beforeEach(async () => {
    tmpPath = join(tmpdir(), `fingerprint-test-${Date.now()}-${Math.random()}.json`);
  });

  afterEach(async () => {
    await fs.unlink(tmpPath).catch(() => {/* may not exist */});
  });

  it("returns null when the file doesn't exist (first run)", async () => {
    const cache = new FileFingerprintCache(tmpPath);
    expect(await cache.get("missing")).toBeNull();
  });

  it("persists writes across instances", async () => {
    const fp: ModelFingerprint = {
      modelId: "MiMo-V2.5",
      baseURL: "https://api.parasail.io/v1",
      reasoningModel: true,
      reasoningField: "reasoning_content",
      fingerprintedAt: "2026-06-24T18:00:00.000Z",
      schemaVersion: 1,
    };

    const writer = new FileFingerprintCache(tmpPath);
    await writer.set("k1", fp);

    const reader = new FileFingerprintCache(tmpPath);
    const read = await reader.get("k1");
    expect(read).toEqual(fp);
  });

  it("survives malformed JSON gracefully (treats as empty)", async () => {
    await fs.writeFile(tmpPath, "{this is not valid JSON", "utf8");
    const cache = new FileFingerprintCache(tmpPath);
    expect(await cache.get("anything")).toBeNull();
    // Writing should overwrite the malformed file with valid JSON.
    await cache.set("k1", {
      modelId: "x",
      baseURL: "y",
      reasoningModel: false,
      fingerprintedAt: "now",
      schemaVersion: 1,
    });
    const persisted = JSON.parse(await fs.readFile(tmpPath, "utf8"));
    expect(persisted.k1).toBeDefined();
  });

  it("invalidates entries with mismatched schemaVersion", async () => {
    // Write a fake-old-schema entry directly.
    await fs.writeFile(
      tmpPath,
      JSON.stringify({
        oldEntry: {
          modelId: "x",
          baseURL: "y",
          reasoningModel: true,
          fingerprintedAt: "ancient",
          schemaVersion: 999, // mismatched
        },
      }),
      "utf8",
    );
    const cache = new FileFingerprintCache(tmpPath);
    expect(await cache.get("oldEntry")).toBeNull();
  });

  it("delete removes entries", async () => {
    const cache = new FileFingerprintCache(tmpPath);
    await cache.set("k1", {
      modelId: "x",
      baseURL: "y",
      reasoningModel: true,
      fingerprintedAt: "now",
      schemaVersion: 1,
    });
    await cache.delete("k1");
    expect(await cache.get("k1")).toBeNull();
  });

  it("creates parent directory on first write", async () => {
    const nestedPath = join(tmpdir(), `fingerprint-nested-${Date.now()}`, "subdir", "fp.json");
    const cache = new FileFingerprintCache(nestedPath);
    await cache.set("k1", {
      modelId: "x",
      baseURL: "y",
      reasoningModel: false,
      fingerprintedAt: "now",
      schemaVersion: 1,
    });
    const exists = await fs
      .access(nestedPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
    // Cleanup
    await fs.unlink(nestedPath).catch(() => {});
    await fs.rmdir(join(tmpdir(), `fingerprint-nested-${Date.now()}`, "subdir")).catch(() => {});
  });
});

describe("Adapter integration: fingerprint cache writes on successful responses", () => {
  it("writes a fingerprint to the cache when a reasoning response is observed", async () => {
    const cache = new InMemoryFingerprintCache();
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.deepinfra.com/v1/openai",
      pricingOverrides: {
        "openai/gpt-oss-120b": { inputPer1M: 0.04, outputPer1M: 0.19 },
      },
      fingerprintCache: cache,
    });
    const port = adapter.createLLMPort("openai/gpt-oss-120b", "deepinfra");

    // Response with reasoning_content populated (vLLM-style)
    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: "openai/gpt-oss-120b",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "4",
            reasoning_content: "2+2 is 4, computed by adding...",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });

    await port.generateText({ taskType: "test", prompt: "What is 2+2?" });

    // Fingerprint write is fire-and-forget; await a microtask tick to let
    // the promise resolve.
    await new Promise((resolve) => setImmediate(resolve));

    const key = buildFingerprintKey(
      "https://api.deepinfra.com/v1/openai",
      "openai/gpt-oss-120b",
    );
    const cached = cache.get(key);
    expect(cached).not.toBeNull();
    expect(cached!.reasoningModel).toBe(true);
    expect(cached!.reasoningField).toBe("reasoning_content");
    expect(cached!.modelId).toBe("gpt-oss-120b"); // normalized
    expect(cached!.baseURL).toBe("https://api.deepinfra.com/v1/openai");
  });

  it("does NOT cache a non-reasoning response (might be wrong-shaped probe)", async () => {
    const cache = new InMemoryFingerprintCache();
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 } },
      fingerprintCache: cache,
    });
    const port = adapter.createLLMPort("gpt-4o-mini", "openai");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 10,
        completionTokens: 2,
      }),
    );

    await port.generateText({ taskType: "test", prompt: "say ok" });
    await new Promise((resolve) => setImmediate(resolve));

    // Negative observations aren't cached — could be a non-reasoning prompt
    // to a reasoning model (e.g., gpt-oss-120b at reasoning_effort=none).
    expect(cache._snapshot().size).toBe(0);
  });

  it("seeds the learner from a cached fingerprint on port creation", async () => {
    const cache = new InMemoryFingerprintCache();
    // Pre-populate the cache as if from a prior run / warm-start.
    const key = buildFingerprintKey(
      "https://api.parasail.io/v1",
      "XiaomiMiMo/MiMo-V2.5",
    );
    cache.set(key, {
      modelId: "MiMo-V2.5",
      baseURL: "https://api.parasail.io/v1",
      reasoningModel: true,
      reasoningField: "reasoning_content",
      fingerprintedAt: "2026-06-24T17:00:00.000Z",
      schemaVersion: 1,
    });

    const adapter = createOpenAIAdapter({
      apiKey: "test",
      baseURL: "https://api.parasail.io/v1",
      pricingOverrides: {
        "XiaomiMiMo/MiMo-V2.5": { inputPer1M: 0.14, outputPer1M: 0.28 },
      },
      fingerprintCache: cache,
    });
    adapter.createLLMPort("XiaomiMiMo/MiMo-V2.5", "parasail");

    // Let the async cache read settle.
    await new Promise((resolve) => setImmediate(resolve));

    // The learner should now know this model is a reasoning model — verify
    // by checking capability lookup (canonical name).
    const { getEffectiveCapabilities } = await import("../../src/capabilities.js");
    expect(getEffectiveCapabilities("XiaomiMiMo/MiMo-V2.5", undefined).reasoningModel).toBe(
      true,
    );
  });

  it("works without a fingerprintCache option (backwards compat)", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: { "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 } },
      // fingerprintCache intentionally omitted
    });
    const port = adapter.createLLMPort("gpt-4o-mini", "openai");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 10,
        completionTokens: 2,
      }),
    );

    const result = await port.generateText({ taskType: "test", prompt: "say ok" });
    expect(result.text).toBe("ok");
  });

  it("swallows cache backend errors (correctness preserved when cache misbehaves)", async () => {
    // Backend that throws on every operation.
    const failingCache = {
      get: () => Promise.reject(new Error("backend down")),
      set: () => Promise.reject(new Error("backend down")),
    };
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      pricingOverrides: {
        "openai/gpt-oss-120b": { inputPer1M: 0.04, outputPer1M: 0.19 },
      },
      fingerprintCache: failingCache,
    });
    const port = adapter.createLLMPort("openai/gpt-oss-120b", "deepinfra");

    mockChatCompletionsCreate.mockResolvedValueOnce({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: "openai/gpt-oss-120b",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "4", reasoning_content: "..." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    // Should NOT throw — cache errors are swallowed.
    const result = await port.generateText({ taskType: "test", prompt: "what's 2+2?" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.text).toBe("4");
  });
});
