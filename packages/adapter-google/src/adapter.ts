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
  emitRetryEvent,
  extractJSON,
  failValidation,
  mergeTokenUsage,
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
  type LLMMessage,
  type LLMPort,
  type MessageContent,
  type ModelPricing,
  type OnRetry,
  type ProviderModelInfo,
  type RunAgentOptions,
  type StreamStructuredOptions,
  type StreamTextOptions,
  type TokenUsage,
  type ValidationStrategy,
} from "@llm-ports/core";
import {
  detectUnsupportedSchemaFeature,
  extractGeminiText,
  fromGeminiCandidate,
  sanitizeGeminiSchema,
  toGeminiParts2,
  toGeminiRequest,
  toGeminiTools,
  zodToGeminiSchema,
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
  /**
   * Observability hook fired whenever the adapter retries an in-flight
   * structured-output request after a Zod validation failure. Sync or
   * async; called fire-and-forget. Throwing from the hook does NOT cancel
   * the retry. Added in alpha.17 (parity with adapter-openai +
   * adapter-anthropic + adapter-ollama).
   */
  onRetry?: OnRetry;
}

// ─── Internal context ────────────────────────────────────────────────

interface AdapterContext {
  client: GoogleGenAI;
  validationStrategy: ValidationStrategy;
  pricingOverrides: Record<string, ModelPricing>;
  imageSizeLimitBytes: number;
  onRetry?: OnRetry;
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
    ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
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

      // Native responseSchema path: convert schema to JSON Schema; if no
      // Gemini-unsupported features (oneOf, $ref, etc.) emit it as
      // `config.responseSchema` so Gemini constrains decoding to the schema
      // before tokens are produced. We still validate with Zod (Gemini's
      // schema enforcement is best-effort) and still run the repair pass.
      // If the schema uses unsupported features, fall back to the prompted-
      // JSON path (existing behavior).
      const jsonSchema = zodToGeminiSchema(options.schema);
      const unsupportedFeature = detectUnsupportedSchemaFeature(jsonSchema);
      const useNativeResponseSchema = unsupportedFeature === null;
      if (!useNativeResponseSchema) {
        warnSchemaFallback(modelId, unsupportedFeature);
      }
      const sanitizedSchema = useNativeResponseSchema
        ? sanitizeGeminiSchema(jsonSchema)
        : null;

      let correctionPrompt: string | null = null;
      let lastUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let lastModelId = modelId;

