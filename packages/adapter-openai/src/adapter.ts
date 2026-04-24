/**
 * OpenAI adapter implementing LLMPort + EmbeddingsPort.
 *
 * Wraps the openai npm package's chat completions and embeddings APIs.
 * The same adapter serves OpenAI plus 10+ OpenAI-compatible providers
 * via the `baseURL` option (Azure OpenAI, Groq, Together AI, Fireworks AI,
 * DeepInfra, Perplexity, Cerebras, LiteLLM proxy, Ollama compat-mode, etc.).
 */

import OpenAI from "openai";
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
import { OPENAI_PRICING } from "./pricing.js";
import {
  fromOpenAIAssistantMessage,
  toOpenAIMessages,
  toOpenAIUserContent,
  type OpenAIMessage,
} from "./content.js";

// ─── Adapter options ─────────────────────────────────────────────────

export interface OpenAIAdapterOptions {
  apiKey: string;
  /**
   * Override the API base URL. Use this for OpenAI-compatible providers:
   *   - Azure OpenAI: `https://<resource>.openai.azure.com/openai/deployments/<deployment>`
   *   - Groq: `https://api.groq.com/openai/v1`
   *   - Together AI: `https://api.together.xyz/v1`
   *   - Fireworks AI: `https://api.fireworks.ai/inference/v1`
   *   - DeepInfra: `https://api.deepinfra.com/v1/openai`
   *   - Perplexity: `https://api.perplexity.ai`
   *   - Cerebras: `https://api.cerebras.ai/v1`
   *   - LiteLLM proxy: self-hosted, e.g. `http://localhost:4000`
   *   - Ollama compat-mode: `http://localhost:11434/v1` (prefer adapter-ollama)
   */
  baseURL?: string;
  /** Inject a custom fetch (used for tests / proxies). */
  fetch?: typeof fetch;
  /** Default validation strategy if the registry doesn't override per-call. */
  validationStrategy?: ValidationStrategy;
  /** Override pricing for any model id. Falls back to bundled OPENAI_PRICING. */
  pricingOverrides?: Record<string, ModelPricing>;
  /**
   * Friendly name for the adapter to use in error messages and providerAlias
   * default. Useful when you point this adapter at a non-OpenAI baseURL and
   * want errors to say "groq" instead of "openai". The adapter token in env
   * config still says "openai" because that's the SDK shape.
   */
  displayName?: string;
}

// ─── Internal context ────────────────────────────────────────────────

interface AdapterContext {
  client: OpenAI;
  validationStrategy: ValidationStrategy;
  pricingOverrides: Record<string, ModelPricing>;
}

function makeClient(opts: OpenAIAdapterOptions): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.fetch ? { fetch: opts.fetch as OpenAI["fetch"] } : {}),
  });
}

function pricingFor(ctx: AdapterContext, modelId: string): ModelPricing {
  const pricing = ctx.pricingOverrides[modelId] ?? OPENAI_PRICING[modelId];
  if (!pricing) {
    throw new Error(
      `No pricing entry for OpenAI model "${modelId}". Provide pricingOverrides or update src/pricing.ts.`,
    );
  }
  return pricing;
}

// ─── Public factory ──────────────────────────────────────────────────

export interface OpenAIAdapter {
  name: "openai";
  pricing: Record<string, ModelPricing>;
  createLLMPort: (modelId: string, alias: string) => LLMPort;
  createEmbeddingsPort: (modelId: string, alias: string) => EmbeddingsPort;
}

export function createOpenAIAdapter(opts: OpenAIAdapterOptions): OpenAIAdapter {
  const ctx: AdapterContext = {
    client: makeClient(opts),
    validationStrategy: opts.validationStrategy ?? {
      kind: "retry-with-feedback",
      maxAttempts: 2,
      includeOriginalError: true,
    },
    pricingOverrides: opts.pricingOverrides ?? {},
  };

  return {
    name: "openai",
    pricing: OPENAI_PRICING,
    createLLMPort: (modelId, alias) => createPort(ctx, modelId, alias),
    createEmbeddingsPort: (modelId, alias) => createEmbeddings(ctx, modelId, alias),
  };
}

// ─── LLMPort implementation ──────────────────────────────────────────

