/**
 * @llm-ports/adapter-openai — public API.
 *
 * Wraps the OpenAI SDK to implement LLMPort and EmbeddingsPort. The same
 * adapter serves OpenAI plus 10+ OpenAI-compatible providers via baseURL:
 *
 *   const registry = createRegistryFromEnv({
 *     adapters: {
 *       openai: createOpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
 *       groq: createOpenAIAdapter({
 *         apiKey: process.env.GROQ_API_KEY!,
 *         baseURL: "https://api.groq.com/openai/v1",
 *         displayName: "groq",
 *       }),
 *     },
 *   });
 *
 * The adapter token in env config matches the key under `adapters` in the
 * registry call. Both reference the OpenAI SDK shape; only the baseURL
 * (and pricing override) changes.
 */

export {
  autoDetectStrictResponseFormat,
  createOpenAIAdapter,
  type OpenAIAdapter,
  type OpenAIAdapterOptions,
} from "./adapter.js";
export { OPENAI_PRICING, lookupOpenAIPricing } from "./pricing.js";
export { KNOWN_REASONING_MODELS } from "./capabilities.js";
