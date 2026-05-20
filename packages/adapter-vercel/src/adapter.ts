/**
 * Vercel AI SDK adapter for llm-ports.
 *
 * Migration helper for users already invested in @ai-sdk/* providers. The
 * user supplies pre-configured Vercel `LanguageModel` instances; the adapter
 * routes LLMPort calls through Vercel's `generateText`, `generateObject`,
 * `streamText`, and `embed` helpers.
 *
 * Compared to going to providers directly: more layers, but lets users
 * adopt llm-ports without rewriting their existing Vercel-based stack.
 */

import {
  generateText,
  streamText,
  embed,
  embedMany,
  type LanguageModel,
  type EmbeddingModel,
  type CoreMessage,
} from "ai";
import {
  computeChatCost,
  computeEmbeddingCost,
  emitRetryEvent,
  EmptyResponseError,
  extractJSON,
  failValidation,
  stringifyContentBlocks,
  tryParsePartialJSON,
  wrapProviderError,
  type AgentResult,
  type BatchEmbeddingOptions,
  type BatchEmbeddingResult,
  type EmbeddingOptions,
  type EmbeddingResult,
  type EmbeddingsPort,
  type GenerateStructuredOptions,
  type GenerateStructuredResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
  type OnRetry,
  type RetryEvent,
  type RunAgentOptions,
  type StreamStructuredOptions,
  type StreamTextOptions,
  type TokenUsage,
  type ValidationStrategy,
} from "@llm-ports/core";

/** Multiplier applied to maxOutputTokens when retrying a reasoning-starved call. */
const REASONING_RETRY_MULTIPLIER = 4;

// ─── Adapter options ─────────────────────────────────────────────────

export interface VercelAdapterOptions {
  /**
   * Pre-configured Vercel LanguageModel instances, keyed by the modelId
   * the registry will pass through. Example:
   *   { "claude-sonnet-4-6": anthropic("claude-sonnet-4-6") }
   */
  models?: Record<string, LanguageModel>;
  /**
   * Pre-configured Vercel EmbeddingModel instances. Example:
   *   { "text-embedding-3-small": openai.textEmbeddingModel("text-embedding-3-small") }
   */
  embeddingModels?: Record<string, EmbeddingModel<string>>;
  /**
   * REQUIRED. Pricing per modelId. The Vercel adapter has no built-in pricing
   * table because models come from any of @ai-sdk/anthropic, @ai-sdk/openai,
   * etc. — supply the pricing for whatever you wire up.
   */
  pricing: Record<string, ModelPricing>;
  /** Default validation strategy if the registry doesn't override per-call. */
  validationStrategy?: ValidationStrategy;
  /**
   * Observability hook fired when the adapter retries an in-flight request.
   * Vercel adapter currently fires for two reasons:
   *   - reasoning-starvation (model spent its budget on hidden reasoning; retry with expanded budget)
   *   - validation-feedback  (structured-output schema failed; retry with correction prompt)
   * Sync or async; called fire-and-forget. Hook errors do NOT cancel the retry.
   */
  onRetry?: OnRetry;
}

interface AdapterContext {
  models: Record<string, LanguageModel>;
  embeddingModels: Record<string, EmbeddingModel<string>>;
  pricing: Record<string, ModelPricing>;
  validationStrategy: ValidationStrategy;
  onRetry?: OnRetry;
}

function emitRetry(ctx: AdapterContext, event: RetryEvent): void {
  emitRetryEvent(ctx.onRetry, event);
}

function pricingFor(ctx: AdapterContext, modelId: string): ModelPricing {
  const p = ctx.pricing[modelId];
  if (!p) {
    throw new Error(
      `No pricing entry for Vercel-bound model "${modelId}". Provide one via VercelAdapterOptions.pricing.`,
    );
  }
  return p;
}

// ─── Public factory ──────────────────────────────────────────────────

export interface VercelAdapter {
  name: "vercel";
  pricing: Record<string, ModelPricing>;
  createLLMPort: (modelId: string, alias: string) => LLMPort;
  createEmbeddingsPort: (modelId: string, alias: string) => EmbeddingsPort;
}