function createPort(ctx: AdapterContext, modelId: string, alias: string): LLMPort {
  const pricing = pricingFor(ctx, modelId);

  return {
    async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
      const start = Date.now();
      try {
        const messages: OpenAIMessage[] = [];
        if (options.instructions !== undefined) {
          messages.push({ role: "system", content: options.instructions });
        }
        messages.push({
          role: "user",
          content: toOpenAIUserContent(options.prompt),
        });
        const response = await ctx.client.chat.completions.create({
          model: modelId,
          messages: messages as never,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxOutputTokens !== undefined ? { max_completion_tokens: options.maxOutputTokens } : {}),
          stream: false,
        });
        const usage = parseUsage(response);
        const text = response.choices[0]?.message.content ?? "";
        return {
          text,
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
          const messages: OpenAIMessage[] = [];
          if (options.instructions !== undefined) {
            messages.push({ role: "system", content: options.instructions });
          }
          const userText = correctionPrompt
            ? `${stringifyPrompt(options.prompt)}\n\n${correctionPrompt}`
            : `${stringifyPrompt(options.prompt)}\n\nReply with a single JSON object only. No prose, no code fences.`;
          messages.push({ role: "user", content: userText });

          const response = await ctx.client.chat.completions.create({
            model: modelId,
            messages: messages as never,
            temperature: options.temperature ?? 0,
            ...(options.maxOutputTokens !== undefined
              ? { max_completion_tokens: options.maxOutputTokens }
              : {}),
            // OpenAI native JSON mode improves reliability of valid JSON.
            response_format: { type: "json_object" },
            stream: false,
          });
          lastUsage = parseUsage(response);
          lastModelId = response.model ?? modelId;
          const raw = response.choices[0]?.message.content ?? "";
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
        const messages: OpenAIMessage[] = [];
        if (options.instructions !== undefined) {
          messages.push({ role: "system", content: options.instructions });
        }
        messages.push({
          role: "user",
          content: toOpenAIUserContent(options.prompt),
        });
        const stream = await ctx.client.chat.completions.create({
          model: modelId,
          messages: messages as never,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxOutputTokens !== undefined ? { max_completion_tokens: options.maxOutputTokens } : {}),
          stream: true,
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            yield delta;
          }
        }
      } catch (err) {
        throw wrapError(alias, err);
      }
    },

    async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
      try {
        const messages: OpenAIMessage[] = [];
        if (options.instructions !== undefined) {
          messages.push({ role: "system", content: options.instructions });
        }
        messages.push({
          role: "user",
          content: `${stringifyPrompt(options.prompt)}\n\nReply with a single JSON object only. Stream the JSON progressively.`,
        });
        const stream = await ctx.client.chat.completions.create({
          model: modelId,
          messages: messages as never,
          temperature: options.temperature ?? 0,
          ...(options.maxOutputTokens !== undefined ? { max_completion_tokens: options.maxOutputTokens } : {}),
          response_format: { type: "json_object" },
          stream: true,
        });
        let buffer = "";
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (typeof delta !== "string") continue;
          buffer += delta;
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
        for (let step = 0; step < maxSteps; step++) {
          stepsTaken = step + 1;
          const messages: OpenAIMessage[] = [];
          if (options.instructions) {
            messages.push({ role: "system", content: options.instructions });
          }
          messages.push(...toOpenAIMessages(conversation));

          const response = await ctx.client.chat.completions.create({
            model: modelId,
            messages: messages as never,
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.maxOutputTokens !== undefined ? { max_completion_tokens: options.maxOutputTokens } : {}),
            tools: toOpenAITools(options.tools),
            stream: false,
          });
          totalUsage = mergeUsage(totalUsage, parseUsage(response));
          lastModelId = response.model ?? modelId;

          const aMsg = response.choices[0]?.message;
          if (!aMsg) {
            terminationReason = "completed";
            break;
          }
          // Append the assistant message to the conversation
          conversation.push({
            role: "assistant",
            content: fromOpenAIAssistantMessage({
              content: aMsg.content,
              ...(aMsg.tool_calls ? { tool_calls: aMsg.tool_calls as never } : {}),
            }),
          });

          finalText = aMsg.content ?? "";

          const calls = aMsg.tool_calls ?? [];
          if (calls.length === 0) {
            terminationReason = "completed";
            break;
          }

          const toolResults: ContentBlock[] = [];
          for (const tc of calls) {
            const def = options.tools[tc.function.name];
            if (!def) {
              toolResults.push({
                type: "tool_result",
                toolUseId: tc.id,
                content: `Tool "${tc.function.name}" not found.`,
                isError: true,
              });
              continue;
            }
            try {
              const args = tc.function.arguments
                ? JSON.parse(tc.function.arguments)
                : {};
              const output = await def.execute(args as never);
              toolCalls.push({
                name: tc.function.name,
                input: args as Record<string, unknown>,
                output,
              });
              const text = typeof output === "string" ? output : JSON.stringify(output);
              const truncated =
                def.maxOutputBytes !== undefined && text.length > def.maxOutputBytes
                  ? `${text.slice(0, def.maxOutputBytes)}\n[truncated]`
                  : text;
              toolResults.push({
                type: "tool_result",
                toolUseId: tc.id,
                content: truncated,
              });
            } catch (toolErr) {
              toolResults.push({
                type: "tool_result",
                toolUseId: tc.id,
                content: toolErr instanceof Error ? toolErr.message : String(toolErr),
                isError: true,
              });
            }
          }
          // Tool results go in via the standard tool role conversion
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
        const response = await ctx.client.embeddings.create({
          model: modelId,
          input: options.input,
        });
        const inputTokens = response.usage?.prompt_tokens ?? 0;
        const vector = response.data[0]?.embedding ?? [];
        return {
          vector,
          dimensions: vector.length,
          modelId: response.model ?? modelId,
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
        const response = await ctx.client.embeddings.create({
          model: modelId,
          input: options.inputs,
        });
        const inputTokens = response.usage?.prompt_tokens ?? 0;
        const vectors = response.data.map((d) => d.embedding);
        return {
          vectors,
          dimensions: vectors[0]?.length ?? 0,
          modelId: response.model ?? modelId,
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

function parseUsage(response: {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}): TokenUsage {
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  const cached = response.usage?.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cached !== undefined && cached > 0 ? { cacheReadTokens: cached } : {}),
  };
}

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }
      : {}),
  };
}

function wrapError(alias: string, err: unknown): Error {
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

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  };
}

function toOpenAITools(tools: Record<string, ToolDefinition>): OpenAITool[] {
  return Object.entries(tools).map(([name, def]) => ({
    type: "function",
    function: {
      name,
      description: def.description,
      parameters: zodToParameters(def.inputSchema),
    },
  }));
}

/**
 * Minimal Zod-to-JSONSchema for v0.1. Same caveat as adapter-anthropic.
 * Most users will pass `z.object({...})`, which we approximate as
 * `{ type: "object", properties: {} }`. For richer schema generation,
 * users can wire in `zod-to-json-schema`.
 */
function zodToParameters(_schema: unknown): {
  type: "object";
  properties: Record<string, unknown>;
} {
  return { type: "object", properties: {} };
}
