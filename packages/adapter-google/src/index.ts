/**
 * @llm-ports/adapter-google — public API.
 *
 * Native Google Gemini adapter (uses @google/genai SDK). Implements LLMPort
 * with full multimodal support — image content blocks pass through as
 * inlineData (base64) or fileData (URL), NOT degraded to placeholder text.
 *
 * Bundled pricing covers Gemini 2.5 (pro/flash/flash-lite) and Gemini 2.0
 * (flash/flash-lite). Override per model via `pricingOverrides`.
 *
 * Why use this over the OpenAI-compat baseURL (https://generativelanguage.googleapis.com/v1beta/openai/):
 *   - alpha.4's ImageSource.detail field is silently ignored on the compat
 *     endpoint (no Gemini equivalent). This adapter ignores it consistently
 *     across providers (same behavior as adapter-anthropic).
 *   - Native systemInstruction handling (compat endpoint converts to a
 *     prepended user message, which changes Gemini's behavior).
 *   - Native multimodal richness — inlineData with explicit mediaType vs
 *     compat's image_url with a base64 data URI.
 *
 * Roadmap for the v0.1 → v0.2 cycle:
 *   - Native Gemini responseSchema in generateStructured (v0.1 uses prompted
 *     JSON + Zod + alpha.5 repair pass, which works but skips Gemini's
 *     constrained-decoding feature).
 *   - Multi-turn runAgent through Gemini's automatic-function-calling.
 *   - Embeddings via gemini-embedding-001.
 *   - Explicit context caching (Gemini's `cachedContent` feature).
 *   - Code execution tool (Gemini's built-in code interpreter).
 */

export {
  createGoogleAdapter,
  type GoogleAdapter,
  type GoogleAdapterOptions,
} from "./adapter.js";
export { GEMINI_PRICING, lookupGeminiPricing } from "./pricing.js";
