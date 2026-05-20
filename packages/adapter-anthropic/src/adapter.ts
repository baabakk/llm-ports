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
  emitRetryEvent,
  extractJSON,
  failValidation,
  mergeTokenUsage,
  stringifyContentBlocks,
  tryParsePartialJSON,
  wrapProviderError,
  type AgentResult,
  type ContentBlock,
  type GenerateStructuredOptions,
  type GenerateStructuredResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type LLMPort,
  type ModelPricing,
  type OnRetry,
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
import {
  extractAnthropicErrorMessage,
  getEffectiveCapabilities,
  isTemperatureRejection,
  rememberConstraint,
  seedKnownConstraints,
} from "./capabilities.js";
import { checkSdkCompatibility, getInstalledSdkVersion } from "./version-check.js";

// Package version is needed for the click-to-file URL in capability warnings.
// Read at module load (synchronous) and cached.
let CACHED_PACKAGE_VERSION: string | undefined;
function getPackageVersion(): string {
  if (CACHED_PACKAGE_VERSION !== undefined) return CACHED_PACKAGE_VERSION;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../package.json") as { version?: string };
    CACHED_PACKAGE_VERSION = pkg.version ?? "unknown";
  } catch {
    CACHED_PACKAGE_VERSION = "unknown";
  }
  return CACHED_PACKAGE_VERSION;
}

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
  /**
   * Observability hook fired when the adapter retries an in-flight request.
   * Fired for `capability-fallback` reasons (currently only `temperatureLocked`).
   * Called fire-and-forget; hook errors do NOT cancel the retry.
   */
  onRetry?: OnRetry;
}

// ─── Module-level state ──────────────────────────────────────────────

interface AdapterContext {
  client: Anthropic;
  validationStrategy: ValidationStrategy;
  pricingOverrides: Record<string, ModelPricing>;
  onRetry?: OnRetry;
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
  // Surface "upgrade us or downgrade them" warning if the installed
  // @anthropic-ai/sdk version is outside the tested range. Observability only;
  // does not throw.
  checkSdkCompatibility(getInstalledSdkVersion());

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
    ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
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
  // Seed known-rejector catalog so first calls on claude-opus-4-5-style
  // models skip the discovery round-trip on `temperature`.
  seedKnownConstraints(modelId);

