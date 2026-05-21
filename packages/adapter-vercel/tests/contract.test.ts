/**
 * Adapter conformance: vercel must satisfy the shared LLMPort contract.
 * Mocks the Vercel AI SDK helpers so no provider call is made.
 */

import { runContractTests } from "@llm-ports/adapter-contract-tests";
import { beforeEach } from "vitest";
import {
  buildVercelGenerateTextResult,
  buildVercelStreamResult,
  mockGenerateText,
  mockStreamText,
  resetMocks,
} from "./helpers/fake-vercel-model.js";
import { createVercelAdapter } from "../src/index.js";

const MODEL_ID = "fake-model";
const ALIAS = "test-vercel";

// A trivial fake LanguageModel; the actual model object is never inspected
// by our adapter — it just gets passed through to the mocked SDK helpers.
const fakeLanguageModel = { specificationVersion: "v2" } as never;

beforeEach(() => {
  resetMocks();
});

runContractTests("vercel", () => {
  const adapter = createVercelAdapter({
    models: { [MODEL_ID]: fakeLanguageModel },
    pricing: { [MODEL_ID]: { inputPer1M: 1, outputPer1M: 4 } },
  });
  const port = adapter.createLLMPort(MODEL_ID, ALIAS);

  return {
    port,
    expectedAlias: ALIAS,
    expectedModelId: MODEL_ID,
    imageContentSupport: "none", // v0.1: image blocks degrade to placeholder strings

    setupGenerateText(response) {
      mockGenerateText.mockResolvedValueOnce(
        buildVercelGenerateTextResult({
          text: response.text,
          promptTokens: response.usage.inputTokens,
          completionTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
        }),
      );
    },

    setupGenerateStructured(response) {
      if (response.invalidFirstAttempt !== undefined) {
        mockGenerateText.mockResolvedValueOnce(
          buildVercelGenerateTextResult({
            text: JSON.stringify(response.invalidFirstAttempt),
            promptTokens: Math.floor(response.usage.inputTokens / 2),
            completionTokens: Math.floor(response.usage.outputTokens / 2),
            modelId: response.modelId ?? MODEL_ID,
          }),
        );
      }
      mockGenerateText.mockResolvedValueOnce(
        buildVercelGenerateTextResult({
          text: JSON.stringify(response.data),
          promptTokens: response.usage.inputTokens,
          completionTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
        }),
      );
    },

    setupStreamText(response) {
      mockStreamText.mockReturnValueOnce(buildVercelStreamResult(response.chunks));
    },

    setupStreamStructured(response) {
      const final = response.partials[response.partials.length - 1];
      mockStreamText.mockReturnValueOnce(
        buildVercelStreamResult([JSON.stringify(final)]),
      );
    },

    setupRunAgent(response) {
      mockGenerateText.mockResolvedValueOnce(
        buildVercelGenerateTextResult({
          text: response.text,
          promptTokens: response.usage.inputTokens,
          completionTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
        }),
      );
    },

    setupNetworkError(error) {
      mockGenerateText.mockRejectedValueOnce(error);
    },

    createPortWithOnRetry(hook) {
      const adapterWithHook = createVercelAdapter({
        models: { [MODEL_ID]: fakeLanguageModel },
        pricing: { [MODEL_ID]: { inputPer1M: 1, outputPer1M: 4 } },
        onRetry: hook,
      });
      return adapterWithHook.createLLMPort(MODEL_ID, ALIAS);
    },
  };
});
