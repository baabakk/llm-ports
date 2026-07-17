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
  attemptValidationRepair,
  computeChatCost,
  emitRetryEvent,
  extractJSON,
  failValidation,
  mergeTokenUsage,
  NonContiguousSystemError,
  throwIfAborted,
  tryParsePartialJSON,
  validateImageBlocks,
  wrapProviderError,
  type AgentResult,
  type ContentBlock,
  type MessageContent,
  type GenerateStructuredOptions,
  type GenerateStructuredResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type LLMMessage,
  type LLMPort,
  type ModelPricing,
  type OnRetry,
  type ProviderModelInfo,
  type RunAgentOptions,
  type StreamStructuredOptions,
  type StreamTextOptions,
  type ToolDefinition,
  type TokenUsage,
  type ValidationStrategy,
} from "@llm-ports/core";
import { ANTHROPIC_PRICING } from "./pricing.js";
import { applyAnthropicCacheControl } from "./cache-control.js";
import {
  extractAssistantText,
  fromAnthropicContent,
  toAnthropicContent,
  toAnthropicMessages,
  type AnthropicMessage,
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
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
   * Maximum bytes per base64 image. Defaults to 5MB (Anthropic's per-image
   * limit). Set to 0 or a negative number to disable size validation.
   */
  imageSizeLimitBytes?: number;
  /**
   * Set to `true` to allow the Anthropic SDK to run in a browser environment.
   * The SDK refuses by default to prevent accidental exposure of API keys.
   * When enabled, the client automatically includes the
   * `anthropic-dangerous-direct-browser-access: true` header.
   *
   * Only enable this when you understand the risk and have a mitigation in
   * place: a server-side proxy that strips keys from the request before
   * forwarding, a "bring your own API key" UI where users supply their own
   * key, or an internal tool exposed only to trusted users.
   *
   * Available since `0.1.0-alpha.9`.
   */
  dangerouslyAllowBrowser?: boolean;
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
  /** Retained for listModels() which hits /v1/models directly (SDK <0.39 lacks client.models). */
  apiKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
  validationStrategy: ValidationStrategy;
  pricingOverrides: Record<string, ModelPricing>;
  /** 0 means "no size check"; positive number is the per-image byte limit. */
  imageSizeLimitBytes: number;
  onRetry?: OnRetry;
}

function makeClient(opts: AnthropicAdapterOptions): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.fetch ? { fetch: opts.fetch as Anthropic["fetch"] } : {}),
    ...(opts.dangerouslyAllowBrowser ? { dangerouslyAllowBrowser: true } : {}),
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
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    validationStrategy: opts.validationStrategy ?? {
      kind: "retry-with-feedback",
      maxAttempts: 2,
      includeOriginalError: true,
    },
    pricingOverrides: opts.pricingOverrides ?? {},
    imageSizeLimitBytes: opts.imageSizeLimitBytes ?? 5 * 1024 * 1024,
    ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
  };

  return {
    name: "anthropic",
    pricing: mergedPricing,
    createLLMPort: (modelId, alias) => createPort(ctx, modelId, alias),
  };
}

// ─── The port implementation ─────────────────────────────────────────

/**
 * Resolve the canonical `messages` array (alpha.27+) into Anthropic's shape:
 * a top-level `system` string (concatenated from leading contiguous
 * system-role messages) plus an `AnthropicMessage[]` array of the rest.
 *
 * Anthropic's `system` field is structurally separate from `messages`. The
 * provider rejects a `messages` array that contains a system-role message
 * after any user or assistant message. This helper enforces the constraint
 * at the adapter boundary: leading contiguous system-role messages fold
 * into `system`; any system-role message appearing after a non-system
 * message throws `NonContiguousSystemError` with the offending index.
 *
 * Added in `0.1.0-alpha.27`.
 */
