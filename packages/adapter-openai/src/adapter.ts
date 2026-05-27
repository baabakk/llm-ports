/**
 * OpenAI adapter implementing LLMPort + EmbeddingsPort.
 *
 * Wraps the openai npm package's chat completions and embeddings APIs.
 * The same adapter serves OpenAI plus 10+ OpenAI-compatible providers
 * via the `baseURL` option (Azure OpenAI, Groq, Together AI, Fireworks AI,
 * DeepInfra, Perplexity, Cerebras, LiteLLM proxy, Ollama compat-mode, etc.).
 */

import OpenAI from "openai";
import { zodToJsonSchema } from "zod-to-json-schema";
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
  type OnRetry,
  type ProviderModelInfo,
  type RetryEvent,
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
  seedKnownConstraints,
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
  /**
   * Maximum bytes per base64 image. Defaults to 20MB (OpenAI's per-image
   * limit). Set to 0 or a negative number to disable size validation.
   */
  imageSizeLimitBytes?: number;
  /**
   * Set to `true` to allow the OpenAI SDK to run in a browser environment.
   * The SDK refuses by default to prevent accidental exposure of API keys.
   *
   * Only enable this when you understand the risk and have a mitigation in
   * place: a server-side proxy that strips keys from the request before
   * forwarding, a "bring your own API key" UI where users supply their own
   * key, or an internal tool exposed only to trusted users. Forwarded to
   * `new OpenAI({ dangerouslyAllowBrowser })` verbatim.
   *
   * Available since `0.1.0-alpha.9`.
   */
  dangerouslyAllowBrowser?: boolean;
  /**
   * Use OpenAI-style strict `response_format: { type: "json_schema", strict: true }`
   * for `generateStructured` instead of classic `response_format: { type: "json_object" }`.
   * With strict mode the provider constrains decoding to the exact schema
   * before tokens are produced, so invalid JSON or missing fields are
   * impossible (modulo provider bugs). The Zod schema is converted to
   * JSON Schema via `zod-to-json-schema`, then post-processed to add
   * `additionalProperties: false` on every object (a hard requirement of
   * OpenAI / Cerebras / Groq strict mode).
   *
   * Defaults to auto-detect (alpha.14+). Auto-enabled when:
   *   - `baseURL` is unset (= OpenAI native; strict json_schema has been GA
   *     on gpt-4o / gpt-5 / o-series since August 2024)
   *   - `baseURL` contains `api.cerebras.ai` (Cerebras's gpt-oss / Qwen3.6
   *     endpoints silently ignore classic `json_object` mode; strict mode
   *     is required for reliable structured output)
   *   - `baseURL` contains `api.groq.com` (verified to support strict
   *     `response_format: json_schema` with constrained decoding)
   *   - `baseURL` contains `api.sambanova.ai` (added alpha.15+;
   *     empirically verified — MiniMax-M2.7 jumped from 0/10 → 10/10 on
   *     nested schemas with strict mode forced on)
   *
   * Stays OPT-IN (default `false`) for unverified compat providers like
   * Together AI, Fireworks AI, Clarifai. Set `useStrictResponseFormat: true`
   * explicitly once you've verified the provider's strict-mode support.
   *
   * Opt-out: set `useStrictResponseFormat: false` explicitly if your Zod
   * schemas use open shapes that can't accept `additionalProperties: false`
   * (e.g. `z.record(...)`, schemas with computed/optional fields the
   * model is allowed to extend), or if strict mode is causing your model
   * to reject the request.
   *
   * Available since `0.1.0-alpha.9`; default expanded to OpenAI native +
   * Groq in `0.1.0-alpha.14`; SambaNova added `0.1.0-alpha.15`.
   */
  useStrictResponseFormat?: boolean;
  /**
   * Observability hook fired whenever the adapter retries an in-flight
   * request for a known transient reason. Sync or async; called
   * fire-and-forget. Throwing from the hook does NOT cancel the retry.
   * Fires for: transient-auth (project-key burst-protection 401),
   * capability-fallback (temperature/json_object/system-message rejection),
   * reasoning-starvation (model used full budget on hidden reasoning),
   * validation-feedback (structured output failed schema; retry with feedback).
   */
  onRetry?: OnRetry;
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
  /** 0 means "no size check"; positive number is the per-image byte limit. */
  imageSizeLimitBytes: number;
  /** Whether generateStructured should emit `response_format: { type: "json_schema", strict: true }`. */
  useStrictResponseFormat: boolean;
  /** Observability hook for transient retries. Optional; no-op when unset. */
  onRetry?: OnRetry;
}

/**
 * Auto-detect whether to default `useStrictResponseFormat` to true based on
 * the `baseURL`. See the option's docstring for the rationale per provider.
 *
 * Exported for testability and for users who want to reuse the same default
 * logic when constructing multiple adapter instances programmatically.
 */