export function createVercelAdapter(opts: VercelAdapterOptions): VercelAdapter {
  const ctx: AdapterContext = {
    models: opts.models ?? {},
    embeddingModels: opts.embeddingModels ?? {},
    pricing: opts.pricing,
    validationStrategy: opts.validationStrategy ?? {
      kind: "retry-with-feedback",
      maxAttempts: 2,
      includeOriginalError: true,
    },
    ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
  };

  return {
    name: "vercel",
    pricing: opts.pricing,
    createLLMPort: (modelId, alias) => createPort(ctx, modelId, alias),
    createEmbeddingsPort: (modelId, alias) => createEmbeddings(ctx, modelId, alias),
  };
}

function getModel(ctx: AdapterContext, modelId: string): LanguageModel {
  const model = ctx.models[modelId];
  if (!model) {
    throw new Error(
      `Vercel adapter: no LanguageModel registered for modelId "${modelId}". Add it to VercelAdapterOptions.models.`,
    );
  }
  return model;
}

function getEmbeddingModel(ctx: AdapterContext, modelId: string): EmbeddingModel<string> {
  const model = ctx.embeddingModels[modelId];
  if (!model) {
    throw new Error(
      `Vercel adapter: no EmbeddingModel registered for modelId "${modelId}". Add it to VercelAdapterOptions.embeddingModels.`,
    );
  }
  return model;
}

// ─── LLMPort implementation ──────────────────────────────────────────

/**
 * Heuristic for "model spent its budget on hidden reasoning and produced no
 * visible text." Cerebras gpt-oss-*, OpenAI o-series, and gpt-5-nano all
 * exhibit this when called with a small maxTokens. Vercel's generateText
 * result does not expose reasoning_tokens directly, but the combination
 * empty text + finishReason==="length" + tokens-consumed is strong evidence.
 *
 * Only fires when the caller actually set a maxOutputTokens; otherwise we
 * have nothing to expand and would just loop.
 */
function isReasoningStarved(
  result: { text?: string | null; finishReason?: string; usage?: { completionTokens?: number } },
  hadMaxTokens: boolean,
): boolean {
  if (!hadMaxTokens) return false;
  const text = (result.text ?? "").trim();
  if (text.length > 0) return false;
  const finish = result.finishReason;
  const out = result.usage?.completionTokens ?? 0;
  return finish === "length" && out > 0;
}

/**
 * Call generateText. If the response looks reasoning-starved AND the caller
 * supplied a maxOutputTokens, retry once with REASONING_RETRY_MULTIPLIER ×
 * the budget. Fires onRetry with reason "reasoning-starvation" on the retry.
 */
async function generateWithStarvationRetry(
  ctx: AdapterContext,
  alias: string,
  modelId: string,
  baseRequest: Parameters<typeof generateText>[0] & { maxTokens?: number },
): Promise<Awaited<ReturnType<typeof generateText>>> {
  const result = await generateText(baseRequest);
  if (
    baseRequest.maxTokens !== undefined &&
    isReasoningStarved(result, true)
  ) {
    emitRetry(ctx, {
      reason: "reasoning-starvation",
      attempt: 0,
      modelId,
      providerAlias: alias,
      delayMs: 0,
    });
    return await generateText({
      ...baseRequest,
      maxTokens: baseRequest.maxTokens * REASONING_RETRY_MULTIPLIER,
    });
  }
  return result;
}