function resolveMessagesForAnthropic(
  alias: string,
  method: string,
  options: { messages: LLMMessage[] },
): { messages: AnthropicMessage[]; system: string | undefined } {
  const arr = options.messages;
  const leadingSystem: string[] = [];
  let i = 0;
  while (i < arr.length && arr[i]!.role === "system") {
    const content = arr[i]!.content;
    if (typeof content === "string") {
      leadingSystem.push(content);
    } else {
      const textFragments: string[] = [];
      let hasNonText = false;
      for (const block of content) {
        if ((block as { type: string }).type === "text") {
          textFragments.push((block as { text: string }).text);
        } else {
          hasNonText = true;
        }
      }
      if (hasNonText) break;
      leadingSystem.push(textFragments.join(""));
    }
    i++;
  }
  const system = leadingSystem.length > 0 ? leadingSystem.join("\n\n") : undefined;
  const remaining = arr.slice(i);
  // Assert: NO system-role messages in the remaining array. Anthropic rejects
  // non-leading system messages structurally.
  for (let j = 0; j < remaining.length; j++) {
    if (remaining[j]!.role === "system") {
      throw new NonContiguousSystemError(alias, method, i + j);
    }
  }
  const messages: AnthropicMessage[] = remaining.map((m) => ({
    role: m.role === "tool" ? "user" : (m.role as "user" | "assistant"),
    content: toAnthropicContent(m.content),
  }));
  return system !== undefined ? { messages, system } : { messages, system: undefined };
}

