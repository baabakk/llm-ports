/**
 * LLMPort interface — the SDK-independent surface that business logic
 * depends on. All adapters implement this interface.
 *
 * The five methods correspond to the five primitive operations every major
 * LLM provider exposes: text generation, structured output, agent tool-use
 * loops, streaming text, and streaming structured output.
 *
 * Embeddings are intentionally split into a sibling EmbeddingsPort (see
 * embeddings-port.ts) because most chat adapters do not implement them
 * and most embedding-only adapters do not implement chat.
 *
 * See implementation plan v3 §6.2.
 */

import type { z } from "zod";
import type { MessageContent } from "../content/blocks.js";
import type { BudgetScopeRef } from "../budget/types.js";

// ─── Routing primitives ───────────────────────────────────────────────

/**
 * Task type. Free-form string; users define their own vocabulary.
 * For type-safe usage with autocomplete, see `declareTasks<T>()`.
 */
export type TaskType = string;

/** Priority tier. 0 = critical (bypasses budget gating); 3 = low. */
export type LLMPriority = 0 | 1 | 2 | 3;

// ─── Artifact references (alpha.25+) ──────────────────────────────────

/**
 * A caller-owned identifier for a versioned or identifiable artifact that
 * should be attributed to this call: a prompt, a scaffold, a policy, a tool
 * schema, a cost-attribution tag, an experiment variant, a session id, a
 * tenant, whatever the consumer versions or tracks.
 *
 * Every field is optional. Callers set the ones that make sense for their
 * artifact identity. Common conventions the ecosystem is converging on:
 *   - `key`     — human-readable canonical name (`"team-dev.materialize"`)
 *   - `version` — integer, semver, git SHA, timestamp — whatever the
 *                 consumer's versioning scheme uses
 *   - `hash`    — content hash for tamper-evidence (`sha256` recommended)
 *   - `meta`    — free-form bag for consumer-specific attribution
 *
 * llm-ports does NOT enforce shape, vocabulary, or content. Refs are
 * consumer-owned trace metadata that flow through to observability events
 * unchanged.
 *
 * Added in `0.1.0-alpha.25`.
 */
export interface ArtifactRef {
  /** Human-readable identifier — the artifact's canonical name. Optional. */
  key?: string;
  /** Version — integer, semver, git SHA, timestamp, whatever the consumer uses. */
  version?: string | number;
  /** Content hash for tamper-evidence and correlation. sha256 recommended but not enforced. */
  hash?: string;
  /** Free-form metadata for consumer-specific attribution. */
  meta?: Record<string, unknown>;
}

// ─── Message and tool primitives ──────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface LLMMessage {
  role: MessageRole;
  content: MessageContent;
}

/** A tool the model may invoke during runAgent. */
export interface ToolDefinition<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TParams;
  execute: (input: z.infer<TParams>) => Promise<unknown>;
  /** Signals "this writes/deletes state". Used by createAgent to gate execution. */
  destructive?: boolean;
  /** When true, agent must obtain user approval before execution. */
  requiresConfirmation?: boolean;
  /** Truncate tool output to prevent context flooding. */
  maxOutputBytes?: number;
}

// ─── Usage and cost ───────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  /**
   * Tokens emitted by the model. For "standard" chat models, this is the
   * visible response length. For reasoning models (OpenAI o-series, gpt-5-nano,
   * etc.), this INCLUDES reasoning_tokens — the model's internal chain-of-
   * thought tokens that don't appear in `text` but are billed at the output
   * rate. Use {@link reasoningTokens} to break out the reasoning portion.
   */
  outputTokens: number;
  totalTokens: number;
  /** Tokens read from prompt cache (Anthropic + OpenAI feature). */
  cacheReadTokens?: number;
  /** Tokens written to prompt cache (Anthropic explicit caching). */
  cacheWriteTokens?: number;
  /**
   * Reasoning tokens (subset of outputTokens). Only populated for reasoning
   * models that report it via the provider API. When set, visible output
   * tokens = outputTokens - reasoningTokens. Useful for cost attribution
   * and for diagnosing "model used all the budget on thinking" cases.
   */
  reasoningTokens?: number;
  /**
   * Rerank-specific billing unit. Set by `RerankPort` adapters whose
   * provider bills per "search unit" rather than per token (e.g. Cohere
   * Rerank: 1 search unit = 1 query of ≤100 documents). Adapters whose
   * rerank API bills in tokens populate `inputTokens` instead.
   * (alpha.17+)
   */
  searchUnits?: number;
  /**
   * Count of documents reranked in this call. Telemetry only; not used
   * for billing. Populated by `RerankPort` adapters; undefined for
   * LLMPort and EmbeddingsPort calls. (alpha.17+)
   */
  rerankedDocuments?: number;
}

