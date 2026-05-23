/**
 * Adapter conformance: ollama must satisfy the shared LLMPort contract.
 */

import { runContractTests } from "@llm-ports/adapter-contract-tests";
import { beforeEach } from "vitest";
import {
  buildOllamaChatResponse,
  buildOllamaChatStream,
  mockChat,
  resetMocks,
} from "./helpers/mock-sdk.js";
import { createOllamaAdapter } from "../src/index.js";

const MODEL_ID = "llama3.3";
const ALIAS = "test-ollama";

beforeEach(() => {
  resetMocks();
});

runContractTests("ollama", () => {
  const adapter = createOllamaAdapter();
  const port = adapter.createLLMPort(MODEL_ID, ALIAS);

  return {
    port,
    expectedAlias: ALIAS,
    expectedModelId: MODEL_ID,
    imageContentSupport: "base64",
    signalSupport: "entry-only",

    setupGenerateText(response) {
      mockChat.mockResolvedValueOnce(
        buildOllamaChatResponse({
          text: response.text,
          promptEvalCount: response.usage.inputTokens,
          evalCount: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
        }),
      );
    },

    setupGenerateStructured(response) {
      if (response.invalidFirstAttempt !== undefined) {
        mockChat.mockResolvedValueOnce(
          buildOllamaChatResponse({
            text: JSON.stringify(response.invalidFirstAttempt),
            promptEvalCount: Math.floor(response.usage.inputTokens / 2),
            evalCount: Math.floor(response.usage.outputTokens / 2),
            modelId: response.modelId ?? MODEL_ID,
          }),
        );
      }
      mockChat.mockResolvedValueOnce(
        buildOllamaChatResponse({
          text: JSON.stringify(response.data),
          promptEvalCount: response.usage.inputTokens,
          evalCount: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
        }),
      );
    },

    setupStreamText(response) {
      mockChat.mockResolvedValueOnce(buildOllamaChatStream(response.chunks));
    },

    setupStreamStructured(response) {
      const final = response.partials[response.partials.length - 1];
      mockChat.mockResolvedValueOnce(
        buildOllamaChatStream([JSON.stringify(final)]),
      );
    },

    setupRunAgent(response) {
      mockChat.mockResolvedValueOnce(
        buildOllamaChatResponse({
          text: response.text,
          promptEvalCount: response.usage.inputTokens,
          evalCount: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
          doneReason: "stop",
        }),
      );
    },

    setupNetworkError(error) {
      mockChat.mockRejectedValueOnce(error);
    },
  };
});