function createPort(ctx: AdapterContext, modelId: string, alias: string): LLMPort {
  const pricing = pricingFor(ctx, modelId);
  // Validate image blocks in any outgoing prompt/messages. Throws typed
  // ImageTooLargeError or InvalidImageUrlError at the adapter boundary so
  // callers see a meaningful error instead of an opaque provider 4xx.
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
    signal?: AbortSignal,
  ): Promise<R> {
    const userCapabilities = ctx.pricingOverrides[modelId]?.capabilities;
    let caps = getEffectiveCapabilities(modelId, userCapabilities);
    let attempt = 0;
    // Anthropic SDK accepts a `signal` in the 2nd-arg request options;
    // threading it here cancels the in-flight fetch on abort.
    const reqOpts = signal ? { signal } : undefined;
    // Single capability-fallback retry per call (the user-visible bug fix).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const req = buildRequest({ temperatureLocked: caps.temperatureLocked });
      try {
        return (await ctx.client.messages.create(req, reqOpts)) as R;
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
      throwIfAborted(options.signal);
      const start = Date.now();
      // alpha.27+: canonical messages input. Anthropic splits system into a
      // top-level field; leading contiguous system messages fold there.
      const { messages: chatMessages, system } = resolveMessagesForAnthropic(
        alias,
        "generateText",
        { messages: options.messages! },
      );
      try {
        const response = await executeMessageCreate<Anthropic.Messages.Message>(
          (caps) =>
            applyAnthropicCacheControl(
              applyCapabilityFilter(
                {
                  model: modelId,
                  max_tokens: options.maxOutputTokens ?? 1024,
                  ...(system !== undefined ? { system } : {}),
                  ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
                  messages: chatMessages as never,
                },
                caps,
              ),
              options.cacheControl,
            ),
          options.signal,
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
      throwIfAborted(options.signal);
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

      // alpha.27+: resolve messages once outside the retry loop.
      const { messages: baseMessages, system } = resolveMessagesForAnthropic(
        alias,
        "generateStructured",
        { messages: options.messages! },
      );
      const jsonDirective =
        "Reply with a single JSON object that matches the requested schema. Do not include any prose, explanation, or code fences. Only the JSON.";

      while (attempts < maxAttempts) {
        attempts++;
        try {
          // Append JSON directive (first attempt) or correction prompt (retry)
          // as a trailing user message.
          const trailingUserContent = correctionPrompt ?? jsonDirective;
          const requestMessages: AnthropicMessage[] = [
            ...baseMessages,
            { role: "user", content: trailingUserContent },
          ];
          const response = await executeMessageCreate<Anthropic.Messages.Message>(
            (caps) =>
              applyAnthropicCacheControl(
                applyCapabilityFilter(
                  {
                    model: modelId,
                    max_tokens: options.maxOutputTokens ?? 2048,
                    ...(system !== undefined ? { system } : {}),
                    temperature: options.temperature ?? 0,
                    messages: requestMessages as never,
                  },
                  caps,
                ),
                options.cacheControl,
              ),
            options.signal,
          );
          // Accumulate usage across retry-with-feedback rounds so cost
          // reporting reflects every SDK call, not just the final one.
          // Matches runAgent's mergeTokenUsage pattern.
          lastUsage = mergeTokenUsage(lastUsage, parseUsage(response));
          lastModelId = response.model ?? modelId;
          const raw = extractAssistantText(response.content as never);
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
      throwIfAborted(options.signal);
      // alpha.27+: canonical messages input.
      const { messages: chatMessages, system } = resolveMessagesForAnthropic(
        alias,
        "streamText",
        { messages: options.messages! },
      );
      // Apply learned capabilities up front for the streaming call. Streaming
      // retries on capability rejection are not yet supported (mid-stream
      // retry requires buffering the entire response, which defeats the point
      // of streaming). The pre-applied capabilities cover the known cases.
      const userCapabilities = ctx.pricingOverrides[modelId]?.capabilities;
      const caps = getEffectiveCapabilities(modelId, userCapabilities);
      try {
        const stream = ctx.client.messages.stream(
          applyAnthropicCacheControl(
            {
              model: modelId,
              max_tokens: options.maxOutputTokens ?? 1024,
              ...(system !== undefined ? { system } : {}),
              ...(options.temperature !== undefined && !caps.temperatureLocked
                ? { temperature: options.temperature }
                : {}),
              messages: chatMessages as never,
            },
            options.cacheControl,
          ) as Parameters<typeof ctx.client.messages.stream>[0],
          options.signal ? { signal: options.signal } : undefined,
        );
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
      throwIfAborted(options.signal);
      // alpha.27+: canonical messages input. Append the streaming-JSON
      // directive as a trailing user message.
      const { messages: baseMessages, system } = resolveMessagesForAnthropic(
        alias,
        "streamStructured",
        { messages: options.messages! },
      );
      const requestMessages: AnthropicMessage[] = [
        ...baseMessages,
        {
          role: "user",
          content:
            "Reply with a single JSON object that matches the requested schema. Stream the JSON progressively.",
        },
      ];
      // Anthropic doesn't stream parsed JSON natively. We accumulate text deltas
      // and best-effort parse a partial JSON object after each chunk.
      const userCapabilities = ctx.pricingOverrides[modelId]?.capabilities;
      const caps = getEffectiveCapabilities(modelId, userCapabilities);
      try {
        const stream = ctx.client.messages.stream(
          applyAnthropicCacheControl(
            {
              model: modelId,
              max_tokens: options.maxOutputTokens ?? 2048,
              ...(system !== undefined ? { system } : {}),
              // Omit temperature on models that reject it; otherwise default to 0
              // for deterministic JSON parsing.
              ...(caps.temperatureLocked ? {} : { temperature: options.temperature ?? 0 }),
              messages: requestMessages as never,
            },
            options.cacheControl,
          ) as Parameters<typeof ctx.client.messages.stream>[0],
          options.signal ? { signal: options.signal } : undefined,
        );
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
          // Re-check between agent steps so cancellation propagates even if
          // the model just emitted a tool call but the user clicked cancel
          // before we send the result back.
          throwIfAborted(options.signal);
          stepsTaken = step + 1;
          const { system, messages } = toAnthropicMessages(conversation);
          const response = await executeMessageCreate<Anthropic.Messages.Message>(
            (caps) =>
              applyAnthropicCacheControl(
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
                options.cacheControl,
              ),
            options.signal,
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

    async listModels(): Promise<ProviderModelInfo[]> {
      try {
        // Direct fetch to /v1/models. The Anthropic SDK <0.39 didn't expose
        // `client.models.list()`; we hit the REST endpoint to keep peer-dep
        // compatibility with the alpha-era SDK floor.
        const fetchFn = ctx.fetch ?? globalThis.fetch;
        if (!fetchFn) {
          throw new Error("No fetch implementation available for listModels()");
        }
        const baseURL = ctx.baseURL ?? "https://api.anthropic.com";
        const resp = await fetchFn(`${baseURL.replace(/\/+$/, "")}/v1/models?limit=1000`, {
          headers: {
            "x-api-key": ctx.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
        });
        if (!resp.ok) {
          throw new Error(`Anthropic /v1/models returned ${resp.status} ${resp.statusText}`);
        }
        const body = (await resp.json()) as {
          data?: Array<{ id: string; display_name?: string; created_at?: string }>;
        };
        return (body.data ?? []).map((m) => ({
          id: m.id,
          ...(m.display_name ? { displayName: m.display_name } : {}),
          ...(m.created_at ? { metadata: { created_at: m.created_at } } : {}),
        }));
      } catch (err) {
        throw wrapProviderError(alias, err);
      }
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