export interface CostUsage {
  inputUSD: number;
  outputUSD: number;
  totalUSD: number;
  /**
   * USD saved on this call by hitting prompt cache, vs. paying the full
   * input rate for the cached tokens. Populated whenever the provider
   * returns cache telemetry (cacheReadTokens > 0). Aligns with
   * OpenInference `llm.cost.cache_savings` and Helicone's "savings"
   * vocabulary used in their dashboards.
   *
   * Renamed from `cacheDiscountUSD` in alpha.19 (BREAKING). The previous
   * name implied a vendor-applied discount; "savings" better reflects
   * that this is the caller-visible reduction in their bill regardless
   * of how the provider books it on its side. See CHANGELOG alpha.19.
   */
  cacheSavingsUSD?: number;
}

// ─── Cache control (alpha.19+) ────────────────────────────────────────

/**
 * Provider-neutral cache configuration for a single call. Locks the
 * shape across the three caching patterns the major providers expose:
 *
 *   - Anthropic's explicit `cache_control` markers on message blocks.
 *   - OpenAI's implicit, automatic prompt cache (no opt-in / opt-out).
 *   - Google Gemini's pre-created `CachedContent` handle pattern.
 *
 * `mode` selects which pattern to engage for this call:
 *
 *   - `"auto"`: let the adapter decide. Anthropic places a cache_control
 *     marker at the last static block when one is identifiable. OpenAI
 *     is a no-op (implicit caching is always on). Google is a no-op
 *     unless `cachedContentHandle` is supplied.
 *
 *   - `"manual"`: caller supplies explicit `breakpoints`. Anthropic
 *     places cache_control at the named positions. OpenAI is a no-op
 *     (cannot influence the implicit cache). Google is a no-op.
 *
 *   - `"preCreated"`: caller supplies a `cachedContentHandle` returned
 *     from a previous `createCachedContent` call. Google uses the
 *     handle to serve the cached content. Anthropic + OpenAI are
 *     no-ops.
 *
 *   - `"off"`: strip cache_control from Anthropic message blocks for
 *     this call only. OpenAI + Google are no-ops (no API to disable
 *     their caching).
 *
 * `namespace` partitions cache lookups by tenant or customer when the
 * proxy in front of the provider supports it (e.g. Helicone's
 * `Cache-Seed` header). The adapter forwards it where supported and
 * ignores it elsewhere; it never changes the provider request body.
 *
 * Stability: SHAPE LOCKED in alpha.19. Per-mode adapter behaviors will
 * mature across beta minors (full breakpoint placement, Gemini handle
 * lifecycle, OpenAI proxy namespace forwarding) without breaking the
 * shape.
 *
 * See `docs/concepts/cache.md` for the per-provider behavior table.
 */
export interface CacheControl {
  /**
   * Which caching pattern to engage for this call.
   *
   *   - `"auto"` — adapter decides per provider; sane default for most callers.
   *   - `"manual"` — caller supplies explicit `breakpoints` (Anthropic).
   *   - `"preCreated"` — caller supplies a `cachedContentHandle` (Google).
   *   - `"off"` — caller opts out where the provider allows (Anthropic).
   */
  mode: "auto" | "manual" | "preCreated" | "off";

  /**
   * TTL in seconds for cache entries created by this call. Anthropic
   * accepts the discrete values `300` (5 minutes) and `3600` (1 hour);
   * other values fall back to `300`. Google Gemini accepts an arbitrary
   * positive value subject to the provider's minimum. Ignored by OpenAI.
   */
  ttlSeconds?: number;

  /**
   * Explicit cache_control placement for `mode: "manual"`. Each entry
   * names a position in the message stack where the adapter should
   * insert a cache_control marker. `at` selects the section; `index`
   * picks a specific block within that section (0-based) when the
   * section has more than one block.
   *
   * Only honored by adapters that support explicit breakpoints
   * (currently Anthropic). Silently ignored elsewhere.
   */
  breakpoints?: Array<{ at: "tools" | "system" | "message-index"; index?: number }>;

