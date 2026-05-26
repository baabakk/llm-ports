/**
 * Ollama adapter implementing LLMPort + EmbeddingsPort + ModelManagement.
 *
 * Talks to a local Ollama daemon via the official `ollama` npm package.
 * The same node binary that runs the LLM also serves embeddings, model
 * management (list/pull/delete), and a health endpoint.
 *
 * Local models are zero-cost by default; budget gating typically defaults
 * to "unlimited" for ollama aliases in env config.
 */

import { Ollama } from "ollama";
import {
  attemptValidationRepair,
  computeChatCost,
  computeEmbeddingCost,
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
  type ContentBlock,
  type MessageContent,
  type EmbeddingOptions,
  type EmbeddingResult,
  type EmbeddingsPort,
  type GenerateStructuredOptions,
  type GenerateStructuredResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
  type ProviderModelInfo,
  type RunAgentOptions,
  type StreamStructuredOptions,
  type StreamTextOptions,
  type ToolDefinition,
  type TokenUsage,
  type ValidationStrategy,
} from "@llm-ports/core";
import { OLLAMA_DEFAULT_PRICING, OLLAMA_PRICING } from "./pricing.js";
import {
  fromOllamaAssistantMessage,
  toOllamaMessages,
  type OllamaMessage,
} from "./content.js";

// ─── Adapter options ─────────────────────────────────────────────────

export interface OllamaAdapterOptions {
  /** Ollama daemon URL. Default: "http://localhost:11434" */
  baseURL?: string;
  /** Auto-pull models on first use if not already present locally. Default: false */
  autoPull?: boolean;
  /** Keep-alive duration (controls VRAM retention). Default: "5m" */
  keepAlive?: string;
  /** Default validation strategy if the registry doesn't override per-call. */
  validationStrategy?: ValidationStrategy;
  /** Override pricing for any model id. Falls back to OLLAMA_PRICING then DEFAULT (zero-cost). */
  pricingOverrides?: Record<string, ModelPricing>;
  /**
   * Maximum bytes per base64 image. Ollama itself doesn't enforce a limit
   * (it's model-dependent: LLaVA tolerates ~1500×1500 px, others vary).
   * Defaults to undefined (no size check). Set explicitly if you want
   * client-side enforcement.
   */
  imageSizeLimitBytes?: number;
}

// ─── ModelManagement interface implementation ────────────────────────

export interface OllamaModelInfo {
  name: string;
  /** Size in bytes. */
  size: number;
  /** ISO timestamp string for when the model was last modified locally. */
  modifiedAt: string;
  digest: string;
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
}

// ─── Internal context ────────────────────────────────────────────────

interface AdapterContext {
  client: Ollama;
  validationStrategy: ValidationStrategy;
  pricingOverrides: Record<string, ModelPricing>;
  autoPull: boolean;
  keepAlive: string;
  pulled: Set<string>;
  /** undefined = no size check (Ollama default — model-dependent). */
  imageSizeLimitBytes?: number;
}

function pricingFor(ctx: AdapterContext, modelId: string): ModelPricing {
  return (
    ctx.pricingOverrides[modelId] ??
    OLLAMA_PRICING[modelId] ??
    OLLAMA_DEFAULT_PRICING
  );
}

async function ensurePulled(ctx: AdapterContext, modelId: string): Promise<void> {
  if (!ctx.autoPull || ctx.pulled.has(modelId)) return;
  try {
    const list = await ctx.client.list();
    const present = list.models.some((m) => m.name === modelId || m.name.startsWith(`${modelId}:`));
    if (!present) {
      await ctx.client.pull({ model: modelId });
    }
    ctx.pulled.add(modelId);
  } catch {
    // If list/pull fails, let the subsequent chat call surface the real error.
  }
}

// ─── Public factory ──────────────────────────────────────────────────

export interface OllamaAdapter {
  name: "ollama";
  pricing: Record<string, ModelPricing>;
  createLLMPort: (modelId: string, alias: string) => LLMPort;
  createEmbeddingsPort: (modelId: string, alias: string) => EmbeddingsPort;
  /** ModelManagement methods at the adapter level (not per-model). */
  listModels: () => Promise<OllamaModelInfo[]>;
  pullModel: (modelId: string, onProgress?: (pct: number) => void) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  checkHealth: () => Promise<{ ok: boolean; latencyMs: number }>;
}

