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
  computeChatCost,
  computeEmbeddingCost,
  failValidation,
  ProviderUnavailableError,
  type AgentResult,
  type BatchEmbeddingOptions,
  type BatchEmbeddingResult,
  type ContentBlock,
  type EmbeddingOptions,
  type EmbeddingResult,
  type EmbeddingsPort,
  type GenerateStructuredOptions,
  type GenerateStructuredResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
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

  return {
    async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
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
        throw wrapError(alias, err);
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
          await ensurePulled(ctx, modelId);
          const messages: OllamaMessage[] = [];
          if (options.instructions !== undefined) {
            messages.push({ role: "system", content: options.instructions });
          }
          const userText = correctionPrompt
            ? `${stringifyPrompt(options.prompt)}\n\n${correctionPrompt}`
            : `${stringifyPrompt(options.prompt)}\n\nReply with a single JSON object only.`;
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
          const parsed = options.schema.safeParse(extractJSON(raw));
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
          throw wrapError(alias, err);
        }
      }
      throw new Error("generateStructured exhausted attempts");
    },

    async *streamText(options: StreamTextOptions): AsyncIterable<string> {
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
        throw wrapError(alias, err);
      }
    },

    async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
      try {
        await ensurePulled(ctx, modelId);
        const messages: OllamaMessage[] = [];
        if (options.instructions !== undefined) {
          messages.push({ role: "system", content: options.instructions });
        }
        messages.push({
          role: "user",
          content: `${stringifyPrompt(options.prompt)}\n\nReply with a single JSON object only. Stream the JSON progressively.`,
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
        throw wrapError(alias, err);
      }
    },

    async runAgent(options: RunAgentOptions): Promise<AgentResult> {
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
          totalUsage = mergeUsage(totalUsage, parseUsage(response));
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
        throw wrapError(alias, err);
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
        throw wrapError(alias, err);
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
        throw wrapError(alias, err);
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

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function wrapError(alias: string, err: unknown): Error {
  // Idempotent: don't double-wrap framework errors that are already typed.
  if (err instanceof ProviderUnavailableError) {
    return err;
  }
  if (err instanceof Error && err.name === "ValidationError") {
    return err;
  }
  if (err instanceof Error) {
    return new ProviderUnavailableError(alias, err);
  }
  return new ProviderUnavailableError(alias, new Error(String(err)));
}

function stringifyPrompt(content: GenerateTextOptions["prompt"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[image content]";
      if (block.type === "tool_use") return `[tool_use ${block.name}]`;
      if (block.type === "tool_result") return `[tool_result for ${block.toolUseId}]`;
      return "[non-text block]";
    })
    .join("\n");
}

function extractJSON(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return JSON.parse(candidate);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function tryParsePartialJSON(buffer: string): unknown | null {
  try {
    const start = buffer.indexOf("{");
    if (start === -1) return null;
    return JSON.parse(buffer.slice(start));
  } catch {
    let opens = 0;
    let closes = 0;
    let opensq = 0;
    let closesq = 0;
    for (const ch of buffer) {
      if (ch === "{") opens++;
      else if (ch === "}") closes++;
      else if (ch === "[") opensq++;
      else if (ch === "]") closesq++;
    }
    let attempt =
      buffer +
      "}".repeat(Math.max(0, opens - closes)) +
      "]".repeat(Math.max(0, opensq - closesq));
    attempt = attempt.replace(/,\s*([}\]])/g, "$1");
    try {
      const start = attempt.indexOf("{");
      if (start === -1) return null;
      return JSON.parse(attempt.slice(start));
    } catch {
      return null;
    }
  }
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
