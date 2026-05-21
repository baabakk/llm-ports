/**
 * Adapter conformance: anthropic must satisfy the shared LLMPort contract.
 *
 * The mock-sdk helper hoists vi.mock for @anthropic-ai/sdk so the imported
 * createAnthropicAdapter uses the mocked client. We register typed mock
 * responses per test via the contract-test setup hooks.
 */

import { runContractTests } from "@llm-ports/adapter-contract-tests";
import { beforeEach } from "vitest";
import {
  buildAnthropicResponse,
  buildAnthropicTextStream,
  mockCreate,
  mockStream,
  resetMocks,
} from "./helpers/mock-sdk.js";
import { createAnthropicAdapter } from "../src/index.js";

const MODEL_ID = "claude-haiku-4-5";
const ALIAS = "test-anthropic";

beforeEach(() => {
  resetMocks();
});

runContractTests("anthropic", () => {
  const adapter = createAnthropicAdapter({ apiKey: "test-key" });
  const port = adapter.createLLMPort(MODEL_ID, ALIAS);

  return {
    port,
    expectedAlias: ALIAS,
    expectedModelId: MODEL_ID,
    imageContentSupport: "base64+url",

    setupGenerateText(response) {
      mockCreate.mockResolvedValueOnce(
        buildAnthropicResponse({
          textBlocks: [response.text],
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
        }),
      );
    },

    setupGenerateStructured(response) {
      // If the spec includes invalidFirstAttempt, queue an invalid response first
      // so the adapter's retry-with-feedback strategy fires.
      if (response.invalidFirstAttempt !== undefined) {
        mockCreate.mockResolvedValueOnce(
          buildAnthropicResponse({
            textBlocks: [JSON.stringify(response.invalidFirstAttempt)],
            inputTokens: Math.floor(response.usage.inputTokens / 2),
            outputTokens: Math.floor(response.usage.outputTokens / 2),
            modelId: response.modelId ?? MODEL_ID,
          }),
        );
      }
      mockCreate.mockResolvedValueOnce(
        buildAnthropicResponse({
          textBlocks: [JSON.stringify(response.data)],
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
        }),
      );
    },

    setupStreamText(response) {
      mockStream.mockReturnValueOnce(buildAnthropicTextStream(response.chunks));
    },

    setupStreamStructured(response) {
      // For streamStructured the adapter accumulates text deltas and emits
      // partials. Encode each partial as a JSON delta string.
      const chunks: string[] = [];
      let prevSerialized = "";
      for (const partial of response.partials) {
        const serialized = JSON.stringify(partial);
        // Emit only the new tail compared to the previous emit so the buffer
        // grows incrementally as it would on the wire.
        const delta = serialized.startsWith(prevSerialized)
          ? serialized.slice(prevSerialized.length)
          : serialized;
        chunks.push(delta);
        prevSerialized = serialized;
      }
      // Anthropic streams the full final JSON across content_block_delta events.
      // Replace the chunk sequence with the full final document at the end so
      // the final partial is parseable.
      mockStream.mockReturnValueOnce(
        buildAnthropicTextStream([JSON.stringify(response.partials[response.partials.length - 1])]),
      );
    },

    setupRunAgent(response) {
      mockCreate.mockResolvedValueOnce(
        buildAnthropicResponse({
          textBlocks: [response.text],
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          modelId: response.modelId ?? MODEL_ID,
          stopReason: "end_turn",
        }),
      );
    },

    setupNetworkError(error) {
      mockCreate.mockRejectedValueOnce(error);
      mockStream.mockImplementationOnce(() => {
        throw error;
      });
    },
  };
});