  /**
   * Pre-created cache handle for `mode: "preCreated"`. Returned by a
   * previous `createCachedContent` call (Google Gemini). The adapter
   * sends the handle as the source of the cached content for this
   * call. Required for `mode: "preCreated"` on Google; silently
   * ignored elsewhere.
   */
  cachedContentHandle?: string;

  /**
   * Per-tenant cache partition key. When the request flows through a
   * caching proxy that supports partition keys (e.g. Helicone's
   * `Cache-Seed` header), the adapter forwards this value verbatim.
   * Adapters without proxy-aware caching ignore the field. Never
   * changes the provider request body.
   */
  namespace?: string;
}

// ─── Request option types ─────────────────────────────────────────────

/**
 * `signal?: AbortSignal` is supported on every options interface in
 * `0.1.0-alpha.6` and later. When supplied:
 *
 *   1. The adapter checks `signal.aborted` at entry; if already aborted,
 *      it throws `signal.reason` (or a generic `AbortError`) without
 *      invoking the provider SDK.
 *   2. The adapter threads the signal through to the underlying SDK call
 *      (OpenAI, Anthropic, Ollama, Vercel, Google), so an in-flight
 *      provider HTTP request is cancelled on `controller.abort()` instead
 *      of leaking the cost.
 *
 * Cancellation semantics are best-effort and per-adapter; some SDKs return
 * a typed `AbortError`, others reject with the original `signal.reason`.
 * Callers should `catch` and inspect the error rather than assume one shape.
 *
 * `forceProviderAlias?: string` (alpha.7+) overrides the task-routing chain
 * for this call only. The registry routes directly to the named provider
 * alias, skipping the `LLM_TASK_ROUTE_*` lookup. Per-provider budget gates
 * still apply (so `forceProviderAlias` can't be used to bypass a hard cap);
 * runtime fallback also does NOT engage — if the forced provider fails, the
 * error propagates. Useful for UIs where the operator picks a specific
 * provider, or for one-off "use the expensive model for this single call"
 * patterns.
 *
 * `reasoningEffort?: "low" | "medium" | "high"` (alpha.12+) controls how many
 * tokens reasoning models spend on hidden chain-of-thought before producing
 * visible output. Forwarded as the `reasoning_effort` field on OpenAI-shape
 * requests — applies to OpenAI's `o3`/`o4-mini`/`gpt-5-nano`/`gpt-5` family
 * and to OpenAI-compat providers that honor the parameter (notably Groq's
 * `openai/gpt-oss-120b`). Silently ignored by adapters whose providers don't
 * have an equivalent (anthropic, ollama, google, vercel) — the call still
 * succeeds, just with the provider's default effort level.
 *
 * `providerExtras?: Record<string, unknown>` (alpha.16+) is a per-call escape
 * hatch for provider-specific request fields not (yet) modeled on the port.
 * Adapters that implement it shallow-merge the field into the SDK request
 * body AFTER the typed port fields are set, so callers can override
 * port-modeled defaults if they need to. Field semantics are provider-
 * specific and not validated by the port. Common patterns documented in
 * each adapter's docs (e.g. `adapter-openai` covers vLLM `chat_template_
 * kwargs`, SGLang `regex`, vLLM `guided_json` for non-strict structured
 * decoding). Generic on purpose — keeps the public type signature vendor-
 * neutral while letting users reach any per-server / per-model knob.
 */