  /**
   * Execute a `messages.create` call with per-model capability handling and
   * single-retry on detected parameter rejections (currently: temperature).
   *
   * - Applies learned capabilities (strips `temperature` for models that
   *   reject it) before the outbound call.
   * - On a 400 that matches the temperature-rejection pattern, learns the
   *   constraint, fires the `onRetry` hook + the click-to-file warning, and
   *   retries once with the parameter stripped.
   * - Any other error propagates to wrapProviderError via the caller's
   *   try/catch.
   *
   * The `req` parameter is a typed subset of Anthropic's
   * `messages.create()` parameters. We omit `temperature` if the learned
   * capability indicates the model rejects it.
   */
  async function executeMessageCreate<R>(
    buildRequest: (capabilities: { temperatureLocked?: boolean }) => Parameters<
      typeof ctx.client.messages.create
    >[0],
  ): Promise<R> {
    const userCapabilities = ctx.pricingOverrides[modelId]?.capabilities;
    let caps = getEffectiveCapabilities(modelId, userCapabilities);
    let attempt = 0;
    // Single capability-fallback retry per call (the user-visible bug fix).
    while (true) {
      const req = buildRequest({ temperatureLocked: caps.temperatureLocked });
      try {
        return (await ctx.client.messages.create(req)) as R;
      } catch (err) {
        // Only retry on temperature rejection if we haven't already learned
        // the constraint (otherwise we would loop).
        if (
          attempt === 0 &&
          !caps.temperatureLocked &&
          isTemperatureRejection(err)
        ) {
          rememberConstraint(
            modelId,
            { temperatureLocked: true },
            {
              providerErrorMessage: extractAnthropicErrorMessage(err),
              adapterVersion: getPackageVersion(),
              sdkVersion: getInstalledSdkVersion() ?? "unknown",
            },
          );
          emitRetryEvent(ctx.onRetry, {
            reason: "capability-fallback",
            attempt,
            modelId,
            providerAlias: alias,
            delayMs: 0,
            cause: err,
            capability: "temperatureLocked",
          });
          attempt++;
          caps = getEffectiveCapabilities(modelId, userCapabilities);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Strip parameters from a request body that the model has been learned to
   * reject. Currently handles `temperature`. Adapter-specific other params
   * can be added here as Anthropic deprecates them.
   */
  function applyCapabilityFilter(
    baseRequest: Parameters<typeof ctx.client.messages.create>[0],
    capabilities: { temperatureLocked?: boolean },
  ): Parameters<typeof ctx.client.messages.create>[0] {
    if (!capabilities.temperatureLocked) return baseRequest;
    // Strip temperature by copying and deleting; spreading with a rest type
    // doesn't typecheck against Anthropic's union-typed params.
    const filtered = { ...(baseRequest as unknown as Record<string, unknown>) };
    delete filtered.temperature;
    return filtered as unknown as Parameters<typeof ctx.client.messages.create>[0];
  }

  return {
    async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
      const start = Date.now();
      try {
        const response = await executeMessageCreate<Anthropic.Messages.Message>((caps) =>
          applyCapabilityFilter(
            {
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
            },
            caps,
          ),
        );
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
        throw wrapProviderError(alias, err);
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
            ? `${stringifyContentBlocks(options.prompt)}\n\n${correctionPrompt}`
            : `${stringifyContentBlocks(options.prompt)}\n\nReply with a single JSON object that matches the requested schema. Do not include any prose, explanation, or code fences. Only the JSON.`;

          const response = await executeMessageCreate<Anthropic.Messages.Message>((caps) =>
            applyCapabilityFilter(
              {
                model: modelId,
                max_tokens: options.maxOutputTokens ?? 2048,
                ...(options.instructions !== undefined ? { system: options.instructions } : {}),
                temperature: options.temperature ?? 0,
                messages: [{ role: "user", content: userContent }],
              },
              caps,
            ),
          );
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
            emitRetryEvent(ctx.onRetry, {
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
          if (err instanceof Error) lastErr = err;
          throw wrapProviderError(alias, err);
        }
      }
      // Unreachable in practice; failValidation throws above.
      throw lastErr ?? new Error("generateStructured exhausted attempts");
    },

    async *streamText(options: StreamTextOptions): AsyncIterable<string> {
      // Apply learned capabilities up front for the streaming call. Streaming
      // retries on capability rejection are not yet supported (mid-stream
      // retry requires buffering the entire response, which defeats the point
      // of streaming). The pre-applied capabilities cover the known cases.
      const userCapabilities = ctx.pricingOverrides[modelId]?.capabilities;
      const caps = getEffectiveCapabilities(modelId, userCapabilities);
      try {
        const stream = ctx.client.messages.stream({
          model: modelId,
          max_tokens: options.maxOutputTokens ?? 1024,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          ...(options.temperature !== undefined && !caps.temperatureLocked
            ? { temperature: options.temperature }
            : {}),
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
        throw wrapProviderError(alias, err);
      }
    },

    async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
      // Anthropic doesn't stream parsed JSON natively. We accumulate text deltas
      // and best-effort parse a partial JSON object after each chunk.
      const userCapabilities = ctx.pricingOverrides[modelId]?.capabilities;
      const caps = getEffectiveCapabilities(modelId, userCapabilities);
      try {
        const stream = ctx.client.messages.stream({
          model: modelId,
          max_tokens: options.maxOutputTokens ?? 2048,
          ...(options.instructions !== undefined ? { system: options.instructions } : {}),
          // Omit temperature on models that reject it; otherwise default to 0
          // for deterministic JSON parsing.
          ...(caps.temperatureLocked ? {} : { temperature: options.temperature ?? 0 }),
          messages: [
            {
              role: "user",
              content: `${stringifyContentBlocks(options.prompt)}\n\nReply with a single JSON object that matches the requested schema. Stream the JSON progressively.`,
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
        throw wrapProviderError(alias, err);
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
          const response = await executeMessageCreate<Anthropic.Messages.Message>((caps) =>
            applyCapabilityFilter(
              {
                model: modelId,
                max_tokens: options.maxOutputTokens ?? 4096,
                system: system ?? options.instructions,
                ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
                messages: messages as never,
                tools: toAnthropicTools(options.tools),
              },
              caps,
            ),
          );
          totalUsage = mergeTokenUsage(totalUsage, parseUsage(response));
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
