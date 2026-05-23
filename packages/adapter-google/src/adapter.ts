/**
 * Google Gemini adapter for llm-ports.
 *
 * Wraps @google/genai (the unified Gemini + Vertex SDK as of 2026) to
 * implement LLMPort. Provides:
 *
 *   - Native multimodal: image content blocks pass through as inlineData
 *     (base64) or fileData (URL). NO degradation, unlike OpenAI-compat
 *     baseURL where image_url.detail is silently ignored.
 *   - Native streaming via generateContentStream
 *   - Structured output via prompted-JSON + Zod retry-with-feedback
 *     + alpha.5 programmatic repair. Native Gemini responseSchema lands
 *     in v0.2.
 *   - Image-block boundary validation (size + URL scheme) — same shape
 *     as adapter-anthropic and adapter-openai (alpha.5).
 *
 * Out of scope for v0.1 alpha:
 *   - Embeddings (Gemini's embedding API is separate; lands in v0.2)
 *   - Multi-turn runAgent through Gemini's native automatic tool calling
 *     (v0.1 ships a single-turn shim consistent with adapter-vercel)
 *   - Caching API (Gemini supports explicit context caching; lands in v0.2)
 *   - Code execution tool (Gemini's built-in code interpreter; lands in v0.2)
 */

import { GoogleGenAI } from "@google/genai";
import {
  attemptValidationRepair,
  computeChatCost,
  extractJSON,
  failValidation,
  stringifyContentBlocks,
  throwIfAborted,
  tryParsePartialJSON,
  validateImageBlocks,
  wrapProviderError,
  type AgentResult,
  type ContentBlock,
  type GenerateStructuredOptions,
  type GenerateStructuredResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type LLMPort,
  type MessageContent,
  type ModelPricing,
  type RunAgentOptions,
  type StreamStructuredOptions,
  type StreamTextOptions,
  type TokenUsage,
  type ValidationStrategy,
} from "@llm-ports/core";
import {
  extractGeminiText,
  toGeminiParts2,
  toGeminiRequest,
  type GeminiPart,
} from "./content.js";
import { GEMINI_PRICING } from "./pricing.js";

// ─── Adapter options ─────────────────────────────────────────────────

export interface GoogleAdapterOptions {
  /** Google AI API key (https://aistudio.google.com/apikey). */
  apiKey: string;
  /** Override Gemini pricing for any model id. Falls back to the bundled table. */
  pricingOverrides?: Record<string, ModelPricing>;
  /** Default validation strategy if the registry doesn't override per-call. */
  validationStrategy?: ValidationStrategy;
  /**
   * Maximum bytes per base64 image. Defaults to 20MB (Gemini accepts up to
   * 20MB inlined; fileData URLs are unconstrained but provider-fetched).
   * Set to 0 or a negative number to disable size validation.
   */
  imageSizeLimitBytes?: number;
}

// ─── Internal context ────────────────────────────────────────────────

interface AdapterContext {
  client: GoogleGenAI;
  validationStrategy: ValidationStrategy;
  pricingOverrides: Record<string, ModelPricing>;
  imageSizeLimitBytes: number;
}

function pricingFor(ctx: AdapterContext, modelId: string): ModelPricing {
  const pricing = ctx.pricingOverrides[modelId] ?? GEMINI_PRICING[modelId];
  if (!pricing) {
    throw new Error(
      `No pricing entry for Google Gemini model "${modelId}". Provide pricingOverrides or update src/pricing.ts.`,
    );
  }
  return pricing;
}

// ─── Public factory ──────────────────────────────────────────────────

export interface GoogleAdapter {
  name: "google";
  pricing: Record<string, ModelPricing>;
  createLLMPort: (modelId: string, alias: string) => LLMPort;
}

export function createGoogleAdapter(opts: GoogleAdapterOptions): GoogleAdapter {
  const mergedPricing: Record<string, ModelPricing> = {
    ...GEMINI_PRICING,
    ...(opts.pricingOverrides ?? {}),
  };
  const ctx: AdapterContext = {
    client: new GoogleGenAI({ apiKey: opts.apiKey }),
    validationStrategy: opts.validationStrategy ?? {
      kind: "retry-with-feedback",
      maxAttempts: 2,
      includeOriginalError: true,
    },
    pricingOverrides: opts.pricingOverrides ?? {},
    imageSizeLimitBytes: opts.imageSizeLimitBytes ?? 20 * 1024 * 1024,
  };
  return {
    name: "google",
    pricing: mergedPricing,
    createLLMPort: (modelId, alias) => createPort(ctx, modelId, alias),
  };
}

