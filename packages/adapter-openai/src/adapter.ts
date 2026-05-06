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
import {
  getEffectiveCapabilities,
  isJsonModeRejection,
  isSystemMessageRejection,
  isTemperatureRejection,
  rememberConstraint,
} from "./capabilities.js";

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
  /**
   * Number of retries the OpenAI SDK performs internally for retriable HTTP
   * errors (408, 409, 429, 500+). Defaults to 2 (the SDK's own default). The
   * SDK does NOT retry 401s; that's handled separately in this adapter — see
   * {@link OpenAIAdapterOptions.transientAuthRetries}.
   */
  maxRetries?: number;
  /**
   * Number of retries to attempt on transient 401 responses. OpenAI project
   * keys (sk-proj-*) have burst-protection that occasionally returns
   * 401 "Incorrect API key" when too many requests arrive in a short window,
   * even though the key is valid. The adapter only retries 401s if a prior
   * request on this same client previously succeeded — that's how it
   * distinguishes a transient burst-protection 401 from a real auth failure.
   * Defaults to 2 retries with exponential backoff (500ms, 1500ms).
   * Set to 0 to disable.
   */
  transientAuthRetries?: number;
  /**
   * Override the backoff delay between transient-401 retries. Receives the
   * 0-indexed retry attempt (0 = first retry) and returns the delay in
   * milliseconds. Default is `(attempt) => 500 * Math.pow(3, attempt)` —
   * 500ms, 1500ms, 4500ms... Tests inject `() => 0` to skip the wait.
   */
  transientAuthBackoffMs?: (attempt: number) => number;
}

// ─── Internal context ────────────────────────────────────────────────

interface AdapterContext {
  client: OpenAI;
  validationStrategy: ValidationStrategy;
  pricingOverrides: Record<string, ModelPricing>;
  /**
   * Set true after the first successful response on this client. Used to
   * distinguish OpenAI project-key burst-protection 401s (transient; key
   * is valid) from real auth failures (the key never worked).
   * Boxed so AdapterContext stays a value type while `hasSucceeded` mutates.
   */
  hasSucceeded: { value: boolean };
  transientAuthRetries: number;
  transientAuthBackoffMs: (attempt: number) => number;
}