export function autoDetectStrictResponseFormat(baseURL: string | undefined): boolean {
  // OpenAI native: no baseURL set, or explicit api.openai.com host (some
  // users redundantly point at the default). Strict json_schema GA on
  // gpt-4o / gpt-5 / o-series since August 2024.
  if (!baseURL) return true;
  if (baseURL.includes("api.openai.com")) return true;
  // Cerebras: classic json_object is silently ignored on gpt-oss / Qwen3.6
  // tiers; strict mode is the only reliable path.
  if (baseURL.includes("api.cerebras.ai")) return true;
  // Groq: verified to support strict `response_format: json_schema` with
  // constrained decoding (per Groq docs, May 2026).
  if (baseURL.includes("api.groq.com")) return true;
  // SambaNova: empirically verified 2026-05-27 — MiniMax-M2.7 with explicit
  // `useStrictResponseFormat: true` jumped from 0/10 → 10/10 schema-valid
  // on a nested production scoring schema (BEPA A/B harness). Docs were
  // ambiguous; the probe is the source of truth.
  if (baseURL.includes("api.sambanova.ai")) return true;
  // Unknown compat provider — stay opt-in.
  return false;
}

/** Fire the onRetry hook fire-and-forget. Delegates to the shared `emitRetryEvent`
 *  helper from @llm-ports/core so semantics stay consistent across adapters. */
function emitRetry(ctx: AdapterContext, event: RetryEvent): void {
  emitRetryEvent(ctx.onRetry, event);
}