export function createOllamaAdapter(opts: OllamaAdapterOptions = {}): OllamaAdapter {
  const ctx: AdapterContext = {
    client: new Ollama({ host: opts.baseURL ?? "http://localhost:11434" }),
    validationStrategy: opts.validationStrategy ?? {
      kind: "retry-with-feedback",
      maxAttempts: 2,
      includeOriginalError: true,
    },
    pricingOverrides: opts.pricingOverrides ?? {},
    autoPull: opts.autoPull ?? false,
    keepAlive: opts.keepAlive ?? "5m",
    pulled: new Set(),
    ...(opts.imageSizeLimitBytes !== undefined
      ? { imageSizeLimitBytes: opts.imageSizeLimitBytes }
      : {}),
  };

  return {
    name: "ollama",
    pricing: OLLAMA_PRICING,
    createLLMPort: (modelId, alias) => createPort(ctx, modelId, alias),
    createEmbeddingsPort: (modelId, alias) => createEmbeddings(ctx, modelId, alias),

    async listModels(): Promise<OllamaModelInfo[]> {
      const result = await ctx.client.list();
      return result.models.map((m) => ({
        name: m.name,
        size: m.size,
        modifiedAt: typeof m.modified_at === "string" ? m.modified_at : m.modified_at.toISOString(),
        digest: m.digest,
        ...(m.details?.family ? { family: m.details.family } : {}),
        ...(m.details?.parameter_size ? { parameterSize: m.details.parameter_size } : {}),
        ...(m.details?.quantization_level ? { quantizationLevel: m.details.quantization_level } : {}),
      }));
    },

    async pullModel(modelId, onProgress) {
      const stream = await ctx.client.pull({ model: modelId, stream: true });
      for await (const event of stream) {
        if (onProgress && event.total && event.completed) {
          onProgress(Math.floor((event.completed / event.total) * 100));
        }
      }
      ctx.pulled.add(modelId);
    },

    async deleteModel(modelId) {
      await ctx.client.delete({ model: modelId });
      ctx.pulled.delete(modelId);
    },

    async checkHealth() {
      const start = Date.now();
      try {
        await ctx.client.list();
        return { ok: true, latencyMs: Date.now() - start };
      } catch {
        return { ok: false, latencyMs: Date.now() - start };
      }
    },
  };
}

// ─── LLMPort implementation ──────────────────────────────────────────