      while (attempts < maxAttempts) {
        attempts++;
        // With native responseSchema, Gemini constrains the decoding — we
        // skip the "Reply with a single JSON object only" suffix on the
        // first attempt. Correction prompts still apply on retry-with-
        // feedback rounds.
        const userText = correctionPrompt
          ? `${stringifyContentBlocks(options.prompt)}\n\n${correctionPrompt}`
          : useNativeResponseSchema
            ? stringifyContentBlocks(options.prompt)
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
              ...(sanitizedSchema ? { responseSchema: sanitizedSchema } : {}),
              ...(options.signal ? { abortSignal: options.signal } : {}),
            },
          });
          const candidate = response.candidates?.[0];
          const raw = extractGeminiText(candidate?.content?.parts as GeminiPart[] | undefined);
          // Accumulate usage across retry-with-feedback rounds so cost
          // reporting reflects every SDK call, not just the final one.
          // Matches runAgent's mergeTokenUsage pattern.
          lastUsage = mergeTokenUsage(lastUsage, parseUsage(response));
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
      const start = Date.now();
      const maxSteps = options.maxSteps ?? 10;
      const conversation: LLMMessage[] = [...options.messages];
      const toolCalls: AgentResult["toolCalls"] = [];
      let stepsTaken = 0;
      let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let finalText = "";
      let lastModelId = modelId;
      let terminationReason: AgentResult["terminationReason"] = "max_steps";

      const toolsRegistered = Object.keys(options.tools).length > 0;
      const geminiTools = toolsRegistered ? toGeminiTools(options.tools) : undefined;

      try {
        for (let step = 0; step < maxSteps; step++) {
          // Re-check between steps so cancellation propagates even if the
          // model just emitted a function call but the user clicked cancel
          // before we send the result back.
          throwIfAborted(options.signal);
          stepsTaken = step + 1;

          const { systemInstruction, contents } = toGeminiRequest(conversation);
          const response = await ctx.client.models.generateContent({
            model: modelId,
            contents,
            config: {
              // options.instructions takes precedence over a system message
              // baked into the messages array, matching the per-method pattern
              // used elsewhere in the adapter.
              ...(options.instructions !== undefined
                ? { systemInstruction: options.instructions }
                : systemInstruction !== undefined
                  ? { systemInstruction }
                  : {}),
              ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
              ...(options.maxOutputTokens !== undefined
                ? { maxOutputTokens: options.maxOutputTokens }
                : {}),
              ...(geminiTools ? { tools: geminiTools } : {}),
              ...(options.signal ? { abortSignal: options.signal } : {}),
            },
          });

          totalUsage = mergeTokenUsage(totalUsage, parseUsage(response));
          lastModelId = response.modelVersion ?? modelId;

          const candidate = response.candidates?.[0];
          const responseParts = (candidate?.content?.parts ?? []) as GeminiPart[];
          const blocks = fromGeminiCandidate({
            content: { parts: responseParts },
          });

          // Push the assistant's response (text + tool_use blocks) into the
          // canonical conversation so the next round sees it.
          conversation.push({
            role: "assistant",
            content: blocks.length > 0
              ? blocks
              : [{ type: "text", text: extractGeminiText(responseParts) }],
          });

          finalText = blocks
            .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("");

          const toolUses = blocks.filter(
            (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
          );
          if (toolUses.length === 0) {
            terminationReason = "completed";
            break;
          }

          // Execute every tool call the model emitted this turn. Gemini may
          // emit multiple functionCalls in a single response and expects all
          // responses before continuing.
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
          conversation.push({ role: "tool", content: toolResults });
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
        const out: ProviderModelInfo[] = [];
        // The @google/genai SDK paginates; iterate once. Pricing is NOT
        // included in the response — Gemini exposes catalog metadata but
        // not USD rates. checkPricingFreshness() will detect added/removed
        // models but cannot detect rate-only drift for Gemini.
        const pager = await ctx.client.models.list();
        for await (const m of pager) {
          const model = m as {
            name?: string;
            displayName?: string;
            inputTokenLimit?: number;
            outputTokenLimit?: number;
          };
          if (!model.name) continue;
          // `name` comes back as e.g. "models/gemini-2.5-flash". Strip prefix.
          const id = model.name.startsWith("models/")
            ? model.name.slice("models/".length)
            : model.name;
          out.push({
            id,
            ...(model.displayName ? { displayName: model.displayName } : {}),
            ...(model.inputTokenLimit ? { contextWindow: model.inputTokenLimit } : {}),
            ...(model.outputTokenLimit
              ? { metadata: { outputTokenLimit: model.outputTokenLimit } }
              : {}),
          });
        }
        return out;
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

// ─── Schema-fallback warning ─────────────────────────────────────────

const warnedSchemaFallback = new Set<string>();

/**
 * Emit a one-time `console.warn` per model+feature when generateStructured
 * falls back from native responseSchema to prompted JSON because the Zod
 * schema contains a feature Gemini's constrained-decoding doesn't accept.
 *
 * Not a runtime-learned constraint (we know pre-call from inspecting the
 * schema), so no click-to-file URL — just a developer-facing hint that
 * simplifying the schema would unlock native responseSchema enforcement.
 */
function warnSchemaFallback(modelId: string, feature: string): void {
  const key = `${modelId}::${feature}`;
  if (warnedSchemaFallback.has(key)) return;
  warnedSchemaFallback.add(key);
  console.warn(
    `[@llm-ports/adapter-google] generateStructured: model "${modelId}" schema ` +
      `contains "${feature}" which Gemini's responseSchema does not support. ` +
      `Falling back to prompted-JSON + Zod validation (still correct; just ` +
      `slightly weaker constrained-decoding guarantee).`,
  );
}

/** Test-only: reset the per-process fallback warning state. */
export function _resetSchemaFallbackWarnings(): void {
  warnedSchemaFallback.clear();
}

// Re-export ContentBlock for the rare adapter user that wants to type-check
// outside of @llm-ports/core. Keeps the import surface symmetric with the
// other adapters.
export type { ContentBlock };
