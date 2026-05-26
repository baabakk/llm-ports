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
  tool,
  type LanguageModel,
  type EmbeddingModel,
  type CoreMessage,
  type StepResult,
} from "ai";
import { hasMultimodalContent, toVercelParts } from "./content.js";
import { VERCEL_PRICING } from "./pricing.js";
import {
  attemptValidationRepair,
  computeChatCost,
  computeEmbeddingCost,
  emitRetryEvent,
  EmptyResponseError,
  extractJSON,
  failValidation,
  mergeTokenUsage,
  stringifyContentBlocks,
  throwIfAborted,
  tryParsePartialJSON,
  validateImageBlocks,
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
  type MessageContent,
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
   * Override pricing per modelId. Merged on top of the bundled `VERCEL_PRICING`
   * table (alpha.8+) which covers the OpenAI / Anthropic / Google models
   * commonly used via `@ai-sdk/*`. For provider/model combinations outside
   * the bundled table (LMStudio, OpenRouter, perplexity-ai, custom routes),
   * supply your own entries here.
   *
   * Pre-alpha.8 this option was REQUIRED. Now it's optional; users on the
   * common @ai-sdk/* providers can omit it.
   */
  pricing?: Record<string, ModelPricing>;
  /** Default validation strategy if the registry doesn't override per-call. */
  validationStrategy?: ValidationStrategy;
  /**
   * Maximum bytes per base64 image. Defaults to 20MB. Note: in v0.1 the
   * Vercel adapter degrades image blocks to `[image content]` placeholder
   * strings, so this primarily matters for the URL-form validation (rejecting
   * `file://`, etc.). When multi-modal lands in v0.2 the size check becomes
   * the primary gate.
   */
  imageSizeLimitBytes?: number;
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
  imageSizeLimitBytes: number;
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
  // alpha.8: merge bundled pricing with user overrides. User-supplied
  // entries win over bundled defaults. Matches the merge pattern in
  // adapter-openai / adapter-anthropic / adapter-google.
  const mergedPricing: Record<string, ModelPricing> = {
    ...VERCEL_PRICING,
    ...(opts.pricing ?? {}),
  };
  const ctx: AdapterContext = {
    models: opts.models ?? {},
    embeddingModels: opts.embeddingModels ?? {},
    pricing: mergedPricing,
    validationStrategy: opts.validationStrategy ?? {
      kind: "retry-with-feedback",
      maxAttempts: 2,
      includeOriginalError: true,
    },
    imageSizeLimitBytes: opts.imageSizeLimitBytes ?? 20 * 1024 * 1024,
    ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
  };

  return {
    name: "vercel",
    pricing: mergedPricing,
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
        // alpha.8: when the prompt has non-text blocks (image / audio), route
        // through Vercel's `messages` API with structured parts so the
        // multimodal payload actually reaches the underlying provider. For
        // text-only prompts, keep the simpler `prompt: string` path.
        const multimodal = hasMultimodalContent(options.prompt);
        const result = await generateWithStarvationRetry(ctx, alias, modelId, {
          model,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          ...(multimodal
            ? { messages: [{ role: "user" as const, content: toVercelParts(options.prompt) as never }] }
            : { prompt: stringifyContentBlocks(options.prompt) }),
          ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.signal ? { abortSignal: options.signal } : {}),
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
        try {
          const jsonInstruction = correctionPrompt
            ? correctionPrompt
            : "Reply with a single JSON object only. No prose, no code fences.";
          // alpha.8 multimodal: if the prompt has image/audio blocks, keep
          // them as structured parts + append the JSON instruction as a
          // final text part. For text-only, keep the simpler prompt-string
          // path with the instruction concatenated.
          const multimodal = hasMultimodalContent(options.prompt);
          const userPromptString = `${stringifyContentBlocks(options.prompt)}\n\n${jsonInstruction}`;
          const messagesShape = multimodal
            ? {
                messages: [
                  {
                    role: "user" as const,
                    content: [
                      ...toVercelParts(options.prompt),
                      { type: "text" as const, text: `\n\n${jsonInstruction}` },
                    ] as never,
                  },
                ],
              }
            : { prompt: userPromptString };
          const result = await generateWithStarvationRetry(ctx, alias, modelId, {
            model,
            ...(options.instructions !== undefined ? { system: options.instructions } : {}),
            ...messagesShape,
            temperature: options.temperature ?? 0,
            ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
            ...(options.signal ? { abortSignal: options.signal } : {}),
          });
          // Accumulate usage across retry-with-feedback rounds so cost
          // reporting reflects every SDK call, not just the final one.
          // Matches runAgent's mergeTokenUsage pattern.
          lastUsage = mergeTokenUsage(lastUsage, parseUsage(result));
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
          const decoded = extractJSON(result.text);
          let parsed = options.schema.safeParse(decoded);
          if (!parsed.success) {
            // Programmatic repair pass — catches the 6 common LLM output
            // quirks before paying for a retry-with-feedback round-trip.
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
      throwIfAborted(options.signal);
      validateContent(options.prompt);
      try {
        const multimodal = hasMultimodalContent(options.prompt);
        const stream = streamText({
          model,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          ...(multimodal
            ? { messages: [{ role: "user" as const, content: toVercelParts(options.prompt) as never }] }
            : { prompt: stringifyContentBlocks(options.prompt) }),
          ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.signal ? { abortSignal: options.signal } : {}),
        });
        for await (const chunk of stream.textStream) {
          yield chunk;
        }
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },

    async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
      throwIfAborted(options.signal);
      validateContent(options.prompt);
      try {
        const multimodal = hasMultimodalContent(options.prompt);
        const jsonHint = "\n\nReply with a single JSON object only. Stream the JSON progressively.";
        const messagesShape = multimodal
          ? {
              messages: [
                {
                  role: "user" as const,
                  content: [
                    ...toVercelParts(options.prompt),
                    { type: "text" as const, text: jsonHint },
                  ] as never,
                },
              ],
            }
          : { prompt: `${stringifyContentBlocks(options.prompt)}${jsonHint}` };
        const stream = streamText({
          model,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          ...messagesShape,
          ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
          temperature: options.temperature ?? 0,
          ...(options.signal ? { abortSignal: options.signal } : {}),
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
      // Multi-turn agent loop via Vercel AI SDK's native `tools` + `maxSteps`.
      // The SDK invokes tool `execute` functions between steps and feeds
      // results back to the model, looping until either:
      //   - The model emits text without tool calls (terminationReason="completed")
      //   - stepsTaken reaches maxSteps (terminationReason="max_steps")
      // alpha.8 upgraded this from the single-turn shim that v0.1 alpha.5
      // through alpha.7 shipped.
      throwIfAborted(options.signal);
      validateMessages(options.messages);
      const start = Date.now();
      try {
        // alpha.8: per-message multimodal handling. Text-only messages keep
        // the string-content path; messages with image/audio blocks become
        // structured parts arrays. Tool-role messages still degrade to text
        // (Vercel surfaces tool results through a separate "tool" role with
        // tool-result parts; we'd need adapter awareness of toolCallId
        // threading to wire that fully, which alpha.8 doesn't take on).
        const messages: CoreMessage[] = options.messages.map((m) => {
          const role = m.role === "tool" ? "user" : (m.role as "system" | "user" | "assistant");
          if (typeof m.content === "string") {
            return { role, content: m.content } as CoreMessage;
          }
          if (hasMultimodalContent(m.content)) {
            return {
              role,
              content: toVercelParts(m.content) as never,
            } as CoreMessage;
          }
          // Text-only ContentBlock[] — stringify is fine
          return { role, content: stringifyContentBlocks(m.content) } as CoreMessage;
        });
        const maxSteps = options.maxSteps ?? 10;
        // Translate llm-ports ToolDefinition[] → Vercel tools record.
        // Vercel's `tool({ description, parameters, execute })` wraps each
        // tool; the SDK invokes execute() between agent steps. We use
        // `Record<string, unknown>` for the tools map because Vercel's
        // inferred Tool union changes shape based on whether execute is
        // present; the simpler approach is to type-erase here and cast
        // when passing to generateText.
        const tools: Record<string, unknown> = {};
        for (const [name, def] of Object.entries(options.tools ?? {})) {
          tools[name] = tool({
            description: def.description,
            parameters: def.inputSchema,
            execute: async (input: unknown) => def.execute(input as never),
          });
        }
        const result = await generateText({
          model,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          messages,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
          ...(Object.keys(tools).length > 0 ? { tools: tools as never } : {}),
          maxSteps,
          ...(options.signal ? { abortSignal: options.signal } : {}),
        });
        // Aggregate usage across all steps. Vercel's `usage` on the top-level
        // result is the FINAL step's usage; we want the total. The `steps`
        // array carries per-step usage we can sum.
        const totalUsage: TokenUsage = aggregateStepsUsage(result.steps);
        // Map Vercel finishReason → llm-ports terminationReason. "stop" or
        // "end_turn" → completed; anything else (length, content-filter) at
        // maxSteps still means we ran out of budget → "max_steps".
        const finishReason = result.finishReason;
        const stepsTaken = result.steps.length;
        const terminationReason: AgentResult["terminationReason"] =
          finishReason === "stop" || finishReason === "tool-calls"
            ? "completed"
            : stepsTaken >= maxSteps
              ? "max_steps"
              : "completed";
        // Surface each tool call the model emitted across the agent loop.
        const toolCalls: AgentResult["toolCalls"] = result.steps.flatMap((step) => {
          // Vercel parameterizes StepResult<TOOLS>; we use `unknown` here
          // because the public API doesn't carry the user's tool typing
          // through. The runtime shape of toolCalls / toolResults matches
          // the documented Vercel SDK contract.
          const stepToolCalls = (step.toolCalls ?? []) as Array<{
            toolCallId: string;
            toolName: string;
            args: unknown;
          }>;
          const stepToolResults = (step.toolResults ?? []) as Array<{
            toolCallId: string;
            result: unknown;
          }>;
          return stepToolCalls.map((tc) => {
            const matching = stepToolResults.find((tr) => tr.toolCallId === tc.toolCallId);
            return {
              name: tc.toolName,
              input: (tc.args ?? {}) as Record<string, unknown>,
              output: matching?.result ?? null,
            };
          });
        });
        return {
          text: result.text,
          messages: options.messages, // we don't surface the intermediate vercel-shaped messages
          toolCalls,
          usage: totalUsage,
          cost: computeChatCost(totalUsage, pricing),
          modelId: result.response?.modelId ?? modelId,
          providerAlias: alias,
          latencyMs: Date.now() - start,
          stepsTaken,
          terminationReason,
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

/**
 * Sum per-step token usage across all agent loop iterations. Vercel's
 * top-level `result.usage` is the FINAL step's usage; for multi-turn agents
 * we want the cumulative total. Used by `runAgent` (alpha.8+).
 */
function aggregateStepsUsage(steps: ReadonlyArray<StepResult<never>>): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const step of steps) {
    const u = step.usage ?? {};
    inputTokens += u.promptTokens ?? 0;
    outputTokens += u.completionTokens ?? 0;
    totalTokens += u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
  }
  return { inputTokens, outputTokens, totalTokens };
}