function createPort(ctx: AdapterContext, modelId: string, alias: string): LLMPort {
  const pricing = pricingFor(ctx, modelId);

  // Image-block validation closure. Ollama has no built-in size limit
  // (model-dependent), but if the caller set imageSizeLimitBytes the check
  // fires. URL-form images are always rejected (Ollama doesn't fetch URLs).
  const validateContent = (content: MessageContent): void => {
    if (Array.isArray(content)) {
      validateImageBlocks(content, {
        alias,
        ...(ctx.imageSizeLimitBytes !== undefined && ctx.imageSizeLimitBytes > 0
          ? { limitBytes: ctx.imageSizeLimitBytes }
          : {}),
      });
    }
  };
  const validateMessages = (messages: ReadonlyArray<{ content: MessageContent }>): void => {
    for (const msg of messages) validateContent(msg.content);
  };

  // Ollama caveat: the ollama-js SDK does NOT accept a per-call AbortSignal.
  // Its `Ollama.abort()` method cancels ALL in-flight requests on the client,
  // which is too coarse for per-call cancellation. We honor `options.signal`
  // at entry (throwIfAborted) but cannot cancel a request once it's flying.
  // Mid-flight cancellation here lands when ollama-js exposes a per-request
  // signal — tracked at https://github.com/ollama/ollama-js/issues for v0.7+.

  return {
    async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
      throwIfAborted(options.signal);
      validateContent(options.prompt);
      const start = Date.now();
      try {
        await ensurePulled(ctx, modelId);
        const messages: OllamaMessage[] = [];
        if (options.instructions !== undefined) {
          messages.push({ role: "system", content: options.instructions });
        }
        messages.push(
          ...toOllamaMessages([
            { role: "user", content: options.prompt },
          ]),
        );

        const response = await ctx.client.chat({
          model: modelId,
          messages,
          stream: false,
          keep_alive: ctx.keepAlive,
          options: {
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.maxOutputTokens !== undefined ? { num_predict: options.maxOutputTokens } : {}),
          },
        });
        const usage = parseUsage(response);
        return {
          text: response.message?.content ?? "",
          usage,
          cost: computeChatCost(usage, pricing),
          modelId: response.model ?? modelId,
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
          await ensurePulled(ctx, modelId);
          const messages: OllamaMessage[] = [];
          if (options.instructions !== undefined) {
            messages.push({ role: "system", content: options.instructions });
          }
          const userText = correctionPrompt
            ? `${stringifyContentBlocks(options.prompt)}\n\n${correctionPrompt}`
            : `${stringifyContentBlocks(options.prompt)}\n\nReply with a single JSON object only.`;
          messages.push({ role: "user", content: userText });

          const response = await ctx.client.chat({
            model: modelId,
            messages,
            stream: false,
            // Ollama supports `format: "json"` to coerce JSON output
            format: "json",
            keep_alive: ctx.keepAlive,
            options: {
              temperature: options.temperature ?? 0,
              ...(options.maxOutputTokens !== undefined ? { num_predict: options.maxOutputTokens } : {}),
            },
          });
          lastUsage = parseUsage(response);
          lastModelId = response.model ?? modelId;
          const raw = response.message?.content ?? "";
          const decoded = extractJSON(raw);
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
        await ensurePulled(ctx, modelId);
        const messages: OllamaMessage[] = [];
        if (options.instructions !== undefined) {
          messages.push({ role: "system", content: options.instructions });
        }
        messages.push(
          ...toOllamaMessages([{ role: "user", content: options.prompt }]),
        );
        const stream = await ctx.client.chat({
          model: modelId,
          messages,
          stream: true,
          keep_alive: ctx.keepAlive,
          options: {
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.maxOutputTokens !== undefined ? { num_predict: options.maxOutputTokens } : {}),
          },
        });
        for await (const chunk of stream) {
          const text = chunk.message?.content;
          if (typeof text === "string" && text.length > 0) yield text;
        }
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },

    async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
      throwIfAborted(options.signal);
      validateContent(options.prompt);
      try {
        await ensurePulled(ctx, modelId);
        const messages: OllamaMessage[] = [];
        if (options.instructions !== undefined) {
          messages.push({ role: "system", content: options.instructions });
        }
        messages.push({
          role: "user",
          content: `${stringifyContentBlocks(options.prompt)}\n\nReply with a single JSON object only. Stream the JSON progressively.`,
        });
        const stream = await ctx.client.chat({
          model: modelId,
          messages,
          stream: true,
          format: "json",
          keep_alive: ctx.keepAlive,
          options: {
            temperature: options.temperature ?? 0,
            ...(options.maxOutputTokens !== undefined ? { num_predict: options.maxOutputTokens } : {}),
          },
        });
        let buffer = "";
        for await (const chunk of stream) {
          const text = chunk.message?.content;
          if (typeof text !== "string") continue;
          buffer += text;
          const partial = tryParsePartialJSON(buffer) as Partial<T> | null;
          if (partial !== null) yield partial;
        }
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },

    async runAgent(options: RunAgentOptions): Promise<AgentResult> {
      throwIfAborted(options.signal);
      validateMessages(options.messages);
      const start = Date.now();
      const maxSteps = options.maxSteps ?? 10;
      const conversation = [...options.messages];
      const toolCalls: AgentResult["toolCalls"] = [];
      let stepsTaken = 0;
      let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let finalText = "";
      let lastModelId = modelId;
      let terminationReason: AgentResult["terminationReason"] = "max_steps";

      try {
        await ensurePulled(ctx, modelId);
        for (let step = 0; step < maxSteps; step++) {
          throwIfAborted(options.signal);
          stepsTaken = step + 1;
          const messages: OllamaMessage[] = [];
          if (options.instructions) {
            messages.push({ role: "system", content: options.instructions });
          }
          messages.push(...toOllamaMessages(conversation));

          const response = await ctx.client.chat({
            model: modelId,
            messages,
            stream: false,
            tools: toOllamaTools(options.tools),
            keep_alive: ctx.keepAlive,
            options: {
              ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
              ...(options.maxOutputTokens !== undefined ? { num_predict: options.maxOutputTokens } : {}),
            },
          });
          totalUsage = mergeTokenUsage(totalUsage, parseUsage(response));
          lastModelId = response.model ?? modelId;
          const aMsg = response.message;
          if (!aMsg) {
            terminationReason = "completed";
            break;
          }
          conversation.push({
            role: "assistant",
            content: fromOllamaAssistantMessage({
              ...(aMsg.content !== undefined ? { content: aMsg.content } : {}),
              ...(aMsg.tool_calls ? { tool_calls: aMsg.tool_calls } : {}),
            }),
          });
          finalText = aMsg.content ?? "";

          const calls = aMsg.tool_calls ?? [];
          if (calls.length === 0) {
            terminationReason = "completed";
            break;
          }

          const toolResults: ContentBlock[] = [];
          for (let i = 0; i < calls.length; i++) {
            const tc = calls[i]!;
            const toolUseId = `ollama-tool-${i}`;
            const def = options.tools[tc.function.name];
            if (!def) {
              toolResults.push({
                type: "tool_result",
                toolUseId,
                content: `Tool "${tc.function.name}" not found.`,
                isError: true,
              });
              continue;
            }
            try {
              const output = await def.execute(tc.function.arguments as never);
              toolCalls.push({
                name: tc.function.name,
                input: tc.function.arguments,
                output,
              });
              const text = typeof output === "string" ? output : JSON.stringify(output);
              const truncated =
                def.maxOutputBytes !== undefined && text.length > def.maxOutputBytes
                  ? `${text.slice(0, def.maxOutputBytes)}\n[truncated]`
                  : text;
              toolResults.push({
                type: "tool_result",
                toolUseId,
                content: truncated,
              });
            } catch (toolErr) {
              toolResults.push({
                type: "tool_result",
                toolUseId,
                content: toolErr instanceof Error ? toolErr.message : String(toolErr),
                isError: true,
              });
            }
          }
          conversation.push({ role: "user", content: toolResults });
        }
      } catch (err) {
        throw wrapProviderError(alias, err);
      }

      return {
        text: finalText,
        messages: conversation,
        toolCalls,
        usage: totalUsage,
        cost: computeChatCost(totalUsage, pricing),
        modelId: lastModelId,
        providerAlias: alias,
        latencyMs: Date.now() - start,
        stepsTaken,
        terminationReason,
      };
    },

    async listModels(): Promise<ProviderModelInfo[]> {
      try {
        const result = await ctx.client.list();
        // Ollama is local-only and doesn't have a "pricing" concept — every
        // model is free (modulo electricity). We still report id + size so
        // checkPricingFreshness can detect "model is in bundled table but
        // no longer present locally".
        return result.models.map((m) => ({
          id: m.name,
          metadata: {
            size: m.size,
            modified_at: m.modified_at,
            ...("digest" in m ? { digest: (m as { digest: string }).digest } : {}),
          },
        }));
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
    },
  };
}

