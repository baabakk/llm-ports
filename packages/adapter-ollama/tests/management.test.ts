/**
 * Adapter-level ModelManagement methods (list/pull/delete/health).
 * Not part of the LLMPort contract.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildOllamaEmbedResponse,
  mockDelete,
  mockEmbed,
  mockList,
  mockPull,
  resetMocks,
} from "./helpers/mock-sdk.js";
import { createOllamaAdapter } from "../src/index.js";

beforeEach(() => {
  resetMocks();
});

describe("ModelManagement", () => {
  it("listModels normalizes Ollama API shape", async () => {
    mockList.mockResolvedValueOnce({
      models: [
        {
          name: "llama3.3",
          size: 4_000_000_000,
          modified_at: "2026-04-10T12:00:00Z",
          digest: "abc123",
          details: {
            family: "llama",
            parameter_size: "8B",
            quantization_level: "Q4_K_M",
          },
        },
      ],
    });
    const adapter = createOllamaAdapter();
    const models = await adapter.listModels();
    expect(models).toEqual([
      {
        name: "llama3.3",
        size: 4_000_000_000,
        modifiedAt: "2026-04-10T12:00:00Z",
        digest: "abc123",
        family: "llama",
        parameterSize: "8B",
        quantizationLevel: "Q4_K_M",
      },
    ]);
  });

  it("pullModel streams progress and forwards percentages", async () => {
    mockPull.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        yield { total: 100, completed: 25 };
        yield { total: 100, completed: 75 };
        yield { total: 100, completed: 100 };
      },
    });
    const adapter = createOllamaAdapter();
    const pcts: number[] = [];
    await adapter.pullModel("llama3.3", (pct) => pcts.push(pct));
    expect(pcts).toEqual([25, 75, 100]);
  });

  it("deleteModel forwards to the SDK", async () => {
    mockDelete.mockResolvedValueOnce(undefined);
    const adapter = createOllamaAdapter();
    await adapter.deleteModel("llama3.3");
    expect(mockDelete).toHaveBeenCalledWith({ model: "llama3.3" });
  });

  it("checkHealth returns ok=true on successful list", async () => {
    mockList.mockResolvedValueOnce({ models: [] });
    const adapter = createOllamaAdapter();
    const health = await adapter.checkHealth();
    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("checkHealth returns ok=false when the daemon is unreachable", async () => {
    mockList.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const adapter = createOllamaAdapter();
    const health = await adapter.checkHealth();
    expect(health.ok).toBe(false);
  });
});

describe("EmbeddingsPort", () => {
  it("generateEmbedding returns vector + cost (zero by default)", async () => {
    const fakeVector = Array.from({ length: 384 }, (_, i) => i / 384);
    mockEmbed.mockResolvedValueOnce(
      buildOllamaEmbedResponse({ vectors: [fakeVector], modelId: "nomic-embed-text" }),
    );
    const adapter = createOllamaAdapter();
    const port = adapter.createEmbeddingsPort("nomic-embed-text", "test-embed");
    const result = await port.generateEmbedding({ taskType: "test", input: "hi" });
    expect(result.dimensions).toBe(384);
    expect(result.vector).toHaveLength(384);
    // Local models default to zero-cost
    expect(result.cost.totalUSD).toBe(0);
  });

  it("generateEmbeddings (batch) returns matching vectors", async () => {
    mockEmbed.mockResolvedValueOnce(
      buildOllamaEmbedResponse({
        vectors: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
      }),
    );
    const adapter = createOllamaAdapter();
    const port = adapter.createEmbeddingsPort("nomic-embed-text", "test-embed");
    const result = await port.generateEmbeddings({
      taskType: "test-batch",
      inputs: ["hello", "world"],
    });
    expect(result.vectors).toHaveLength(2);
    expect(result.dimensions).toBe(3);
  });
});