function makeClient(opts: OpenAIAdapterOptions): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.fetch ? { fetch: opts.fetch as OpenAI["fetch"] } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.dangerouslyAllowBrowser ? { dangerouslyAllowBrowser: true } : {}),
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
    imageSizeLimitBytes: opts.imageSizeLimitBytes ?? 20 * 1024 * 1024,
    useStrictResponseFormat:
      opts.useStrictResponseFormat ?? autoDetectStrictResponseFormat(opts.baseURL),
    ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
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
  // Seed known-reasoning catalog so first calls on o-series / gpt-5-nano /
  // gpt-oss / Qwen3.6 / MiniMax-M2.7 skip the starvation-retry round-trip.
  seedKnownConstraints(modelId);

  // Validate image content blocks at the adapter boundary. Throws typed
  // ImageTooLargeError or InvalidImageUrlError if a base64 image exceeds
  // the size limit or a URL-form image has a bad scheme.
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
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
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

        // When Cerebras / OpenAI strict mode is enabled, build the JSON
        // Schema for the call. The schema is reused across retry-with-
        // feedback rounds so we only build it once.
        const strictResponseSchema = ctx.useStrictResponseFormat
          ? {
              name: options.schemaName ?? "structured_output",
              schema: buildStrictJsonSchema(options.schema),
            }
          : undefined;

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
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
          ...(strictResponseSchema ? { strictResponseSchema } : { jsonMode: true }),
          stream: false,
        });
        const r = response as {
          model?: string;
          choices: Array<{ message: { content: string | null } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
        };
        // Accumulate usage across retry-with-feedback rounds so cost
        // reporting reflects every SDK call, not just the final one.
        // Matches runAgent's mergeTokenUsage pattern.
        lastUsage = mergeTokenUsage(lastUsage, parseUsage(r));
        lastModelId = r.model ?? modelId;
        const raw = r.choices[0]?.message.content ?? "";
        // If the response is empty after the executeChatRequest starvation
        // retry, the model produced no JSON to parse. Throw a typed
        // EmptyResponseError so the registry can route to a fallback model
        // instead of seeing JSON.parse("") raise SyntaxError wrapped as
        // ProviderUnavailableError. Mirrors @llm-ports/adapter-vercel.
        if (raw.trim().length === 0) {
          throw new EmptyResponseError(
            alias,
            lastModelId,
            "generateStructured needs a JSON body to parse. Increase maxOutputTokens or route to a fallback model.",
          );
        }
        const decoded = extractJSON(raw);
        let parsed = options.schema.safeParse(decoded);
        if (!parsed.success) {
          // Programmatic repair pass — catches the 6 common LLM output
          // quirks (null where not expected, "9" vs 9, "true" vs true, etc.)
          // before paying for a retry-with-feedback round-trip.
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
      }
      throw new Error("generateStructured exhausted attempts");
    },

    async *streamText(options: StreamTextOptions): AsyncIterable<string> {
      throwIfAborted(options.signal);
      validateContent(options.prompt);
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
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
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
      throwIfAborted(options.signal);
      validateContent(options.prompt);
      const stream = await executeChatStream(ctx.client, ctx, alias, pricing, {
        modelId,
        messages: [
          {
            role: "user",
            content: `${stringifyContentBlocks(options.prompt)}\n\nReply with a single JSON object only. Stream the JSON progressively.`,
          },
        ],
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        temperature: options.temperature ?? 0,
        ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
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
        for (let step = 0; step < maxSteps; step++) {
          // Re-check on each loop iteration so cancellation between steps
          // also propagates; mid-step in-flight cancellation comes from the
          // signal threaded into the SDK call.
          throwIfAborted(options.signal);
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
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
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
          totalUsage = mergeTokenUsage(totalUsage, parseUsage(r));
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
        const page = await ctx.client.models.list();
        // The OpenAI SDK returns a paginator; iterate to flatten.
        for await (const m of page) {
          const model = m as { id: string; owned_by?: string; created?: number };
          out.push({
            id: model.id,
            ...(model.owned_by ? { metadata: { owned_by: model.owned_by, created: model.created } } : {}),
          });
        }
        return out;
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
        const response = await withTransientAuthRetry(
          ctx,
          alias,
          () =>
            ctx.client.embeddings.create({
              model: modelId,
              input: options.input,
            }),
          modelId,
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
        throw wrapProviderError(alias, err);
      }
    },

    async generateEmbeddings(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
      const start = Date.now();
      try {
        const response = await withTransientAuthRetry(
          ctx,
          alias,
          () =>
            ctx.client.embeddings.create({
              model: modelId,
              input: options.inputs,
            }),
          modelId,
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
        throw wrapProviderError(alias, err);
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
  /**
   * When set, generateStructured uses `response_format: { type: "json_schema",
   * strict: true }` with this JSON Schema instead of classic
   * `response_format: { type: "json_object" }`. The schema must already have
   * `additionalProperties: false` on every nested object and `required: [...]`
   * on every property — those are caller-enforced via `buildStrictJsonSchema`.
   */
  strictResponseSchema?: { name: string; schema: Record<string, unknown> };
  /** Stream the response or not. */
  stream: boolean;
  /** Tools when this is an agent step. */
  tools?: ReturnType<typeof toOpenAITools>;
  /** Mid-flight cancellation: threaded as the 2nd arg to client.chat.completions.create. */
  signal?: AbortSignal;
  /**
   * Reasoning effort. Forwarded as `reasoning_effort` on the SDK call when
   * the model is a known reasoning model (o-series, gpt-5-nano, etc.) OR
   * the user explicitly opts in via this field. Non-reasoning models on
   * OpenAI native ignore the parameter; some compat providers (notably
   * Groq's `openai/gpt-oss-120b`) honor it.
   */
  reasoningEffort?: "low" | "medium" | "high";
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
  if (req.strictResponseSchema && !caps.jsonModeUnsupported) {
    // OpenAI / Cerebras strict JSON Schema mode: provider constrains
    // decoding to the schema before tokens are produced. Overrides plain
    // json_object when present.
    out["response_format"] = {
      type: "json_schema",
      json_schema: {
        name: req.strictResponseSchema.name,
        schema: req.strictResponseSchema.schema,
        strict: true,
      },
    };
  } else if (req.jsonMode && !caps.jsonModeUnsupported) {
    out["response_format"] = { type: "json_object" };
  }
  if (req.reasoningEffort !== undefined) {
    // OpenAI o-series + gpt-5-nano + Groq `openai/gpt-oss-120b` accept
    // `reasoning_effort: "low" | "medium" | "high"`. Compat providers
    // that don't honor it generally just ignore the field. We pass it
    // through verbatim; no per-model gating in v0.1.
    out["reasoning_effort"] = req.reasoningEffort;
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
  // `response_format` rejection covers BOTH paths:
  //   - legacy `{ type: "json_object" }` (req.jsonMode)
  //   - alpha.9+ strict `{ type: "json_schema", strict: true }` (req.strictResponseSchema)
  // Either way, the model has told us it doesn't accept any `response_format`
  // shape we know how to send — so flip `jsonModeUnsupported` and the next
  // call will omit the field entirely.
  if (isJsonModeRejection(err) && (req.jsonMode || req.strictResponseSchema)) {
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
  alias: string,
  fn: () => Promise<T>,
  modelId: string,
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
        const delayMs = ctx.transientAuthBackoffMs(attempt);
        emitRetry(ctx, {
          reason: "transient-auth",
          attempt,
          modelId,
          providerAlias: alias,
          delayMs,
          cause: err,
        });
        await sleep(delayMs);
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
 * Anything else propagates as ProviderUnavailableError via {@link wrapProviderError}.
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
    // Thread the AbortSignal as the SDK's 2nd-arg request options; the OpenAI
    // SDK uses this to cancel the in-flight fetch on abort.
    const reqOpts = req.signal ? { signal: req.signal } : undefined;
    return await client.chat.completions.create(sdkReq as never, reqOpts);
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
        emitRetry(ctx, {
          reason: "reasoning-starvation",
          attempt: 0,
          modelId: req.modelId,
          providerAlias: alias,
          delayMs: 0,
        });
        try {
          const retried = await attempt();
          ctx.hasSucceeded.value = true;
          learnFromResponse(req.modelId, retried);
          return { response: retried, modelId: req.modelId };
        } catch (retryErr) {
          throw wrapProviderError(alias, retryErr);
        }
      }

      return { response, modelId: req.modelId };
    } catch (err) {
      if (
        isTransientAuthError(err, ctx) &&
        transientRetries < ctx.transientAuthRetries
      ) {
        // Exponential backoff: 500ms, 1500ms, 4500ms... up to maxRetries
        const delayMs = ctx.transientAuthBackoffMs(transientRetries);
        emitRetry(ctx, {
          reason: "transient-auth",
          attempt: transientRetries,
          modelId: req.modelId,
          providerAlias: alias,
          delayMs,
          cause: err,
        });
        await sleep(delayMs);
        transientRetries++;
        continue;
      }
      if (!triedCapabilityFallback && learnConstraintsFromError(err, req)) {
        emitRetry(ctx, {
          reason: "capability-fallback",
          attempt: 0,
          modelId: req.modelId,
          providerAlias: alias,
          delayMs: 0,
          cause: err,
        });
        triedCapabilityFallback = true;
        continue;
      }
      throw wrapProviderError(alias, err);
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
    const reqOpts = streamReq.signal ? { signal: streamReq.signal } : undefined;
    return (await client.chat.completions.create(sdkReq as never, reqOpts)) as never;
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
        const delayMs = ctx.transientAuthBackoffMs(transientRetries);
        emitRetry(ctx, {
          reason: "transient-auth",
          attempt: transientRetries,
          modelId: streamReq.modelId,
          providerAlias: alias,
          delayMs,
          cause: err,
        });
        await sleep(delayMs);
        transientRetries++;
        continue;
      }
      if (!triedCapabilityFallback && learnConstraintsFromError(err, streamReq)) {
        emitRetry(ctx, {
          reason: "capability-fallback",
          attempt: 0,
          modelId: streamReq.modelId,
          providerAlias: alias,
          delayMs: 0,
          cause: err,
        });
        triedCapabilityFallback = true;
        continue;
      }
      throw wrapProviderError(alias, err);
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
 * Convert a Zod schema to the JSON Schema shape OpenAI's tool-use API
 * expects (`parameters: { type: "object", properties: { ... }, required: [...] }`).
 *
 * Uses `zod-to-json-schema` with the OpenAI target so output is the
 * exact dialect OpenAI accepts (no draft-07 `$schema` header, no
 * `additionalProperties` injected unless the schema declares it, etc.).
 *
 * Falls back to the `{ type: "object", properties: {} }` shape if the
 * schema is not a Zod schema or if conversion fails — defensive
 * fallback so a malformed tool definition doesn't crash the agent loop.
 */
function zodToParameters(schema: unknown): {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
} {
  try {
    const json = zodToJsonSchema(schema as never, {
      target: "openAi",
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

/**
 * Build the JSON Schema for OpenAI / Cerebras strict response_format mode
 * from a Zod schema. Strict mode requires:
 *   - Every object: `additionalProperties: false`
 *   - Every object: ALL declared properties listed in `required` (no optionals)
 *   - No unsupported JSON Schema features (oneOf is supported as anyOf,
 *     allOf must be flattened, $ref must be inlined)
 *
 * We use `$refStrategy: "none"` to inline refs, then post-process to add
 * the `additionalProperties: false` invariant on every nested object. The
 * `required` field is left as-is — Zod-emitted JSON Schema marks every
 * required field correctly. Optional Zod fields stay optional; callers
 * who hit Cerebras's "all-fields-required" enforcement should either
 * mark fields required in Zod or use `.default()`.
 */
function buildStrictJsonSchema(schema: unknown): Record<string, unknown> {
  let json: Record<string, unknown>;
  try {
    json = zodToJsonSchema(schema as never, {
      target: "openAi",
      $refStrategy: "none",
    }) as Record<string, unknown>;
  } catch {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return enforceStrictDialect(json);
}

function enforceStrictDialect(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === "$schema") continue;
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        props[k] = enforceStrictDialect(v);
      }
      out[key] = props;
      continue;
    }
    if (key === "items" && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = enforceStrictDialect(value);
      continue;
    }
    if (key === "anyOf" && Array.isArray(value)) {
      out[key] = value.map((v) => enforceStrictDialect(v));
      continue;
    }
    out[key] = value;
  }
  if (out["type"] === "object" && out["additionalProperties"] === undefined) {
    out["additionalProperties"] = false;
  }
  return out;
}