export interface GenerateTextOptions {
  taskType: TaskType;
  priority?: LLMPriority;
  /**
   * The canonical input shape (alpha.26+). A sequence of chat messages with
   * explicit roles that flow through to the provider's chat-completions
   * endpoint natively. Supports multi-turn conversations, multiple system
   * messages, and mid-conversation context — anything the underlying protocol
   * models. Every adapter passes the array through with per-provider
   * translation (Anthropic splits system into a top-level field, Google uses
   * `systemInstruction`, OpenAI keeps system inline).
   *
   * Construct via `[sys(text), usr(content)]`, or migrate the legacy shape
   * via `toMessages(instructions, prompt)`. See
   * `docs/migration/alpha-25-to-alpha-26.md` for the full story.
   *
   * When both `messages` and the legacy `{ instructions, prompt }` are set,
   * the Registry throws `MessagesConflictError` — ambiguity is a caller bug
   * worth surfacing.
   */
  messages: LLMMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Cancellation signal threaded through to the provider's HTTP fetch. */
  signal?: AbortSignal;
  /** Override task routing for this call only; route directly to the named provider alias. Per-provider budget gates still apply. (alpha.7+) */
  forceProviderAlias?: string;
  /** Reasoning effort hint for o-series / gpt-5-nano / Groq gpt-oss-120b. Silently ignored by adapters whose providers don't honor it. (alpha.12+) */
  reasoningEffort?: "low" | "medium" | "high";
  /** Per-call escape hatch for provider-specific request fields not modeled on the port. Shallow-merged into the SDK request body after typed fields. (alpha.16+) */
  providerExtras?: Record<string, unknown>;
  /** Provider-neutral cache configuration. Shape locked in alpha.19. */
  cacheControl?: CacheControl;
  /**
   * Per-call scope hint. When set, the Registry hashes (scope, scopeId)
   * into the gating storage key so configured caps apply per-scope rather
   * than per-alias. Omitting it preserves alpha.19.1 per-alias behavior.
   * (alpha.20+)
   */
  budgetScope?: BudgetScopeRef;
  /**
   * Reference tags flowing through to observability events. (alpha.25+)
   *
   * Consumer-owned, keyed map of ArtifactRefs — each ref describes an
   * artifact whose identity should be attributed to this call: a prompt,
   * a scaffold, a policy, a tool schema, a cost-attribution tag, an
   * experiment variant, a session id — anything the consumer versions,
   * tags, or wants stamped onto trace.
   *
   * Refs are observability-only:
   *   - They flow through to the `refs` field on onCost / onTokenUsage /
   *     onFallback / onCacheHit / onValidationRetry events.
   *   - NOT sent to the model.
   *   - NOT persisted anywhere by the library.
   *   - NOT validated (empty object is legal; missing keys are legal).
   *
   * llm-ports enforces no vocabulary — consumer picks the keys. Common
   * conventions the ecosystem is converging on: `prompt`, `scaffold`,
   * `policy`, `tool_schema`, `model_config`, `experiment`, `session`,
   * `tenant`, `env`, `deploy`.
   */
  refs?: Record<string, ArtifactRef>;
}

export interface GenerateStructuredOptions<T> {
  taskType: TaskType;
  priority?: LLMPriority;
  /** Canonical alpha.26+ input. See `GenerateTextOptions.messages`. */
  messages: LLMMessage[];
  schema: z.ZodType<T>;
  /** Hint for the model about what the schema represents. */
  schemaName?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Cancellation signal threaded through to the provider's HTTP fetch. */
  signal?: AbortSignal;
  /** Override task routing for this call only; route directly to the named provider alias. Per-provider budget gates still apply. (alpha.7+) */
  forceProviderAlias?: string;
  /** Reasoning effort hint for o-series / gpt-5-nano / Groq gpt-oss-120b. Silently ignored by adapters whose providers don't honor it. (alpha.12+) */
  reasoningEffort?: "low" | "medium" | "high";
  /** Per-call escape hatch for provider-specific request fields not modeled on the port. Shallow-merged into the SDK request body after typed fields. (alpha.16+) */
  providerExtras?: Record<string, unknown>;
  /** Provider-neutral cache configuration. Shape locked in alpha.19. */
  cacheControl?: CacheControl;
  /**
   * Per-call scope hint. When set, the Registry hashes (scope, scopeId)
   * into the gating storage key so configured caps apply per-scope rather
   * than per-alias. Omitting it preserves alpha.19.1 per-alias behavior.
   * (alpha.20+)
   */
  budgetScope?: BudgetScopeRef;
  /**
   * Per-call override for strict-schema response_format mode. (alpha.21+)
   *
   *   - `true`  → force strict `response_format: { type: "json_schema", strict: true }`
   *   - `false` → force classic `response_format: { type: "json_object" }`
   *   - undefined → use the adapter's existing default (auto-detected per baseURL
   *     allowlist, or whatever `useStrictResponseFormat` was set to at construction)
   *
   * Adapters that do not implement strict mode (or whose backing provider
   * doesn't support it) MUST silently ignore this hint rather than throw.
   *
   * Use case: a registry has one adapter alias per provider, but a single
   * caller knows the schema for THIS call carries `z.record(...)` (open
   * dictionary, strict-incompatible) and wants to drop to `json_object` for
   * this call; or the caller knows the schema is closed-shape and wants to
   * force strict to eliminate retry tails on cheap-tier providers where the
   * adapter's auto-detect defaulted to `json_object`. See llm-ports#46.
   */
  strict?: boolean;
  /** Consumer-owned artifact reference tags flowing through to observability events. See `GenerateTextOptions.refs`. (alpha.25+) */
  refs?: Record<string, ArtifactRef>;
}

