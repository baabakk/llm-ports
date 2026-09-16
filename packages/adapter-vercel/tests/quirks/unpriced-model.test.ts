/**
 * Alpha.34: a model missing from the pricing table is usable, and reports no
 * cost.
 *
 * Before this release the adapter threw an untyped error when a port was
 * created for a model with no price, so an unpriced model could never reach
 * the Registry's own, better-informed admission rule. The price is resolved
 * once, when the port is created, so constructing the port and making one
 * call covers every method on it.
 *
 * `cost` must be absent, not zero: a zero reads as a free call to anything
 * totalling spend, and the resulting under-count looks plausible.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildVercelGenerateTextResult,
  mockGenerateText,
  resetMocks,
} from "../helpers/fake-vercel-model.js";
import { createVercelAdapter } from "../../src/index.js";

const MODEL_ID = "model-with-no-published-price";

beforeEach(() => {
  resetMocks();
});

describe("an unpriced model", () => {
  it("is constructible, answers, and reports cost as undefined", async () => {
    // The model is supplied, but neither the caller nor the bundled table
    // has a price for it.
    const adapter = createVercelAdapter({
      models: { [MODEL_ID]: { specificationVersion: "v2" } as never },
    });
    const port = adapter.createLLMPort(MODEL_ID, "live");

    mockGenerateText.mockResolvedValueOnce(
      buildVercelGenerateTextResult({
        text: "answered anyway",
        promptTokens: 10,
        completionTokens: 4,
        modelId: MODEL_ID,
      }),
    );
    const result = await port.generateText({ messages: [{ role: "user", content: "hi" }] });

    expect(result.text).toBe("answered anyway");
    expect(result.cost).toBeUndefined();
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });
});