function makeClient(opts: OpenAIAdapterOptions): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.fetch ? { fetch: opts.fetch as OpenAI["fetch"] } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
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
  // Merge user-supplied pricingOverrides into the adapter's exposed pricing
  // table so the registry's pricing check sees them. Without this merge,
  // models that aren't in the bundled OPENAI_PRICING (e.g. compat-provider
  // models like Groq's llama-3.3-70b-versatile or Cerebras's llama-4-scout)
  // would be rejected by the registry as "no pricing entry".
  const mergedPricing: Record<string, ModelPricing> = {
    ...OPENAI_PRICING,
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
    hasSucceeded: { value: false },
    transientAuthRetries: opts.transientAuthRetries ?? 2,
    transientAuthBackoffMs:
      opts.transientAuthBackoffMs ?? ((attempt) => 500 * Math.pow(3, attempt)),
  };

  return {
    name: "openai",
    pricing: mergedPricing,
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
      const userMsg: OpenAIMessage = {
        role: "user",
        content: toOpenAIUserContent(options.prompt),
      };
      const { response } = await executeChatRequest(ctx.client, ctx, alias, pricing, {
        modelId,
        messages: [userMsg],
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
        stream: false,
      });
      const r = response as {
        model?: string;
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      };
      const usage = parseUsage(r);
      const text = r.choices[0]?.message.content ?? "";
      return {
        text,
        usage,
        cost: computeChatCost(usage, pricing),
        modelId: r.model ?? modelId,
        providerAlias: alias,
        latencyMs: Date.now() - start,
      };
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
        const userText = correctionPrompt
          ? `${stringifyPrompt(options.prompt)}\n\n${correctionPrompt}`
          : `${stringifyPrompt(options.prompt)}\n\nReply with a single JSON object only. No prose, no code fences.`;

        // executeChatRequest handles error wrapping and capability fallback.
        // Don't double-wrap here — let ProviderUnavailableError propagate, and
        // let failValidation throw ValidationError directly.
        const { response } = await executeChatRequest(ctx.client, ctx, alias, pricing, {
          modelId,
          messages: [{ role: "user", content: userText }],
          ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
          temperature: options.temperature ?? 0,
          ...(options.maxOutputTokens !== undefined
            ? { maxOutputTokens: options.maxOutputTokens }
            : {}),
          jsonMode: true,
          stream: false,
        });
        const r = response as {
          model?: string;
          choices: Array<{ message: { content: string | null } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
        };
        lastUsage = parseUsage(r);
        lastModelId = r.model ?? modelId;
        const raw = r.choices[0]?.message.content ?? "";
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
      }
      throw new Error("generateStructured exhausted attempts");
    },

    async *streamText(options: StreamTextOptions): AsyncIterable<string> {
      const userMsg: OpenAIMessage = {
        role: "user",
        content: toOpenAIUserContent(options.prompt),
      };
      const stream = await executeChatStream(ctx.client, ctx, alias, pricing, {
        modelId,
        messages: [userMsg],
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
        stream: true,
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          yield delta;
        }
      }
    },

    async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
      const stream = await executeChatStream(ctx.client, ctx, alias, pricing, {
        modelId,
        messages: [
          {
            role: "user",
            content: `${stringifyPrompt(options.prompt)}\n\nReply with a single JSON object only. Stream the JSON progressively.`,
          },
        ],
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        temperature: options.temperature ?? 0,
        ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
        jsonMode: true,
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
          const turnMessages = toOpenAIMessages(conversation);
          const tools = toOpenAITools(options.tools);

          const { response } = await executeChatRequest(ctx.client, ctx, alias, pricing, {
            modelId,
            messages: turnMessages,
            ...(options.instructions ? { instructions: options.instructions } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
            ...(tools.length > 0 ? { tools } : {}),
            stream: false,
          });
          const r = response as {
            model?: string;
            choices: Array<{
              message: {
                content: string | null;
                tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
              };
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
          };
          totalUsage = mergeUsage(totalUsage, parseUsage(r));
          lastModelId = r.model ?? modelId;

          const aMsg = r.choices[0]?.message;
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
        const response = await withTransientAuthRetry(ctx, alias, () =>
          ctx.client.embeddings.create({
            model: modelId,
            input: options.input,
          }),
        );
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
        const response = await withTransientAuthRetry(ctx, alias, () =>
          ctx.client.embeddings.create({
            model: modelId,
            input: options.inputs,
          }),
        );
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

// ─── Capability-aware request building ───────────────────────────────

/**
 * Logical chat-completion request. Adapter methods build one of these and
 * hand it to {@link executeChatRequest}, which materializes it for the SDK
 * — applying any model capability constraints learned (or supplied via
 * pricingOverrides), retrying once on capability rejection.
 */
interface LogicalChatRequest {
  modelId: string;
  messages: OpenAIMessage[];
  /** Optional system instructions. Folded into user message if model rejects system. */
  instructions?: string;
  /** User-supplied temperature. Skipped when model has temperatureLocked capability. */
  temperature?: number;
  /** User-supplied output cap. Always honored when set. */
  maxOutputTokens?: number;
  /** Set true to request native JSON mode. Falls back to plain text on rejection. */
  jsonMode?: boolean;
  /** Stream the response or not. */
  stream: boolean;
  /** Tools when this is an agent step. */
  tools?: ReturnType<typeof toOpenAITools>;
}

/** Build the SDK's request object from a logical request and the model's effective capabilities. */
function materializeRequest(
  req: LogicalChatRequest,
  caps: ModelCapsCompact,
): Record<string, unknown> {
  // Compose messages, optionally folding instructions into the user message
  // if the model rejects standalone system messages.
  const messages: OpenAIMessage[] = [];
  if (req.instructions !== undefined) {
    if (caps.systemMessageInUserOnly) {
      // Prepend instructions to the first user-role message; if there is
      // none, synthesize one.
      const cloned = [...req.messages];
      const firstUserIdx = cloned.findIndex((m) => m.role === "user");
      const annotation = `<instructions>\n${req.instructions}\n</instructions>\n\n`;
      if (firstUserIdx >= 0) {
        const u = cloned[firstUserIdx]!;
        if (typeof (u as { content: unknown }).content === "string") {
          cloned[firstUserIdx] = { role: "user", content: annotation + ((u as { content: string }).content) };
        } else {
          cloned[firstUserIdx] = {
            role: "user",
            content: [
              { type: "text", text: annotation } as never,
              ...((u as { content: unknown[] }).content as never[]),
            ] as never,
          };
        }
      } else {
        cloned.unshift({ role: "user", content: annotation });
      }
      messages.push(...cloned);
    } else {
      messages.push({ role: "system", content: req.instructions });
      messages.push(...req.messages);
    }
  } else {
    messages.push(...req.messages);
  }

  const out: Record<string, unknown> = {
    model: req.modelId,
    messages,
    stream: req.stream,
  };
  // Temperature: only set if user requested AND model accepts it
  if (req.temperature !== undefined && !caps.temperatureLocked) {
    out["temperature"] = req.temperature;
  }
  if (req.maxOutputTokens !== undefined) {
    // For reasoning models, OpenAI's max_completion_tokens caps reasoning
    // tokens + visible output. Apply the headroom multiplier so the model
    // has room to think AND emit visible output. Discovered at runtime
    // (see executeChatRequest learning from usage.reasoningTokens) or
    // supplied via pricingOverrides.capabilities.reasoningModel.
    out["max_completion_tokens"] = caps.reasoningModel
      ? req.maxOutputTokens * caps.reasoningHeadroomMultiplier
      : req.maxOutputTokens;
  }
  if (req.jsonMode && !caps.jsonModeUnsupported) {
    out["response_format"] = { type: "json_object" };
  }
  if (req.tools && req.tools.length > 0) {
    out["tools"] = req.tools;
  }
  return out;
}

interface ModelCapsCompact {
  temperatureLocked?: boolean;
  jsonModeUnsupported?: boolean;
  systemMessageInUserOnly?: boolean;
  reasoningModel?: boolean;
  reasoningHeadroomMultiplier: number;
}

function readCaps(modelId: string, pricing: ModelPricing): ModelCapsCompact {
  const eff = getEffectiveCapabilities(modelId, pricing.capabilities);
  return {
    temperatureLocked: eff.temperatureLocked === true,
    // jsonMode default is true; only treat as unsupported if explicitly false
    jsonModeUnsupported: eff.jsonMode === false,
    systemMessageInUserOnly: eff.systemMessageInUserOnly === true,
    reasoningModel: eff.reasoningModel === true,
    reasoningHeadroomMultiplier: eff.reasoningHeadroomMultiplier ?? 10,
  };
}

/**
 * Inspect an SDK error and, if it matches a known capability constraint,
 * record the constraint against this model. Returns true if at least one
 * constraint was learned from this error (so the caller knows a retry might
 * succeed).
 */
function learnConstraintsFromError(err: unknown, req: LogicalChatRequest): boolean {
  let learned = false;
  if (isTemperatureRejection(err) && req.temperature !== undefined) {
    rememberConstraint(req.modelId, { temperatureLocked: true });
    learned = true;
  }
  if (isJsonModeRejection(err) && req.jsonMode) {
    rememberConstraint(req.modelId, { jsonMode: false });
    learned = true;
  }
  if (isSystemMessageRejection(err) && req.instructions !== undefined) {
    rememberConstraint(req.modelId, { systemMessageInUserOnly: true });
    learned = true;
  }
  return learned;
}

/**
 * Inspect a successful response and remember any newly-observed model behavior.
 * Marks the model as reasoning if either signal is present:
 *   - `usage.completion_tokens_details.reasoning_tokens > 0` (OpenAI o-series, gpt-5-nano)
 *   - `choices[0].message.reasoning` populated (Cerebras gpt-oss-* and similar
 *     compat providers that expose CoT as a separate field)
 * Future calls to this model will get an expanded max_completion_tokens budget
 * via the headroom multiplier so visible output has room after reasoning.
 */
function learnFromResponse(modelId: string, response: unknown): void {
  if (!response || typeof response !== "object") return;
  const r = response as {
    choices?: Array<{ message?: { reasoning?: string | null } }>;
    usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
  };
  const reasoningTokens = r.usage?.completion_tokens_details?.reasoning_tokens;
  const reasoningField = r.choices?.[0]?.message?.reasoning;
  const isReasoning =
    (reasoningTokens !== undefined && reasoningTokens > 0) ||
    (typeof reasoningField === "string" && reasoningField.length > 0);
  if (isReasoning) {
    rememberConstraint(modelId, { reasoningModel: true });
  }
}

/**
 * Detect the "all budget consumed by reasoning" pattern: empty visible text +
 * finish_reason=length, with any signal that the model is reasoning (either
 * usage.reasoning_tokens > 0 OR a populated message.reasoning field). This
 * tells the caller to retry with the now-learned reasoning multiplier so the
 * model has budget for visible output.
 *
 * Different providers expose reasoning differently:
 *   - OpenAI o-series + gpt-5-nano: message.content empty, usage has reasoning_tokens
 *   - Cerebras gpt-oss-*: message.content missing entirely, message.reasoning has CoT
 * Both produce the same end-user symptom (empty visible text), so we recover the
 * same way: expand the total budget and retry.
 */
function reasoningStarvedResponse(response: unknown, req: LogicalChatRequest): boolean {
  if (!response || typeof response !== "object") return false;
  if (req.maxOutputTokens === undefined) return false;
  const r = response as {
    choices?: Array<{
      message?: { content?: string | null; reasoning?: string | null };
      finish_reason?: string;
    }>;
    usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
  };
  const choice = r.choices?.[0];
  const text = choice?.message?.content ?? "";
  const finishReason = choice?.finish_reason;
  const reasoningTokens = r.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const reasoningField = choice?.message?.reasoning;
  const hasReasoningSignal =
    reasoningTokens > 0 ||
    (typeof reasoningField === "string" && reasoningField.length > 0);
  return text === "" && finishReason === "length" && hasReasoningSignal;
}

/**
 * True if this error is OpenAI's project-key burst-protection 401 (transient,
 * key is valid) rather than a real auth failure. Distinguishable only when a
 * prior request on the same client already succeeded — otherwise indistinguishable
 * from a bad key, in which case we fall through to the normal error path.
 *
 * OpenAI sk-proj-* keys briefly return 401 "Incorrect API key" when too many
 * requests arrive in a short window, even though the key works. The OpenAI SDK
 * does not retry 401 internally because for most users a 401 is a permanent
 * config issue. The adapter handles this provider-specific quirk so callers
 * don't need to know about it.
 */
function isTransientAuthError(err: unknown, ctx: AdapterContext): boolean {
  if (!ctx.hasSucceeded.value) return false;
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: number;
    message?: unknown;
    code?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (e.status !== 401) return false;
  const code = e.code ?? e.error?.code;
  const message = String(e.message ?? e.error?.message ?? "");
  if (code === "invalid_api_key") return true;
  if (/incorrect api key/i.test(message)) return true;
  return false;
}

/** Wait helper for transient retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generic transient-401 retry wrapper for non-chat operations (embeddings, etc.).
 * Same logic as the transient branch of executeChatRequest but as a standalone
 * helper. Used by EmbeddingsPort methods. Marks ctx.hasSucceeded on success so
 * subsequent calls' transient detection works.
 */
async function withTransientAuthRetry<T>(
  ctx: AdapterContext,
  _alias: string,
  fn: () => Promise<T>,
): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition -- intentional retry loop; exits via return/throw/break
  while (true) {
    try {
      const result = await fn();
      ctx.hasSucceeded.value = true;
      return result;
    } catch (err) {
      if (
        isTransientAuthError(err, ctx) &&
        attempt < ctx.transientAuthRetries
      ) {
        await sleep(ctx.transientAuthBackoffMs(attempt));
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Execute a non-streaming chat completion with capability awareness AND
 * transient-401 resilience. Single retry loop with three decision branches:
 *
 *   1. Success  → mark client as proven-good; learn from usage; return.
 *      (If the response is reasoning-starved, do one expanded-budget retry.)
 *   2. Transient 401 (project-key burst protection)  → backoff + retry,
 *      up to ctx.transientAuthRetries.
 *   3. Capability rejection (temperature, json_object, system message)  →
 *      learn the constraint, retry once with offending param dropped.
 *
 * Anything else propagates as ProviderUnavailableError via {@link wrapError}.
 */
async function executeChatRequest(
  client: OpenAI,
  ctx: AdapterContext,
  alias: string,
  pricing: ModelPricing,
  req: LogicalChatRequest,
): Promise<{ response: unknown; modelId: string }> {
  const attempt = async (): Promise<unknown> => {
    const caps = readCaps(req.modelId, pricing);
    const sdkReq = materializeRequest(req, caps);
    return await client.chat.completions.create(sdkReq as never);
  };

  let triedCapabilityFallback = false;
  let transientRetries = 0;

  // eslint-disable-next-line no-constant-condition -- intentional retry loop; exits via return/throw/break
  while (true) {
    try {
      const response = await attempt();
      ctx.hasSucceeded.value = true;
      learnFromResponse(req.modelId, response);

      // If the response shows the model spent all its budget on reasoning and
      // produced no visible text, retry once with the now-learned reasoning
      // multiplier applied to max_completion_tokens. This is the recovery path
      // for first-call interactions with unknown reasoning models.
      if (reasoningStarvedResponse(response, req)) {
        try {
          const retried = await attempt();
          ctx.hasSucceeded.value = true;
          learnFromResponse(req.modelId, retried);
          return { response: retried, modelId: req.modelId };
        } catch (retryErr) {
          throw wrapError(alias, retryErr);
        }
      }

      return { response, modelId: req.modelId };
    } catch (err) {
      if (
        isTransientAuthError(err, ctx) &&
        transientRetries < ctx.transientAuthRetries
      ) {
        // Exponential backoff: 500ms, 1500ms, 4500ms... up to maxRetries
        await sleep(ctx.transientAuthBackoffMs(transientRetries));
        transientRetries++;
        continue;
      }
      if (!triedCapabilityFallback && learnConstraintsFromError(err, req)) {
        triedCapabilityFallback = true;
        continue;
      }
      throw wrapError(alias, err);
    }
  }
}

/**
 * Execute a streaming chat completion with capability awareness AND
 * transient-401 resilience. Mirrors executeChatRequest but returns the SDK's
 * async iterable. Both retry kinds (capability rejection, transient 401)
 * happen at stream-creation time. Mid-stream errors propagate as-is to the
 * consumer's iteration loop.
 */
async function executeChatStream(
  client: OpenAI,
  ctx: AdapterContext,
  alias: string,
  pricing: ModelPricing,
  req: LogicalChatRequest,
): Promise<AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>> {
  const streamReq = { ...req, stream: true };
  const attempt = async (): Promise<AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>> => {
    const caps = readCaps(streamReq.modelId, pricing);
    const sdkReq = materializeRequest(streamReq, caps);
    return (await client.chat.completions.create(sdkReq as never)) as never;
  };

  let triedCapabilityFallback = false;
  let transientRetries = 0;

  // eslint-disable-next-line no-constant-condition -- intentional retry loop; exits via return/throw/break
  while (true) {
    try {
      const stream = await attempt();
      ctx.hasSucceeded.value = true;
      return stream;
    } catch (err) {
      if (
        isTransientAuthError(err, ctx) &&
        transientRetries < ctx.transientAuthRetries
      ) {
        await sleep(ctx.transientAuthBackoffMs(transientRetries));
        transientRetries++;
        continue;
      }
      if (!triedCapabilityFallback && learnConstraintsFromError(err, streamReq)) {
        triedCapabilityFallback = true;
        continue;
      }
      throw wrapError(alias, err);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function parseUsage(response: {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}): TokenUsage {
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  const cached = response.usage?.prompt_tokens_details?.cached_tokens;
  const reasoning = response.usage?.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cached !== undefined && cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
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
  // Idempotent: don't double-wrap framework errors that are already typed.
  // ProviderUnavailableError is what executeChatRequest produces; passing it
  // through unchanged means runAgent's outer try/catch can stay simple.
  // ValidationError is what failValidation produces; the caller wants to see
  // it as-is, not wrapped as a provider failure.
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