export interface StreamTextOptions {
  taskType: TaskType;
  priority?: LLMPriority;
  /** Canonical alpha.26+ input. See `GenerateTextOptions.messages`. */
  messages: LLMMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Cancellation signal threaded through to the provider's HTTP fetch. */
  signal?: AbortSignal;
  /** Override task routing for this call only; route directly to the named provider alias. Per-provider budget gates still apply. (alpha.7+) */
  forceProviderAlias?: string;
  /** Reasoning effort hint for o-series / gpt-5-nano / Groq gpt-oss-120b. Silently ignored by adapters whose providers don't honor it. (alpha.12+) */
  reasoningEffort?: "low" | "medium" | "high";
  /** Per-call escape hatch for provider-specific request fields not modeled on the port. Shallow-merged into the SDK request body after typed fields. (alpha.16+) */
  providerExtras?: Record<string, unknown>;
  /** Provider-neutral cache configuration. Shape locked in alpha.19. */
  cacheControl?: CacheControl;
  /**
   * Per-call scope hint. When set, the Registry hashes (scope, scopeId)
   * into the gating storage key so configured caps apply per-scope rather
   * than per-alias. Omitting it preserves alpha.19.1 per-alias behavior.
   * (alpha.20+)
   */
  budgetScope?: BudgetScopeRef;
  /** Consumer-owned artifact reference tags flowing through to observability events. See `GenerateTextOptions.refs`. (alpha.25+) */
  refs?: Record<string, ArtifactRef>;
}

export interface StreamStructuredOptions<T> {
  taskType: TaskType;
  priority?: LLMPriority;
  /** Canonical alpha.26+ input. See `GenerateTextOptions.messages`. */
  messages: LLMMessage[];
  schema: z.ZodType<T>;
  schemaName?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Cancellation signal threaded through to the provider's HTTP fetch. */
  signal?: AbortSignal;
  /** Override task routing for this call only; route directly to the named provider alias. Per-provider budget gates still apply. (alpha.7+) */
  forceProviderAlias?: string;
  /** Reasoning effort hint for o-series / gpt-5-nano / Groq gpt-oss-120b. Silently ignored by adapters whose providers don't honor it. (alpha.12+) */
  reasoningEffort?: "low" | "medium" | "high";
  /** Per-call escape hatch for provider-specific request fields not modeled on the port. Shallow-merged into the SDK request body after typed fields. (alpha.16+) */
  providerExtras?: Record<string, unknown>;
  /** Provider-neutral cache configuration. Shape locked in alpha.19. */
  cacheControl?: CacheControl;
  /**
   * Per-call override for strict-schema response_format mode. (alpha.21+)
   * Same semantics as on `GenerateStructuredOptions`. See that field's docstring.
   */
  strict?: boolean;
  /**
   * Per-call scope hint. When set, the Registry hashes (scope, scopeId)
   * into the gating storage key so configured caps apply per-scope rather
   * than per-alias. Omitting it preserves alpha.19.1 per-alias behavior.
   * (alpha.20+)
   */
  budgetScope?: BudgetScopeRef;
  /** Consumer-owned artifact reference tags flowing through to observability events. See `GenerateTextOptions.refs`. (alpha.25+) */
  refs?: Record<string, ArtifactRef>;
}

export interface RunAgentOptions {
  taskType: TaskType;
  priority?: LLMPriority;
  instructions: string;
  messages: LLMMessage[];
  tools: Record<string, ToolDefinition>;
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;
  /** Cancellation signal threaded through to the provider's HTTP fetch. */
  signal?: AbortSignal;
  /** Override task routing for this call only; route directly to the named provider alias. Per-provider budget gates still apply. (alpha.7+) */
  forceProviderAlias?: string;
  /** Reasoning effort hint for o-series / gpt-5-nano / Groq gpt-oss-120b. Silently ignored by adapters whose providers don't honor it. (alpha.12+) */
  reasoningEffort?: "low" | "medium" | "high";
  /** Per-call escape hatch for provider-specific request fields not modeled on the port. Shallow-merged into the SDK request body after typed fields. (alpha.16+) */
  providerExtras?: Record<string, unknown>;
  /** Provider-neutral cache configuration. Shape locked in alpha.19. */
  cacheControl?: CacheControl;
  /**
   * Per-call scope hint. When set, the Registry hashes (scope, scopeId)
   * into the gating storage key so configured caps apply per-scope rather
   * than per-alias. Omitting it preserves alpha.19.1 per-alias behavior.
   * (alpha.20+)
   */
  budgetScope?: BudgetScopeRef;
  /** Consumer-owned artifact reference tags flowing through to observability events. See `GenerateTextOptions.refs`. (alpha.25+) */
  refs?: Record<string, ArtifactRef>;
}

