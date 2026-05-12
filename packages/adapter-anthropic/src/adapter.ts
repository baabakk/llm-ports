/**
 * Anthropic adapter implementing LLMPort.
 *
 * Wraps @anthropic-ai/sdk's Messages API. Supports vision, tool use, and
 * Anthropic's prompt caching. Audio input/output is not supported by Anthropic
 * and will throw ContentBlockUnsupportedError if attempted.
 *
 * The adapter does NOT implement EmbeddingsPort because Anthropic does not
 * ship embedding models.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  computeChatCost,
  failValidation,
  ProviderUnavailableError,
  type AgentResult,
  type ContentBlock,
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
import { ANTHROPIC_PRICING } from "./pricing.js";
import {
  extractAssistantText,
  fromAnthropicContent,
  toAnthropicContent,
  toAnthropicMessages,
} from "./content.js";

// ─── Adapter options ─────────────────────────────────────────────────

export interface AnthropicAdapterOptions {
  apiKey: string;
  /** Override base URL (typically only useful for testing). */
  baseURL?: string;
  /** Inject a custom fetch (used for tests / proxies). */
  fetch?: typeof fetch;
  /** Default validation strategy if the registry doesn't override per-call. */
  validationStrategy?: ValidationStrategy;
  /** Override Anthropic pricing for any model id. Falls back to the bundled table. */
  pricingOverrides?: Record<string, ModelPricing>;
}

// ─── Module-level state ──────────────────────────────────────────────

interface AdapterContext {
  client: Anthropic;
  validationStrategy: ValidationStrategy;
  pricingOverrides: Record<string, ModelPricing>;
}

function makeClient(opts: AnthropicAdapterOptions): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.fetch ? { fetch: opts.fetch as Anthropic["fetch"] } : {}),
  });
}

function pricingFor(ctx: AdapterContext, modelId: string): ModelPricing {
  const pricing = ctx.pricingOverrides[modelId] ?? ANTHROPIC_PRICING[modelId];
  if (!pricing) {
    throw new Error(
      `No pricing entry for Anthropic model "${modelId}". Provide pricingOverrides or update src/pricing.ts.`,
    );
  }
  return pricing;
}

// ─── Public factory: create the adapter container ────────────────────

export interface AnthropicAdapter {
  name: "anthropic";
  pricing: Record<string, ModelPricing>;
  createLLMPort: (modelId: string, alias: string) => LLMPort;
}

export function createAnthropicAdapter(opts: AnthropicAdapterOptions): AnthropicAdapter {
  // Merge user-supplied pricingOverrides into the adapter's exposed pricing
  // so the registry's pricing check sees them. (See same-named comment in
  // adapter-openai/adapter.ts for the rationale.)
  const mergedPricing: Record<string, ModelPricing> = {
    ...ANTHROPIC_PRICING,
    ...(opts.pricingOverrides ?? {}),
  };

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
    name: "anthropic",
    pricing: mergedPricing,
    createLLMPort: (modelId, alias) => createPort(ctx, modelId, alias),
  };
}

// ─── The port implementation ─────────────────────────────────────────