function createPort(ctx: AdapterContext, modelId: string, alias: string): LLMPort {
  const pricing = pricingFor(ctx, modelId);
  const model = getModel(ctx, modelId);

  return {
    async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
      const start = Date.now();
      try {
        const result = await generateWithStarvationRetry(ctx, alias, modelId, {
          model,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          prompt: stringifyContentBlocks(options.prompt),
          ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        });
        const usage = parseUsage(result);
        return {
          text: result.text,
          usage,
          cost: computeChatCost(usage, pricing),
          modelId: result.response?.modelId ?? modelId,
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
        try {
          const userPrompt = correctionPrompt
            ? `${stringifyContentBlocks(options.prompt)}\n\n${correctionPrompt}`
            : `${stringifyContentBlocks(options.prompt)}\n\nReply with a single JSON object only. No prose, no code fences.`;
          const result = await generateWithStarvationRetry(ctx, alias, modelId, {
            model,
            ...(options.instructions !== undefined ? { system: options.instructions } : {}),
            prompt: userPrompt,
            temperature: options.temperature ?? 0,
            ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
          });
          lastUsage = parseUsage(result);
          lastModelId = result.response?.modelId ?? modelId;
          // If the response is still empty (after the starvation retry), the
          // model genuinely produced no JSON to parse. Throw a typed
          // EmptyResponseError instead of letting JSON.parse("") raise a
          // confusing SyntaxError that gets wrapped as ProviderUnavailableError.
          if ((result.text ?? "").trim().length === 0) {
            throw new EmptyResponseError(
              alias,
              lastModelId,
              "generateStructured needs a JSON body to parse. Increase maxOutputTokens or route to a fallback model.",
            );
          }
          const parsed = options.schema.safeParse(extractJSON(result.text));
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
            emitRetry(ctx, {
              reason: "validation-feedback",
              attempt: attempts - 1,
              modelId: lastModelId,
              providerAlias: alias,
              delayMs: 0,
              cause: parsed.error,
            });
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
      try {
        const stream = streamText({
          model,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          prompt: stringifyContentBlocks(options.prompt),
          ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        });
        for await (const chunk of stream.textStream) {
          yield chunk;
        }
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },

    async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
      try {
        const stream = streamText({
          model,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          prompt: `${stringifyContentBlocks(options.prompt)}\n\nReply with a single JSON object only. Stream the JSON progressively.`,
          ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
          temperature: options.temperature ?? 0,
        });
        let buffer = "";
        for await (const chunk of stream.textStream) {
          buffer += chunk;
          const partial = tryParsePartialJSON(buffer) as Partial<T> | null;
          if (partial !== null) yield partial;
        }
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },

    async runAgent(options: RunAgentOptions): Promise<AgentResult> {
      // Vercel AI SDK has its own agent loop via tool execution. For v0.1
      // we use a simpler single-turn approach for shape consistency with
      // other adapters; users wanting multi-step tool use via Vercel can
      // call the underlying SDK directly. This will be enhanced in v0.2.
      const start = Date.now();
      try {
        const messages: CoreMessage[] = options.messages.map((m) => ({
          role: m.role === "tool" ? "user" : (m.role as "system" | "user" | "assistant"),
          content: typeof m.content === "string" ? m.content : stringifyContentBlocks(m.content),
        }));
        const result = await generateWithStarvationRetry(ctx, alias, modelId, {
          model,
          system: options.instructions,
          messages,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
        });
        const usage = parseUsage(result);
        return {
          text: result.text,
          messages: options.messages,
          toolCalls: [],
          usage,
          cost: computeChatCost(usage, pricing),
          modelId: result.response?.modelId ?? modelId,
          providerAlias: alias,
          latencyMs: Date.now() - start,
          stepsTaken: 1,
          terminationReason: "completed",
        };
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },
  };
}

// ─── EmbeddingsPort ──────────────────────────────────────────────────

function createEmbeddings(
  ctx: AdapterContext,
  modelId: string,
  alias: string,
): EmbeddingsPort {
  const pricing = pricingFor(ctx, modelId);
  // Defer getEmbeddingModel until an embedding is actually requested. The
  // registry calls createEmbeddingsPort eagerly during selectModel even when
  // only LLM chat operations will run; throwing here would break unrelated
  // chat tests against the same modelId.

  return {
    async generateEmbedding(options: EmbeddingOptions): Promise<EmbeddingResult> {
      const start = Date.now();
      const model = getEmbeddingModel(ctx, modelId);
      try {
        const result = await embed({ model, value: options.input });
        const inputTokens = result.usage?.tokens ?? Math.ceil(options.input.length / 4);
        return {
          vector: result.embedding,
          dimensions: result.embedding.length,
          modelId,
          providerAlias: alias,
          usage: { inputTokens },
          cost: computeEmbeddingCost(inputTokens, pricing),
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },

    async generateEmbeddings(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
      const start = Date.now();
      const model = getEmbeddingModel(ctx, modelId);
      try {
        const result = await embedMany({ model, values: options.inputs });
        const inputTokens =
          result.usage?.tokens ?? options.inputs.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
        return {
          vectors: result.embeddings,
          dimensions: result.embeddings[0]?.length ?? 0,
          modelId,
          providerAlias: alias,
          usage: { inputTokens },
          cost: computeEmbeddingCost(inputTokens, pricing),
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function parseUsage(result: { usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }): TokenUsage {
  const inputTokens = result.usage?.promptTokens ?? 0;
  const outputTokens = result.usage?.completionTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: result.usage?.totalTokens ?? inputTokens + outputTokens,
  };
}

