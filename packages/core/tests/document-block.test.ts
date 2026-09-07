/**
 * Alpha.33, item 3 — `DocumentBlock` routing.
 *
 * Adapter support for documents is uneven and always will be: providers
 * disagree about whether a document arrives as bytes, as a URL, or as an
 * uploaded file id, and one of the three adapters in the beta set cannot
 * express a document at all on its supported SDK range.
 *
 * The design answer is that uneven support degrades into **routing**, not
 * into failure. An adapter that cannot carry a document throws
 * `ContentBlockUnsupportedError`, and `defaultShouldFallback` already
 * treats that class as walk-worthy, so a chain advances to a provider that
 * can serve the call.
 *
 * That claim is the whole reason item 3 could ship with partial coverage,
 * so it is tested here rather than assumed. Note these use the **default**
 * fallback policy on purpose: if this only worked under `"aggressive"`,
 * consumers would have to opt in to get a document answered, and the
 * claim in the plan document would be wrong.
 */

import { describe, expect, it } from "vitest";
import {
  ContentBlockUnsupportedError,
  createRegistryFromEnv,
  type AdapterRegistration,
  type ContentBlock,
  type DocumentBlock,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
} from "../src/index.js";

const PRICING: ModelPricing = { inputPer1M: 1, outputPer1M: 2 };

const PDF: DocumentBlock = {
  type: "document",
  source: { kind: "base64", mediaType: "application/pdf", data: "JVBERi0=" },
  filename: "inspection-report.pdf",
};

function result(text: string): GenerateTextResult {
  return {
    text,
    modelId: "model-x",
    providerAlias: "unused",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    cost: { inputUSD: 0, outputUSD: 0, totalUSD: 0 },
  } as GenerateTextResult;
}

/** A provider that refuses documents, the way every non-supporting adapter does. */
function refusesDocuments(name: string): LLMPort {
  return {
    generateText: async (options) => {
      const blocks = options.messages.flatMap((m) =>
        typeof m.content === "string" ? [] : (m.content as ContentBlock[]),
      );
      if (blocks.some((b) => b.type === "document")) {
        throw new ContentBlockUnsupportedError(name, "document");
      }
      return result(`${name} answered`);
    },
  } as unknown as LLMPort;
}

function acceptsDocuments(name: string): LLMPort {
  return {
    generateText: async () => result(`${name} read the document`),
  } as unknown as LLMPort;
}

function adapterFor(name: string, port: LLMPort): AdapterRegistration {
  return { name, pricing: { "model-x": PRICING }, createLLMPort: () => port };
}

const ENV_TWO = {
  LLM_PROVIDER_A: "alpha|model-x|req:100/hour",
  LLM_PROVIDER_B: "beta|model-x|req:100/hour",
  LLM_TASK_ROUTE_CHAT: "a,b",
} as const;

describe("a provider that cannot carry a document routes past itself", () => {
  it("walks to a provider that can, under the DEFAULT fallback policy", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", refusesDocuments("alpha")),
        beta: adapterFor("beta", acceptsDocuments("beta")),
      },
      // No runtimeFallback set: this must work out of the box.
    });

    const res = await registry.getPort().generateText({
      taskType: "chat",
      messages: [{ role: "user", content: [{ type: "text", text: "summarize" }, PDF] }],
    });

    expect(res.text).toBe("beta read the document");
  });

  it("does not divert a text-only call away from the first provider", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", refusesDocuments("alpha")),
        beta: adapterFor("beta", acceptsDocuments("beta")),
      },
    });

    // Same chain, same refusing provider at position 1. Without a document
    // in the message it must answer, or the routing above would be masking
    // a chain that simply always walks.
    const res = await registry.getPort().generateText({
      taskType: "chat",
      messages: [{ role: "user", content: "no attachment here" }],
    });

    expect(res.text).toBe("alpha answered");
  });

  it("surfaces the refusal when no provider in the chain can take it", async () => {
    const registry = createRegistryFromEnv({
      env: { ...ENV_TWO },
      adapters: {
        alpha: adapterFor("alpha", refusesDocuments("alpha")),
        beta: adapterFor("beta", refusesDocuments("beta")),
      },
    });

    // Exhausting the chain must raise, not return an answer about a
    // document nothing read. Silent success here would be the worst
    // possible outcome of this feature.
    await expect(
      registry.getPort().generateText({
        taskType: "chat",
        messages: [{ role: "user", content: [PDF] }],
      }),
    ).rejects.toThrow();
  });
});
