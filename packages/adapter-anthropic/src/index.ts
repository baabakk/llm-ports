/**
 * @llm-ports/adapter-anthropic — public API.
 *
 * Wraps @anthropic-ai/sdk to implement LLMPort. Use with @llm-ports/core's
 * createRegistryFromEnv:
 *
 *   const registry = createRegistryFromEnv({
 *     adapters: {
 *       anthropic: createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }),
 *     },
 *   });
 *
 * The "anthropic" adapter token referenced from .env (LLM_PROVIDER_FAST=anthropic|...)
 * matches the AnthropicAdapter.name field returned by createAnthropicAdapter().
 */

export { createAnthropicAdapter, type AnthropicAdapter, type AnthropicAdapterOptions } from "./adapter.js";
export { ANTHROPIC_PRICING, lookupAnthropicPricing } from "./pricing.js";