// ─── Port implementation ─────────────────────────────────────────────

function createPort(ctx: AdapterContext, modelId: string, alias: string): LLMPort {
  const pricing = pricingFor(ctx, modelId);

  // Image-block validation closure: throws ImageTooLargeError or
  // InvalidImageUrlError before the SDK call.
  const validateContent = (content: MessageContent): void => {
    if (Array.isArray(content)) {
      validateImageBlocks(content, {
        alias,
        ...(ctx.imageSizeLimitBytes > 0 ? { limitBytes: ctx.imageSizeLimitBytes } : {}),
      });
    }
  };
  const validateMessages = (messages: ReadonlyArray<{ content: MessageContent }>): void => {
    for (const msg of messages) validateContent(msg.content);
  };

  return {
    async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
      throwIfAborted(options.signal);
      validateContent(options.prompt);
      const start = Date.now();
      try {
        const parts = toGeminiParts2(options.prompt);
        const response = await ctx.client.models.generateContent({
          model: modelId,
          contents: [{ role: "user", parts }],
          config: {
            ...(options.instructions !== undefined
              ? { systemInstruction: options.instructions }
              : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.maxOutputTokens !== undefined
              ? { maxOutputTokens: options.maxOutputTokens }
              : {}),
            ...(options.signal ? { abortSignal: options.signal } : {}),
          },
        });
        const candidate = response.candidates?.[0];
        const text = extractGeminiText(candidate?.content?.parts as GeminiPart[] | undefined);
        const usage = parseUsage(response);
        return {
          text,
          usage,
          cost: computeChatCost(usage, pricing),
          modelId: response.modelVersion ?? modelId,
          providerAlias: alias,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },

    async generateStructured<T>(
      options: GenerateStructuredOptions<T>,
    ): Promise<GenerateStructuredResult<T>> {
      throwIfAborted(options.signal);
      validateContent(options.prompt);
      const start = Date.now();
      let attempts = 0;
      const maxAttempts =
        ctx.validationStrategy.kind === "retry-with-feedback"
          ? ctx.validationStrategy.maxAttempts
          : 1;

      let correctionPrompt: string | null = null;
      let lastUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let lastModelId = modelId;

      while (attempts < maxAttempts) {
        attempts++;
        const userText = correctionPrompt
          ? `${stringifyContentBlocks(options.prompt)}\n\n${correctionPrompt}`
          : `${stringifyContentBlocks(options.prompt)}\n\nReply with a single JSON object only. No prose, no code fences.`;

        try {
          const response = await ctx.client.models.generateContent({
            model: modelId,
            contents: [{ role: "user", parts: [{ text: userText }] }],
            config: {
              ...(options.instructions !== undefined
                ? { systemInstruction: options.instructions }
                : {}),
              temperature: options.temperature ?? 0,
              ...(options.maxOutputTokens !== undefined
                ? { maxOutputTokens: options.maxOutputTokens }
                : {}),
              responseMimeType: "application/json",
              ...(options.signal ? { abortSignal: options.signal } : {}),
            },
          });
          const candidate = response.candidates?.[0];
          const raw = extractGeminiText(candidate?.content?.parts as GeminiPart[] | undefined);
          lastUsage = parseUsage(response);
          lastModelId = response.modelVersion ?? modelId;

          const decoded = extractJSON(raw);
          let parsed = options.schema.safeParse(decoded);
          if (!parsed.success) {
            const repaired = attemptValidationRepair(decoded, parsed.error);
            const reparsed = options.schema.safeParse(repaired);
            if (reparsed.success) parsed = reparsed;
          }
          if (parsed.success) {
            return {
              data: parsed.data as T,
              usage: lastUsage,
              cost: computeChatCost(lastUsage, pricing),
              modelId: lastModelId,
              providerAlias: alias,
              latencyMs: Date.now() - start,
              validationAttempts: attempts,
            };
          }
          if (
            ctx.validationStrategy.kind === "retry-with-feedback" &&
            attempts < maxAttempts
          ) {
            const issues = parsed.error.issues
              .map((i) => `- ${i.path.join(".") || "<root>"}: ${i.message}`)
              .join("\n");
            correctionPrompt = `Your previous response failed validation:\n${issues}\n\nReply with a single corrected JSON object only.`;
            continue;
          }
          failValidation(parsed.error.issues, attempts);
        } catch (err) {
          throw wrapProviderError(alias, err);
        }
      }
      throw new Error("generateStructured exhausted attempts");
    },

    async *streamText(options: StreamTextOptions): AsyncIterable<string> {
      throwIfAborted(options.signal);
      validateContent(options.prompt);
      try {
        const parts = toGeminiParts2(options.prompt);
        const stream = await ctx.client.models.generateContentStream({
          model: modelId,
          contents: [{ role: "user", parts }],
          config: {
            ...(options.instructions !== undefined
              ? { systemInstruction: options.instructions }
              : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.maxOutputTokens !== undefined
              ? { maxOutputTokens: options.maxOutputTokens }
              : {}),
            ...(options.signal ? { abortSignal: options.signal } : {}),
          },
        });
        for await (const chunk of stream) {
          const text = extractGeminiText(
            chunk.candidates?.[0]?.content?.parts as GeminiPart[] | undefined,
          );
          if (text.length > 0) yield text;
        }
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },

    async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
      throwIfAborted(options.signal);
      validateContent(options.prompt);
      try {
        const stream = await ctx.client.models.generateContentStream({
          model: modelId,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `${stringifyContentBlocks(options.prompt)}\n\nReply with a single JSON object only. Stream the JSON progressively.`,
                },
              ],
            },
          ],
          config: {
            ...(options.instructions !== undefined
              ? { systemInstruction: options.instructions }
              : {}),
            temperature: options.temperature ?? 0,
            ...(options.maxOutputTokens !== undefined
              ? { maxOutputTokens: options.maxOutputTokens }
              : {}),
            responseMimeType: "application/json",
            ...(options.signal ? { abortSignal: options.signal } : {}),
          },
        });
        let buffer = "";
        for await (const chunk of stream) {
          const text = extractGeminiText(
            chunk.candidates?.[0]?.content?.parts as GeminiPart[] | undefined,
          );
          if (text.length === 0) continue;
          buffer += text;
          const partial = tryParsePartialJSON(buffer);
          if (partial !== null) yield partial as Partial<T>;
        }
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },

    async runAgent(options: RunAgentOptions): Promise<AgentResult> {
      throwIfAborted(options.signal);
      validateMessages(options.messages);
      // v0.1: single-turn agent loop. Gemini's native automatic-function-calling
      // multi-turn runAgent ships in v0.2 (matches adapter-vercel's v0.1 shape).
      const start = Date.now();
      try {
        const { systemInstruction, contents } = toGeminiRequest(options.messages);
        const response = await ctx.client.models.generateContent({
          model: modelId,
          contents,
          config: {
            ...(systemInstruction !== undefined ? { systemInstruction } : {}),
            ...(options.instructions !== undefined
              ? { systemInstruction: options.instructions }
              : {}),
            ...(options.signal ? { abortSignal: options.signal } : {}),
          },
        });
        const candidate = response.candidates?.[0];
        const text = extractGeminiText(candidate?.content?.parts as GeminiPart[] | undefined);
        const usage = parseUsage(response);
        const toolCalls: AgentResult["toolCalls"] = [];
        // v0.1 stub: we surface no tool calls. Real tool-use is v0.2 scope.
        return {
          text,
          messages: [
            ...options.messages,
            { role: "assistant" as const, content: text },
          ],
          usage,
          cost: computeChatCost(usage, pricing),
          modelId: response.modelVersion ?? modelId,
          providerAlias: alias,
          latencyMs: Date.now() - start,
          toolCalls,
          stepsTaken: 1,
          terminationReason: "completed",
        };
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiResponseShape {
  usageMetadata?: GeminiUsageMetadata;
}

function parseUsage(response: GeminiResponseShape): TokenUsage {
  const m = response.usageMetadata ?? {};
  const inputTokens = m.promptTokenCount ?? 0;
  const outputTokens = m.candidatesTokenCount ?? 0;
  const totalTokens = m.totalTokenCount ?? inputTokens + outputTokens;
  const usage: TokenUsage = { inputTokens, outputTokens, totalTokens };
  if (m.cachedContentTokenCount !== undefined && m.cachedContentTokenCount > 0) {
    usage.cacheReadTokens = m.cachedContentTokenCount;
  }
  return usage;
}

// Re-export ContentBlock for the rare adapter user that wants to type-check
// outside of @llm-ports/core. Keeps the import surface symmetric with the
// other adapters.
export type { ContentBlock };