function createPort(ctx: AdapterContext, modelId: string, alias: string): LLMPort {
  const pricing = pricingFor(ctx, modelId);

  return {
    async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
      const start = Date.now();
      try {
        const response = await ctx.client.messages.create({
          model: modelId,
          max_tokens: options.maxOutputTokens ?? 1024,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          messages: [
            {
              role: "user",
              content: toAnthropicContent(options.prompt) as never,
            },
          ],
        });
        const usage = parseUsage(response);
        const text = extractAssistantText(response.content as never);
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
      // Build the structured-output prompt by appending the schema instructions
      // to the user content. Many production users would use Anthropic's "tool"
      // pattern for structured output; for v0.1 we use the simpler prompted JSON
      // approach plus retry-with-feedback. Tool-mode can be added later.
      const start = Date.now();
      let attempts = 0;
      let lastErr: Error | null = null;
      const maxAttempts =
        ctx.validationStrategy.kind === "retry-with-feedback"
          ? ctx.validationStrategy.maxAttempts
          : 1;

      // We accumulate assistant correction prompts when retrying.
      let correctionPrompt: string | null = null;
      let lastUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let lastModelId = modelId;

      while (attempts < maxAttempts) {
        attempts++;
        try {
          const userContent = correctionPrompt
            ? `${stringifyPrompt(options.prompt)}\n\n${correctionPrompt}`
            : `${stringifyPrompt(options.prompt)}\n\nReply with a single JSON object that matches the requested schema. Do not include any prose, explanation, or code fences — only the JSON.`;

          const response = await ctx.client.messages.create({
            model: modelId,
            max_tokens: options.maxOutputTokens ?? 2048,
            ...(options.instructions !== undefined ? { system: options.instructions } : {}),
            temperature: options.temperature ?? 0,
            messages: [{ role: "user", content: userContent }],
          });
          lastUsage = parseUsage(response);
          lastModelId = response.model ?? modelId;
          const raw = extractAssistantText(response.content as never);
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
          if (err instanceof Error) lastErr = err;
          throw wrapError(alias, err);
        }
      }
      // Unreachable in practice; failValidation throws above.
      throw lastErr ?? new Error("generateStructured exhausted attempts");
    },

    async *streamText(options: StreamTextOptions): AsyncIterable<string> {
      try {
        const stream = ctx.client.messages.stream({
          model: modelId,
          max_tokens: options.maxOutputTokens ?? 1024,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          messages: [
            {
              role: "user",
              content: toAnthropicContent(options.prompt) as never,
            },
          ],
        });
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield event.delta.text;
          }
        }
      } catch (err) {
        throw wrapError(alias, err);
      }
    },

    async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
      // Anthropic doesn't stream parsed JSON natively. We accumulate text deltas
      // and best-effort parse a partial JSON object after each chunk.
      try {
        const stream = ctx.client.messages.stream({
          model: modelId,
          max_tokens: options.maxOutputTokens ?? 2048,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          temperature: options.temperature ?? 0,
          messages: [
            {
              role: "user",
              content: `${stringifyPrompt(options.prompt)}\n\nReply with a single JSON object that matches the requested schema. Stream the JSON progressively.`,
            },
          ],
        });
        let buffer = "";
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            buffer += event.delta.text;
            const partial = tryParsePartialJSON(buffer) as Partial<T> | null;
            if (partial !== null) yield partial;
          }
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
          const { system, messages } = toAnthropicMessages(conversation);
          const response = await ctx.client.messages.create({
            model: modelId,
            max_tokens: options.maxOutputTokens ?? 4096,
            system: system ?? options.instructions,
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            messages: messages as never,
            tools: toAnthropicTools(options.tools),
          });
          totalUsage = mergeUsage(totalUsage, parseUsage(response));
          lastModelId = response.model ?? modelId;
          const blocks = response.content as never as Array<
            | { type: "text"; text: string }
            | { type: "tool_use"; id: string; name: string; input: unknown }
          >;
          // Append the assistant's response as a message so the next round sees it
          conversation.push({
            role: "assistant",
            content: fromAnthropicContent(blocks as never) as ContentBlock[],
          });
          finalText = blocks
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("");

          const toolUses = blocks.filter(
            (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
              b.type === "tool_use",
          );
          if (toolUses.length === 0) {
            terminationReason = "completed";
            break;
          }

          // Execute every tool the model called this turn and append results
          const toolResults: ContentBlock[] = [];
          for (const tu of toolUses) {
            const def = options.tools[tu.name];
            if (!def) {
              toolResults.push({
                type: "tool_result",
                toolUseId: tu.id,
                content: `Tool "${tu.name}" not found.`,
                isError: true,
              });
              continue;
            }
            try {
              const output = await def.execute(tu.input as never);
              toolCalls.push({
                name: tu.name,
                input: tu.input as Record<string, unknown>,
                output,
              });
              const text = typeof output === "string" ? output : JSON.stringify(output);
              const truncated =
                def.maxOutputBytes !== undefined && text.length > def.maxOutputBytes
                  ? `${text.slice(0, def.maxOutputBytes)}\n[truncated]`
                  : text;
              toolResults.push({
                type: "tool_result",
                toolUseId: tu.id,
                content: truncated,
              });
            } catch (toolErr) {
              toolResults.push({
                type: "tool_result",
                toolUseId: tu.id,
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

// ─── Helpers ─────────────────────────────────────────────────────────

function parseUsage(response: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }): TokenUsage {
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const cacheRead = response.usage?.cache_read_input_tokens;
  const cacheWrite = response.usage?.cache_creation_input_tokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
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
    ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) }
      : {}),
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

/**
 * Find the first valid JSON object in the string. Tolerates code fences and
 * leading/trailing prose; the model sometimes ignores instructions and adds
 * explanation around the JSON.
 */
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

/** Best-effort partial JSON parse; returns null while the buffer is unparseable. */
function tryParsePartialJSON(buffer: string): unknown | null {
  // Try as-is first.
  try {
    const start = buffer.indexOf("{");
    if (start === -1) return null;
    return JSON.parse(buffer.slice(start));
  } catch {
    // Try greedily closing braces/brackets.
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
    // Trim trailing commas that break JSON.
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

interface AnthropicToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

function toAnthropicTools(tools: Record<string, ToolDefinition>): Array<{
  name: string;
  description: string;
  input_schema: AnthropicToolInputSchema;
}> {
  return Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description,
    input_schema: zodToInputSchema(def.inputSchema),
  }));
}

/**
 * Convert a Zod schema to the JSON Schema shape Anthropic's tool-use API
 * expects (`input_schema: { type: "object", properties: { ... }, required: [...] }`).
 *
 * Uses `zod-to-json-schema` (no provider-specific `target` option since
 * Anthropic accepts standard JSON Schema). `$refStrategy: "none"` inlines
 * any reused sub-schemas so the model sees a flat shape instead of
 * `$ref`/`$defs` indirection.
 *
 * Falls back to the `{ type: "object", properties: {} }` shape if the
 * schema is not a Zod schema or if conversion fails — defensive fallback
 * so a malformed tool definition doesn't crash the agent loop.
 */
function zodToInputSchema(schema: unknown): AnthropicToolInputSchema {
  try {
    const json = zodToJsonSchema(schema as never, {
      $refStrategy: "none",
    }) as Record<string, unknown>;
    if (json && typeof json === "object" && json["type"] === "object") {
      return {
        type: "object",
        properties: (json["properties"] as Record<string, unknown>) ?? {},
        ...(Array.isArray(json["required"])
          ? { required: json["required"] as string[] }
          : {}),
      };
    }
  } catch {
    // fall through to the safe default
  }
  return { type: "object", properties: {} };
}
