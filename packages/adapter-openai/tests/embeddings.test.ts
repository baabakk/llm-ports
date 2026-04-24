/**
 * Unit tests for the OpenAI EmbeddingsPort. Not part of the LLMPort contract
 * suite (which only covers chat operations).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildOpenAIEmbeddingResponse,
  mockEmbeddingsCreate,
  resetMocks,
} from "./helpers/mock-sdk.js";
import { createOpenAIAdapter } from "../src/index.js";

const MODEL_ID = "text-embedding-3-small";
const ALIAS = "test-openai-embed";

beforeEach(() => {
  resetMocks();
});

describe("EmbeddingsPort", () => {
  it("generateEmbedding returns vector + usage + cost", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test-key" });
    const port = adapter.createEmbeddingsPort(MODEL_ID, ALIAS);

    const fakeVector = Array.from({ length: 1536 }, (_, i) => i / 1536);
    mockEmbeddingsCreate.mockResolvedValueOnce(
      buildOpenAIEmbeddingResponse({
        vector: fakeVector,
        promptTokens: 25,
        modelId: MODEL_ID,
      }),
    );

    const result = await port.generateEmbedding({
      taskType: "test",
      input: "hello world",
    });

    expect(result.vector).toHaveLength(1536);
    expect(result.dimensions).toBe(1536);
    expect(result.usage.inputTokens).toBe(25);
    expect(result.cost.totalUSD).toBeGreaterThan(0);
    expect(result.modelId).toBe(MODEL_ID);
    expect(result.providerAlias).toBe(ALIAS);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("generateEmbeddings (batch) returns matching vectors", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test-key" });
    const port = adapter.createEmbeddingsPort(MODEL_ID, ALIAS);

    // Mock returns one vector here for simplicity; the SDK shape supports many.
    mockEmbeddingsCreate.mockResolvedValueOnce({
      object: "list" as const,
      model: MODEL_ID,
      data: [
        { object: "embedding" as const, embedding: [0.1, 0.2], index: 0 },
        { object: "embedding" as const, embedding: [0.3, 0.4], index: 1 },
      ],
      usage: { prompt_tokens: 50, total_tokens: 50 },
    });

    const result = await port.generateEmbeddings({
      taskType: "test-batch",
      inputs: ["hello", "world"],
    });

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toEqual([0.1, 0.2]);
    expect(result.dimensions).toBe(2);
    expect(result.usage.inputTokens).toBe(50);
  });
});
