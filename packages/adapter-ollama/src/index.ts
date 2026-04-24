/**
 * @llm-ports/adapter-ollama — public API.
 *
 * Local LLM adapter using the Ollama daemon. Implements LLMPort,
 * EmbeddingsPort, and adapter-level model management (list/pull/delete/health).
 *
 * Local-to-cloud flip: develop with Ollama, ship with cloud providers,
 * change one .env line:
 *
 *   # development
 *   LLM_PROVIDER_DRAFT=ollama|llama3.3|unlimited
 *
 *   # production
 *   LLM_PROVIDER_DRAFT=anthropic|claude-sonnet-4-6|cost:200/day
 *
 * Application code never changes.
 */

export {
  createOllamaAdapter,
  type OllamaAdapter,
  type OllamaAdapterOptions,
  type OllamaModelInfo,
} from "./adapter.js";
export {
  OLLAMA_PRICING,
  OLLAMA_DEFAULT_PRICING,
  lookupOllamaPricing,
} from "./pricing.js";
