/**
 * @llm-ports/adapter-vercel — public API.
 *
 * Vercel AI SDK adapter. Migration helper for users already using @ai-sdk/*.
 * Bring your own pre-configured Vercel LanguageModel/EmbeddingModel instances;
 * the adapter handles LLMPort plumbing and per-call cost tracking.
 *
 * Example:
 *   import { anthropic } from "@ai-sdk/anthropic";
 *   import { openai } from "@ai-sdk/openai";
 *   import { createVercelAdapter } from "@llm-ports/adapter-vercel";
 *   import { createRegistryFromEnv } from "@llm-ports/core";
 *
 *   const registry = createRegistryFromEnv({
 *     adapters: {
 *       vercel: createVercelAdapter({
 *         models: {
 *           "claude-sonnet-4-6": anthropic("claude-sonnet-4-6"),
 *           "gpt-5": openai("gpt-5"),
 *         },
 *         embeddingModels: {
 *           "text-embedding-3-small": openai.textEmbeddingModel("text-embedding-3-small"),
 *         },
 *         pricing: {
 *           "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
 *           "gpt-5": { inputPer1M: 2.5, outputPer1M: 10 },
 *           "text-embedding-3-small": { inputPer1M: 0, outputPer1M: 0, embeddingPer1M: 0.02 },
 *         },
 *       }),
 *     },
 *   });
 *
 * Use this adapter when you already have Vercel AI SDK in your project and
 * want to add cost gating, fallback chains, and capability factories on top.
 * For new projects, prefer the direct adapters (adapter-anthropic, adapter-openai).
 */

export {
  createVercelAdapter,
  type VercelAdapter,
  type VercelAdapterOptions,
} from "./adapter.js";
export { VERCEL_PRICING, lookupVercelPricing } from "./pricing.js";
