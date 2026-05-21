/**
 * Adapter conformance: openai must satisfy the shared LLMPort contract.
 * Mock the openai SDK module via vi.mock so no real HTTP is performed.
 */

import { runContractTests } from "@llm-ports/adapter-contract-tests";
import { beforeEach } from "vitest";
import {
  buildOpenAIChatResponse,
  buildOpenAIChatStream,
  mockChatCompletionsCreate,
  mockEmbeddingsCreate,
  resetMocks,
} from "./helpers/mock-sdk.js";
import { createOpenAIAdapter } from "../src/index.js";

const MODEL_ID = "gpt-5-mini";
const ALIAS = "test-openai";

beforeEach(() => {
  resetMocks();
  // Most tests don't touch embeddings; reset prevents bleed-through.
  void mockEmbeddingsCreate;
});

runContractTests("openai", () => {
  const adapter = createOpenAIAdapter({ apiKey: "test-key" });
  const port = adapter.createLLMPort(MODEL_ID, ALIAS);

  return {
    port,
    expectedAlias: ALIAS,
    expectedModelId: MODEL_ID,
    imageContentSupport: "base64+url",

    setupGenerateText(response) {
      mockChatCompletionsCreate.mockResolvedValueOnce(
        buildOpenAIChatResponse({
          text: response.text,
          promptTokens: response.usage.inputTokens,
          completionTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
        }),
      );
    },

    setupGenerateStructured(response) {
      if (response.invalidFirstAttempt !== undefined) {
        mockChatCompletionsCreate.mockResolvedValueOnce(
          buildOpenAIChatResponse({
            text: JSON.stringify(response.invalidFirstAttempt),
            promptTokens: Math.floor(response.usage.inputTokens / 2),
            completionTokens: Math.floor(response.usage.outputTokens / 2),
            modelId: response.modelId ?? MODEL_ID,
          }),
        );
      }
      mockChatCompletionsCreate.mockResolvedValueOnce(
        buildOpenAIChatResponse({
          text: JSON.stringify(response.data),
          promptTokens: response.usage.inputTokens,
          completionTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
        }),
      );
    },

    setupStreamText(response) {
      mockChatCompletionsCreate.mockResolvedValueOnce(
        buildOpenAIChatStream(response.chunks),
      );
    },

    setupStreamStructured(response) {
      // Final partial holds the full document; emit as a single chunk.
      const final = response.partials[response.partials.length - 1];
      mockChatCompletionsCreate.mockResolvedValueOnce(
        buildOpenAIChatStream([JSON.stringify(final)]),
      );
    },

    setupRunAgent(response) {
      mockChatCompletionsCreate.mockResolvedValueOnce(
        buildOpenAIChatResponse({
          text: response.text,
          promptTokens: response.usage.inputTokens,
          completionTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
          finishReason: "stop",
        }),
      );
    },

    setupNetworkError(error) {
      mockChatCompletionsCreate.mockRejectedValueOnce(error);
    },

    createPortWithOnRetry(hook) {
      // Fresh adapter so the hook is wired at construction time.
      const adapterWithHook = createOpenAIAdapter({
        apiKey: "test-key",
        onRetry: hook,
      });
      return adapterWithHook.createLLMPort(MODEL_ID, ALIAS);
    },
  };
});