// ─── EmbeddingsPort implementation ───────────────────────────────────

function createEmbeddings(
  ctx: AdapterContext,
  modelId: string,
  alias: string,
): EmbeddingsPort {
  const pricing = pricingFor(ctx, modelId);
  return {
    async generateEmbedding(options: EmbeddingOptions): Promise<EmbeddingResult> {
      const start = Date.now();
      try {
        await ensurePulled(ctx, modelId);
        const response = await ctx.client.embed({ model: modelId, input: options.input });
        const vector = response.embeddings[0] ?? [];
        // Ollama returns embeddings without a token count; estimate inputTokens.
        const inputTokens = estimateTokens(options.input);
        return {
          vector,
          dimensions: vector.length,
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
      try {
        await ensurePulled(ctx, modelId);
        const response = await ctx.client.embed({ model: modelId, input: options.inputs });
        const vectors = response.embeddings;
        const inputTokens = options.inputs.reduce((sum, t) => sum + estimateTokens(t), 0);
        return {
          vectors,
          dimensions: vectors[0]?.length ?? 0,
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

interface OllamaChatResponse {
  model?: string;
  message?: {
    content?: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

function parseUsage(response: OllamaChatResponse): TokenUsage {
  const inputTokens = response.prompt_eval_count ?? 0;
  const outputTokens = response.eval_count ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

interface OllamaToolParameterProperty {
  type?: string | string[];
  items?: unknown;
  description?: string;
  enum?: unknown[];
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, OllamaToolParameterProperty>;
      required?: string[];
    };
  };
}

function toOllamaTools(tools: Record<string, ToolDefinition>): OllamaTool[] {
  return Object.entries(tools).map(([name, def]) => ({
    type: "function",
    function: {
      name,
      description: def.description,
      parameters: { type: "object", properties: {} as Record<string, OllamaToolParameterProperty> },
    },
  }));
}

/** Crude token estimator (~4 chars per token) for Ollama embeddings. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