// ─── Result types ─────────────────────────────────────────────────────

export interface GenerateTextResult {
  text: string;
  usage: TokenUsage;
  cost: CostUsage;
  modelId: string;
  providerAlias: string;
  latencyMs: number;
}

export interface GenerateStructuredResult<T> {
  data: T;
  usage: TokenUsage;
  cost: CostUsage;
  modelId: string;
  providerAlias: string;
  latencyMs: number;
  /** 1 = first try; 2+ = retried via retry-with-feedback. */
  validationAttempts: number;
}

export interface AgentResult {
  text: string;
  messages: LLMMessage[];
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    output: unknown;
  }>;
  usage: TokenUsage;
  cost: CostUsage;
  modelId: string;
  providerAlias: string;
  latencyMs: number;
  stepsTaken: number;
  terminationReason: "completed" | "max_steps" | "stopped_by_user";
}

// ─── Model discovery (alpha.9+) ───────────────────────────────────────

/**
 * Information about a single model the provider exposes. Returned by
 * {@link LLMPort.listModels} when supported. Each adapter populates the
 * fields the provider's API exposes; absent fields signal "the provider
 * doesn't tell us this", not "the model lacks the property".
 *
 * Used by {@link Registry.checkPricingFreshness} to compare bundled
 * pricing tables against the provider's current model catalog and warn
 * about drift.
 */
export interface ProviderModelInfo {
  /** Provider-side model id, e.g. `gpt-5`, `claude-opus-4-7`, `gemini-2.5-flash`. */
  id: string;
  /** Friendly name when the API exposes it. */
  displayName?: string;
  /** USD per 1M input tokens, when the API exposes pricing. */
  inputPer1M?: number;
  /** USD per 1M output tokens, when the API exposes pricing. */
  outputPer1M?: number;
  /** Context-window size in tokens, when the API exposes it. */
  contextWindow?: number;
  /** Free-form metadata bag for provider-specific fields (e.g. modality, family). */
  metadata?: Record<string, unknown>;
}

// ─── The port interface ───────────────────────────────────────────────

/**
 * Adapters implement this. Business logic depends on this.
 * Zero imports from any LLM SDK.
 */
export interface LLMPort {
  /** Free-form text generation. Use for: drafts, summaries, recommendations. */
  generateText(options: GenerateTextOptions): Promise<GenerateTextResult>;

  /** Schema-validated structured output. Use for: triage, scoring, extraction. */
  generateStructured<T>(
    options: GenerateStructuredOptions<T>,
  ): Promise<GenerateStructuredResult<T>>;

  /** Token-by-token text streaming. Use for: chat UIs, long briefings. */
  streamText(options: StreamTextOptions): AsyncIterable<string>;

  /**
   * Progressively-parseable partial JSON streaming. Use for:
   * forms, cards, charts that render as the model emits them.
   * Yields successively more complete partial objects.
   */
  streamStructured<T>(
    options: StreamStructuredOptions<T>,
  ): AsyncIterable<Partial<T>>;

  /** Multi-turn tool-use loop. The agent primitive. */
  runAgent(options: RunAgentOptions): Promise<AgentResult>;

  /**
   * Runtime model discovery (alpha.9+). Returns the models the provider
   * currently exposes, with bundled metadata when the provider's API
   * exposes it (pricing, context window, family). Optional: adapters
   * implement it where the provider has a `/models` endpoint; bridges
   * (adapter-vercel) skip it.
   *
   * Used by `Registry.checkPricingFreshness()` to flag bundled-pricing
   * drift. Users can also call it directly for "show me the available
   * models" UIs.
   */
  listModels?(): Promise<ProviderModelInfo[]>;
}
