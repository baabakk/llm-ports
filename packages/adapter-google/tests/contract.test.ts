/**
 * Adapter conformance: google (Gemini) must satisfy the shared LLMPort contract.
 */

import { runContractTests } from "@llm-ports/adapter-contract-tests";
import { beforeEach } from "vitest";
import {
  buildGeminiResponse,
  buildGeminiStream,
  mockGenerateContent,
  mockGenerateContentStream,
  resetMocks,
} from "./helpers/mock-sdk.js";
import { createGoogleAdapter } from "../src/index.js";

const MODEL_ID = "gemini-2.5-flash";
const ALIAS = "test-google";

beforeEach(() => {
  resetMocks();
});

runContractTests("google", () => {
  const adapter = createGoogleAdapter({ apiKey: "test-key" });
  const port = adapter.createLLMPort(MODEL_ID, ALIAS);

  return {
    port,
    expectedAlias: ALIAS,
    expectedModelId: MODEL_ID,
    imageContentSupport: "base64+url",
    signalSupport: "entry+inflight",

    setupGenerateText(response) {
      mockGenerateContent.mockResolvedValueOnce(
        buildGeminiResponse({
          text: response.text,
          promptTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
        }),
      );
    },

    setupGenerateStructured(response) {
      if (response.invalidFirstAttempt !== undefined) {
        mockGenerateContent.mockResolvedValueOnce(
          buildGeminiResponse({
            text: JSON.stringify(response.invalidFirstAttempt),
            promptTokens: Math.floor(response.usage.inputTokens / 2),
            outputTokens: Math.floor(response.usage.outputTokens / 2),
            modelId: response.modelId ?? MODEL_ID,
          }),
        );
      }
      mockGenerateContent.mockResolvedValueOnce(
        buildGeminiResponse({
          text: JSON.stringify(response.data),
          promptTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
        }),
      );
    },

    setupStreamText(response) {
      mockGenerateContentStream.mockResolvedValueOnce(buildGeminiStream(response.chunks));
    },

    setupStreamStructured(response) {
      // Emit the final partial in one chunk so the partial-parser sees a
      // complete JSON document at end-of-stream. Mirrors the adapter-anthropic
      // contract test approach.
      const final = response.partials[response.partials.length - 1];
      mockGenerateContentStream.mockResolvedValueOnce(
        buildGeminiStream([JSON.stringify(final)]),
      );
    },

    setupRunAgent(response) {
      mockGenerateContent.mockResolvedValueOnce(
        buildGeminiResponse({
          text: response.text,
          promptTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
          finishReason: "STOP",
        }),
      );
    },

    setupNetworkError(error) {
      mockGenerateContent.mockRejectedValueOnce(error);
      mockGenerateContentStream.mockRejectedValueOnce(error);
    },
  };
});
