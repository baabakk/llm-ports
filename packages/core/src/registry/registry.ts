/**
 * Registry — selects an adapter for a given task type, applies budget/cost gating,
 * walks fallback chains on failure, and exposes the unified LLMPort surface.
 *
 * This implementation is intentionally minimal in v0.1:
 *  - Adapters are registered by name (matching the env config's adapter token).
 *  - selectModel(taskType) walks the configured fallback chain and returns the
 *    first adapter whose budget allows the call.
 *  - getPort() returns an LLMPort proxy whose every method invokes selectModel.
 *  - The registry exposes both LLMPort and EmbeddingsPort (when supported by adapters).
 *
 * Note: this skeleton focuses on the routing/gating contract. Adapter implementations
 * land in their own packages (Week 2 onwards) and plug in here.
 */

import type {
  AgentResult,
  ArtifactRef,
  GenerateStructuredOptions,
  GenerateStructuredResult,
  GenerateTextOptions,
  GenerateTextResult,
  LLMPort,
  RunAgentOptions,
  StreamStructuredOptions,
  StreamTextOptions,
} from "../ports/llm-port.js";
import {
  attachStreamCompleteCallback,
  deriveCacheHit,
  emitCacheHit,
  emitCost,
  emitFallback,
  emitTokenUsage,
  type ObservabilityHooks,
  type StreamCompleteCallback,
} from "../observability.js";
import type {
  BatchEmbeddingOptions,
  BatchEmbeddingResult,
  EmbeddingOptions,
  EmbeddingResult,
  EmbeddingsPort,
} from "../ports/embeddings-port.js";
import type {
  BudgetBackend,
  BudgetScopeRef,
  CostBackend,
  ModelPricing,
} from "../budget/types.js";
import { InMemoryBudget, InMemoryCost } from "../budget/memory.js";
import {
  DEFAULT_VALIDATION_STRATEGY,
  type ValidationStrategy,
} from "../validation.js";
import {
  aggressiveShouldFallback,
  AuthenticationError,
  ConfigError,
  EmptyMessagesError,
  MessagesRequiredError,
  NoProvidersAvailableError,
  ProviderUnavailableError,
  type ShouldFallbackContext,
} from "../errors.js";
import { createWarningState, warnOnce, type WarningState } from "../utils/deprecation.js";
import type { LLMMessage } from "../ports/llm-port.js";
import type { ProviderEntry, RegistryConfig } from "./config.js";
import { parseRegistryConfig } from "./config.js";
import { CostSession, type OpenCostSessionOptions } from "./cost-session.js";
import { normalizeTaskType, type TaskConfig } from "./tasks.js";
import {
  emitFallbackSelected,
  maybeComputeFingerprint,
  withAttempt,
  withOperation,
  type Instrumentation,
  type OperationContext,
} from "../instrumentation.js";
import type {
  CostUsage,
  FallbackCause,
  FingerprintableRequest,
  TokenUsage,
} from "@llm-ports/observability-contract";

// ─── Adapter contract used internally by the registry ────────────────

/**
 * What an adapter passes to the registry on registration. The adapter
 * provides factories that, given a model id, return a configured port instance.
 *
 * Why factories instead of pre-built ports: the registry knows the model id
 * per-call (from env config), so the adapter must defer instantiation until
 * model selection time.
 */
export interface AdapterRegistration {
  /** Adapter name, must match the env config's `<adapter>` token. */
  name: string;
  /** Build an LLMPort for a specific model. Required for chat-capable adapters. */
  createLLMPort?: (modelId: string, alias: string) => LLMPort;
  /** Build an EmbeddingsPort for a specific model. Optional. */
  createEmbeddingsPort?: (modelId: string, alias: string) => EmbeddingsPort;
  /** Pricing table this adapter ships, keyed by modelId. */
  pricing: Record<string, ModelPricing>;
}

// ─── Registry options ────────────────────────────────────────────────

export interface RegistryOptions {
  envPrefix?: string;
  env?: Record<string, string | undefined>;
  /** Adapters keyed by their name (must match env config tokens). */
  adapters: Record<string, AdapterRegistration>;
  budget?: BudgetBackend;
  cost?: CostBackend;
  validationStrategy?: ValidationStrategy;
  /** Override pricing for specific model ids (key = modelId). */
  pricingOverrides?: Record<string, ModelPricing>;
  /**
   * Runtime-error fallback configuration. When a call to the first viable
   * provider in a task's fallback chain throws an error matching `catchClass`,
   * the registry walks to the next viable provider and retries — without the
   * caller having to catch and re-route themselves.
   *
   * Default: walks on `ProviderUnavailableError` only (the safest class —
   * covers 5xx, network errors, rate-limit-style 429s the SDK wraps).
   *
   * Set to `"none"` to disable runtime fallback entirely (v0.1 behavior;
   * caller catches `ProviderUnavailableError` and routes manually).
   *
   * Set to a custom predicate for finer control (e.g. walk on
   * `EmptyResponseError` too, or skip 429s and let the SDK's own backoff
   * handle them).
   *
   * Added in `0.1.0-alpha.7`.
   *
   * The `"aggressive"` preset was added in `0.1.0-alpha.25` (LP-REQ-01).
   * It bundles the opinionated classifier three consumers had rebuilt by
   * hand (BEPA Plan 29, HomeSignal, SalesCoach Plan 30). See
   * {@link aggressiveShouldFallback} for the full matrix; the summary is
   * "walk on RateLimitError, EmptyResponseError, ContextWindowExceededError,
   * BadRequestError with credit-exhaustion body patterns, and raw 5xx status
   * codes — in addition to the default ProviderUnavailableError".
   */
  runtimeFallback?:
    | "default" // walk on ProviderUnavailableError
    | "aggressive" // walk on any provider-side signal (alpha.25+, LP-REQ-01)
    | "none" // disable; caller handles errors
    | { shouldFallback: (err: unknown, ctx?: ShouldFallbackContext) => boolean };
  /**
   * OTel-aligned observability hooks. Optional; each hook is independent.
   * Hooks are fire-and-forget — errors thrown by hook callbacks are swallowed
   * so observability instrumentation can't break inference.
   *
   * Coverage in this release (alpha.21):
   *   - onCost / onTokenUsage / onCacheHit : emitted by the Registry on every
   *     successful call against generateText, generateStructured, runAgent
   *     (and on each cache-hit response). Streaming methods do not emit cost
   *     yet (streamed cost surfacing is a follow-up, mirroring the alpha.7
   *     `walkChain` "no cost to record at stream-creation" behavior).
   *   - onFallback : emitted by the Registry's `walkChain` whenever it
   *     advances from one provider alias to the next due to runtime error,
   *     budget rejection, or empty response. Per-call only; not emitted for
   *     the initial selection or for `forceProviderAlias` calls (which by
   *     contract don't fall back).
   *   - onValidationRetry : hook type defined but not Registry-emitted in
   *     alpha.21. Consumers wanting validation-retry observability should
   *     use the adapter's existing `onRetry` hook and filter on
   *     `reason === "validation-feedback"`. Registry-level emission is the
   *     alpha.22 follow-up.
   *
   * Added in 0.1.0-alpha.21. Aligned with OpenTelemetry's `gen_ai.*` semantic
   * conventions where applicable; events are designed to map cleanly onto
   * spans and metrics in a downstream OTel pipeline.
   */
  observability?: ObservabilityHooks;
  /**
   * Alpha.29 shared instrumentation service handle. When supplied, every
   * `generateText` / `generateStructured` / `runAgent` call on the Registry's
   * port emits the contract lifecycle events (`llm.operation.started`,
   * `llm.attempt.started`, `.completed` / `.failed`, `llm.operation.*`) via
   * the shared service in `packages/core/src/instrumentation.ts`. Every
   * fallback advancement also emits `llm.fallback.selected`. Streaming
   * methods are not yet instrumented (alpha.30 handles the streaming path).
   *
   * When omitted, no contract events fire — the alpha.21 fire-and-forget
   * hooks continue to work as before. Both surfaces coexist during the
   * observability contract's rollout.
   *
   * Added in `0.1.0-alpha.29`.
   */
  instrumentation?: Instrumentation;
  /**
   * Per-attempt timeout, in milliseconds. When set, every provider attempt
   * within `walkChain` is wrapped in an `AbortController` that fires after
   * this many milliseconds. The abort propagates to the adapter's HTTP
   * client; the adapter throws `ProviderUnavailableError`; the Registry's
   * `shouldFallback` predicate catches it and walks to the next provider
   * with a fresh timer.
   *
   * Use case: a reasoning model that grinds on hidden chain-of-thought can
   * otherwise hang for minutes before the AbortSignal is the only escape.
   * Set a tight per-attempt cap (e.g. 30000) and let the chain fall back to
   * a fast non-reasoning provider after the cap fires. Per-attempt, not
   * chain-wide — each provider gets its own budget.
   *
   * Composes with a caller-supplied `signal` on the call options: BOTH the
   * timeout and the caller's abort fire the same wrapped controller. The
   * shorter trigger wins.
   *
   * Default: undefined (no timeout). When set, applies to `generateText`,
   * `generateStructured`, and `runAgent` walkChain attempts. Stream methods
   * use the same timeout for stream-creation only (not mid-stream — once a
   * stream opens, mid-stream timeout is a per-chunk policy that lives in
   * the consumer's `for await`).
   *
   * Alpha.30+: this is now the lowest-precedence step in a four-step
   * chain. Precedence, first non-undefined wins:
   *   1. Per-call `perAttemptTimeoutMs` on the generation-method options.
   *   2. Per-task `TaskConfig.defaultPerAttemptTimeoutMs` when the call's
   *      `taskType` matches a declared task in `taskDefaults` below.
   *   3. This Registry-level `perAttemptTimeoutMs`.
   *   4. Undefined (no timeout).
   *
   * Added in 0.1.0-alpha.23.
   */
  perAttemptTimeoutMs?: number;
  /**
   * Alpha.30+: per-task defaults keyed by `taskType`. When a call's
   * `taskType` matches a key here, the `TaskConfig` fields are consulted
   * for timeout resolution (`defaultPerAttemptTimeoutMs`) and future
   * per-task defaults. Typically populated from a `declareTasks({...})`
   * result via `.__meta`:
   *
   * ```ts
   * const tasks = declareTasks({
   *   "call-plan": { defaultPerAttemptTimeoutMs: 60000 },
   *   "classify":  { defaultPerAttemptTimeoutMs: 5000 },
   * });
   * createRegistryFromEnv({ ..., taskDefaults: tasks.__meta });
   * ```
   *
   * Match uses the caller's raw `taskType` (case-insensitive with the
   * same `normalizeTaskType` transform the env parser uses for route
   * lookup). Unmatched task types fall through to the Registry-level
   * `perAttemptTimeoutMs` per the four-step precedence chain above.
   *
   * Sourced from SalesCoach's `TD-CALLPLAN-CHAIN-TIMEOUT-STARVATION`.
   */
  taskDefaults?: Record<string, TaskConfig>;
  /**
   * When true, suppress the alpha.26+ deprecation warnings that fire when a
   * call uses the legacy `{instructions, prompt}` shape instead of the
   * canonical `messages: LLMMessage[]`. The legacy path still works during
   * the alpha.26 window; suppression is a per-Registry opt-out for
   * consumers who have read the migration guide and are working through
   * the migration incrementally.
   *
   * Removed in alpha.27, when the legacy fields go with it.
   *
   * Added in 0.1.0-alpha.26.
   */
  suppressDeprecationWarnings?: boolean;
  /**
   * Optional replacement for the deprecation warning's default emitter
   * (`console.warn`). Consumers wanting structured logging can supply a
   * function that receives the fully-formatted warning message. Removed
   * in alpha.27.
   *
   * Added in 0.1.0-alpha.26.
   */
  deprecationWarningHandler?: (message: string) => void;
}

// ─── Credential-probe result (alpha.30+) ─────────────────────────────

/**
 * Options for `Registry.probeCredentials`. See method JSDoc for the
 * cost model and tier semantics.
 */
export interface ProbeCredentialsOptions {
  /**
   * When `true`, adapters without `LLMPort.listModels()` fall back to
   * a minimal `generateText` call with `maxOutputTokens: 1`. Real
   * billable-token cost (typically a few cents per adapter probed per
   * probe). Off by default: adapters without `listModels()` are
   * reported as `skipped`.
   *
   * Cost trade-off: for a single deployment probing once per boot per
   * adapter, the yearly cost is negligible (a few dollars per adapter
   * per year). For a busy CI matrix probing many times per hour it can
   * add up. The default is off so no consumer incurs cost by accident;
   * opt in when full coverage matters more than the marginal spend.
   */
  probeWithGenerationFallback?: boolean;
}

/**
 * One row of a `ProbeCredentialsReport`. Populated for every alias the
 * probe attempted, whether it succeeded, failed, or was skipped.
 */
export interface ProbeReportEntry {
  /** The provider alias as configured. */
  alias: string;
  /** The adapter name backing this alias (e.g. "openai", "anthropic"). */
  provider: string;
  /** The model ID as configured for this alias. */
  modelId: string;
}

/**
 * Result of `Registry.probeCredentials`. Every configured alias in
 * scope lands in exactly one of `ok` / `failed` / `skipped`.
 */
export interface ProbeCredentialsReport {
  /** Aliases whose probe succeeded. `markProviderAuthenticated` was called for each. */
  ok: ProbeReportEntry[];
  /** Aliases whose probe threw. `error` is the message; `errorType` is `err.name`. */
  failed: Array<ProbeReportEntry & { error: string; errorType: string }>;
  /** Aliases the probe couldn't attempt. See `reason` for each. */
  skipped: Array<ProbeReportEntry & { reason: string }>;
}

// ─── Selection result ────────────────────────────────────────────────

export interface ModelSelection {
  alias: string;
  adapter: AdapterRegistration;
  modelId: string;
  pricing: ModelPricing;
  port?: LLMPort;
  embeddingsPort?: EmbeddingsPort;
}

// ─── The registry ────────────────────────────────────────────────────

export class Registry {
  public readonly config: RegistryConfig;
  public readonly budget: BudgetBackend;
  public readonly cost: CostBackend;
  public readonly validationStrategy: ValidationStrategy;
  /**
   * Returns true if an error should cause the registry to walk to the next
   * viable provider in the fallback chain. See `RegistryOptions.runtimeFallback`.
   *
   * Alpha.30+: accepts an optional `ShouldFallbackContext` second argument
   * carrying `providerAlias` + `hasEverAuthenticated`. Consumers who wrote
   * `(err) => boolean` classifiers before alpha.30 still work — TypeScript
   * function-parameter bivariance lets the narrower signature satisfy the
   * wider one. New classifiers can opt in to the context to make
   * ctx-aware decisions (e.g. walk on first-time-failed
   * `AuthenticationError`; abort on mid-flight auth failure).
   */
  public readonly shouldFallback: (err: unknown, ctx?: ShouldFallbackContext) => boolean;
  /** OTel-aligned observability hooks, set at construction. Read by `walkChain` + `RegistryPort`. */
  public readonly observability: ObservabilityHooks;
  /** Per-attempt timeout in ms, applied by `walkChain` to each provider attempt. (alpha.23+) */
  public readonly perAttemptTimeoutMs: number | undefined;
  /** Deprecation-warning dedup state for the alpha.26+ legacy `{instructions, prompt}` path. */
  public readonly warningState: WarningState;
  /**
   * Alpha.29 shared instrumentation service handle. Undefined when the
   * caller did not opt into observability at Registry construction.
   * Read by `RegistryPort` methods and threaded through `walkChain`.
   */
  public readonly instrumentation: Instrumentation | undefined;
  /**
   * Alpha.30+: aliases that have completed at least one successful attempt
   * in the current process. Populated inside `walkChain` on every success;
   * read via `hasEverAuthenticated(alias)`. Never reset — a provider that
   * authenticated once in this process is trusted for the rest of the
   * process. Process restart is what re-verifies. Sourced from SalesCoach's
   * `TD-LLM-AUTH-ERROR-KILLS-THE-WHOLE-CHAIN`.
   */
  private readonly authenticatedProviders: Set<string> = new Set();
  /**
   * Alpha.30+: per-task configuration overrides keyed by normalized
   * task type. Populated from `RegistryOptions.taskDefaults` at construction.
   * Read by `resolvePerAttemptTimeoutMs` and future per-task-aware code
   * paths. Keys are `normalizeTaskType(rawTaskType)` so `"STRUCTURED_OUTPUT"`
   * and `"structured-output"` share one entry.
   */
  private readonly taskDefaults: Record<string, TaskConfig>;
  private readonly adapters: Record<string, AdapterRegistration>;
  private readonly pricingOverrides: Record<string, ModelPricing>;

  constructor(opts: RegistryOptions) {
    this.config = parseRegistryConfig({ envPrefix: opts.envPrefix, env: opts.env });
    this.adapters = opts.adapters;
    this.budget = opts.budget ?? new InMemoryBudget();
    this.cost = opts.cost ?? new InMemoryCost();
    this.validationStrategy = opts.validationStrategy ?? DEFAULT_VALIDATION_STRATEGY;
    this.pricingOverrides = opts.pricingOverrides ?? {};
    this.shouldFallback = resolveRuntimeFallback(opts.runtimeFallback);
    this.observability = opts.observability ?? {};
    this.perAttemptTimeoutMs = opts.perAttemptTimeoutMs;
    this.warningState = createWarningState({
      suppressed: opts.suppressDeprecationWarnings ?? false,
      ...(opts.deprecationWarningHandler ? { handler: opts.deprecationWarningHandler } : {}),
    });
    this.instrumentation = opts.instrumentation;
    // Alpha.30+: normalize task-default keys the same way env-var parse
    // + registry lookup normalize task types. So `"STRUCTURED_OUTPUT"`
    // and `"structured-output"` share one entry.
    this.taskDefaults = {};
    if (opts.taskDefaults) {
      for (const [key, config] of Object.entries(opts.taskDefaults)) {
        this.taskDefaults[normalizeTaskType(key)] = config;
      }
    }
    this.validateConfig();
  }

  /** Sanity-check that every provider's adapter exists and every task chain references real providers. */
  private validateConfig(): void {
    for (const [alias, entry] of Object.entries(this.config.providers)) {
      if (!this.adapters[entry.adapter]) {
        throw new ConfigError(
          `Provider "${alias}" references adapter "${entry.adapter}" which is not registered. Available adapters: ${Object.keys(this.adapters).join(", ") || "(none)"}`,
        );
      }
    }
    for (const [task, chain] of Object.entries(this.config.taskRoutes)) {
      for (const alias of chain) {
        if (!this.config.providers[alias]) {
          throw new ConfigError(
            `Task "${task}" references provider "${alias}" which is not configured.`,
          );
        }
      }
    }
  }

  /**
   * Compose the gating storage key. When `budgetScope` is set, the backend
   * sees `${alias}|${scope}:${scopeId}` so configured caps apply per-scope.
   * Otherwise the key is just `${alias}` — backwards-compatible with every
   * release up to alpha.19.1. (alpha.20+)
   */
  scopedKey(alias: string, budgetScope?: BudgetScopeRef): string {
    if (!budgetScope) return alias;
    return `${alias}|${budgetScope.scope}:${budgetScope.scopeId}`;
  }

  /**
   * Alpha.30+: has this provider alias ever completed a successful attempt
   * in the current process?
   *
   * The bit is set by `walkChain` on every successful attempt and never
   * reset until process restart. Reads by the fallback policy: a
   * first-time-failed `AuthenticationError` on a never-authenticated
   * provider walks the chain (config fault — recover and shout via
   * `llm.fallback.selected` with `cause: "provider_authentication_never_established"`);
   * a mid-flight auth failure on a previously-authenticated provider
   * aborts (something changed at the provider — worth surfacing loudly
   * as an outage).
   *
   * Public so consumers can query the state directly for health checks
   * or dashboards.
   */
  hasEverAuthenticated(providerAlias: string): boolean {
    return this.authenticatedProviders.has(providerAlias);
  }

  /**
   * Internal: called by `walkChain` on every successful attempt to record
   * that this provider alias has authenticated at least once in the
   * current process. Never reset.
   */
  markProviderAuthenticated(providerAlias: string): void {
    this.authenticatedProviders.add(providerAlias);
  }

  /**
   * Alpha.30+: resolve the effective per-attempt timeout for a call using
   * the four-step precedence chain: call → task → Registry → undefined.
   *
   * @param taskType — the caller's `taskType` string. Matched
   *   case-insensitively against declared `taskDefaults` via the same
   *   normalization the env-var parser uses. Optional (some code paths
   *   don't have one; falls through to Registry / undefined).
   * @param callOverride — the per-call `perAttemptTimeoutMs` from the
   *   generation-method options. Highest precedence when set.
   * @returns effective timeout in ms, or undefined for "no timeout."
   */
  resolvePerAttemptTimeoutMs(taskType?: string, callOverride?: number): number | undefined {
    if (callOverride !== undefined) return callOverride;
    if (taskType !== undefined) {
      const cfg = this.taskDefaults[normalizeTaskType(taskType)];
      if (cfg?.defaultPerAttemptTimeoutMs !== undefined) {
        return cfg.defaultPerAttemptTimeoutMs;
      }
    }
    return this.perAttemptTimeoutMs;
  }

  /**
   * Alpha.30+: probe every configured provider (or a specified subset)
   * to verify credentials are working. Returns a `ProbeCredentialsReport`
   * split into `ok` / `failed` / `skipped`. Solves the "no boot-time
   * signal" problem SalesCoach's `TD-LLM-AUTH-ERROR-KILLS-THE-WHOLE-CHAIN`
   * called out: a dead credential sat in staging for days because the
   * only surface that would have revealed it was a failed user-facing
   * request.
   *
   * Two-tier strategy:
   *
   * **Tier 1 (default, zero billable cost).** Adapters that implement
   * `LLMPort.listModels()` — currently the openai, anthropic, google
   * adapters — get probed with a single `listModels()` call. Adapters
   * without `listModels()` are reported as `skipped`.
   *
   * **Tier 2 (opt-in via `options.probeWithGenerationFallback: true`,
   * small billable cost).** Adapters without `listModels()` fall back to
   * a minimal `generateText` with `maxOutputTokens: 1`. Costs a few
   * cents per adapter per probe — meaningful over a busy CI matrix,
   * negligible for a nightly boot-time check on a single deployment.
   * When enabled, every configured provider gets covered.
   *
   * Side effect: on `ok`, calls `markProviderAuthenticated(alias)` so
   * subsequent auth failures on the same alias in the same process are
   * classified as mid-flight (abort) rather than never-established
   * (walk). This is the intended semantic — the probe IS what
   * establishes the authenticated status.
   *
   * Caller-invocable — the Registry does NOT auto-probe at construction
   * (opt-in for two reasons: startup cost and side-effects on rate
   * limits). Consumers wire this into their startup / health-check
   * surface.
   *
   * @param chain — optional subset of aliases to probe. Omitted means
   *   probe every configured provider.
   * @param options — probe configuration; see `ProbeCredentialsOptions`.
   */
  async probeCredentials(
    chain?: string[],
    options: ProbeCredentialsOptions = {},
  ): Promise<ProbeCredentialsReport> {
    const aliases = chain ?? Object.keys(this.config.providers);
    const ok: ProbeReportEntry[] = [];
    const failed: ProbeCredentialsReport["failed"] = [];
    const skipped: ProbeCredentialsReport["skipped"] = [];

    for (const alias of aliases) {
      const entry = this.config.providers[alias];
      if (!entry) {
        skipped.push({
          alias,
          provider: "(none)",
          modelId: "(none)",
          reason: "provider not configured",
        });
        continue;
      }
      const adapter = this.adapters[entry.adapter];
      if (!adapter) {
        skipped.push({
          alias,
          provider: entry.adapter,
          modelId: entry.modelId,
          reason: `adapter "${entry.adapter}" not registered`,
        });
        continue;
      }
      const port = adapter.createLLMPort?.(entry.modelId, alias);
      if (!port) {
        skipped.push({
          alias,
          provider: entry.adapter,
          modelId: entry.modelId,
          reason: `adapter "${entry.adapter}" does not implement createLLMPort`,
        });
        continue;
      }

      const meta: ProbeReportEntry = {
        alias,
        provider: entry.adapter,
        modelId: entry.modelId,
      };

      // Tier 1: listModels() — free.
      if (port.listModels) {
        try {
          await port.listModels();
          ok.push(meta);
          this.markProviderAuthenticated(alias);
        } catch (err) {
          failed.push({
            ...meta,
            error: err instanceof Error ? err.message : String(err),
            errorType: err instanceof Error ? err.name : "UnknownError",
          });
        }
        continue;
      }

      // Tier 2: generateText fallback — opt-in.
      if (options.probeWithGenerationFallback) {
        try {
          await port.generateText({
            taskType: "credential-probe",
            messages: [{ role: "user", content: "ok" }],
            maxOutputTokens: 1,
          });
          ok.push(meta);
          this.markProviderAuthenticated(alias);
        } catch (err) {
          failed.push({
            ...meta,
            error: err instanceof Error ? err.message : String(err),
            errorType: err instanceof Error ? err.name : "UnknownError",
          });
        }
        continue;
      }

      // Neither path applies. Skip explicitly so the caller sees the gap.
      skipped.push({
        ...meta,
        reason:
          "adapter does not implement listModels() and probeWithGenerationFallback is off",
      });
    }

    return { ok, failed, skipped };
  }

  /**
   * Resolve the fallback chain for a caller-supplied `taskType`.
   *
   * Applies the same lowercase-and-hyphenate normalization the env-var
   * parser uses at load time (so `"STRUCTURED_OUTPUT"`,
   * `"Structured_Output"`, and `"structured-output"` all resolve to the
   * same route). When the normalized key isn't in the table, falls back
   * to `"general"` — same behavior as pre-alpha.29 — but fires a
   * warn-once through the shared WarningState so silent config drift
   * becomes visible.
   *
   * Introduced alpha.29 for TD-LLM-TASKTYPE-CASE-MISMATCH-SILENT-GENERAL-
   * FALLBACK (SalesCoach, 2026-08-10).
   *
   * Public so `RegistryPort` can read the intended `provider_chain` for
   * emission on `llm.operation.started`.
   */
  resolveTaskChain(taskType: string): string[] {
    const normalized = normalizeTaskType(taskType);
    const direct = this.config.taskRoutes[normalized];
    if (direct) return direct;

    const general = this.config.taskRoutes["general"];
    if (general) {
      const known = Object.keys(this.config.taskRoutes);
      warnOnce(
        this.warningState,
        `unknown-task-type:${normalized}`,
        `[llm-ports] Unknown task type "${taskType}" (normalized "${normalized}") — falling back to the "general" chain. Configured routes: ${known.length === 0 ? "(none)" : known.join(", ")}. Add LLM_TASK_ROUTE_${normalized.toUpperCase().replace(/-/g, "_")}=... to your environment, or pass a task type that matches a configured route.`,
      );
      return general;
    }
    return [];
  }

  /** Resolve the first usable provider in the task's fallback chain. */
  async selectModel(
    taskType: string,
    priority: 0 | 1 | 2 | 3 = 2,
    budgetScope?: BudgetScopeRef,
  ): Promise<ModelSelection> {
    const chain = this.resolveTaskChain(taskType);
    if (chain.length === 0) {
      throw new NoProvidersAvailableError(taskType, [], {
        general: `No fallback chain configured for task "${taskType}" or "general"`,
      });
    }

    const reasons: Record<string, string> = {};
    for (const alias of chain) {
      const entry = this.config.providers[alias];
      if (!entry) {
        reasons[alias] = "provider not configured";
        continue;
      }
      const adapter = this.adapters[entry.adapter];
      if (!adapter) {
        reasons[alias] = `adapter "${entry.adapter}" not registered`;
        continue;
      }

      // P0 bypasses budget gating.
      if (priority > 0) {
        const key = this.scopedKey(alias, budgetScope);
        const budgetCheck = await this.budget.check(key, entry.budgetLimit);
        if (!budgetCheck.allowed) {
          reasons[alias] = budgetCheck.reason ?? "budget exceeded";
          continue;
        }
        const costCheck = await this.cost.check(key, entry.costLimit);
        if (!costCheck.allowed) {
          reasons[alias] = costCheck.reason ?? "cost cap exceeded";
          continue;
        }
      }

      const pricing =
        this.pricingOverrides[entry.modelId] ?? adapter.pricing[entry.modelId];
      if (!pricing) {
        reasons[alias] = `no pricing entry for model "${entry.modelId}"`;
        continue;
      }

      return {
        alias,
        adapter,
        modelId: entry.modelId,
        pricing,
        port: adapter.createLLMPort?.(entry.modelId, alias),
        embeddingsPort: adapter.createEmbeddingsPort?.(entry.modelId, alias),
      };
    }

    throw new NoProvidersAvailableError(taskType, chain, reasons);
  }

  /**
   * Resolve a single provider by alias, bypassing the task-routing chain.
   * Used by `forceProviderAlias` (alpha.7+). Per-provider budget gates still
   * apply (P0 priority bypasses them, matching `selectModel`). Throws
   * `NoProvidersAvailableError` if the alias is unconfigured or fails gating.
   */
  async selectByAlias(
    alias: string,
    priority: 0 | 1 | 2 | 3 = 2,
    budgetScope?: BudgetScopeRef,
  ): Promise<ModelSelection> {
    const entry = this.config.providers[alias];
    if (!entry) {
      throw new NoProvidersAvailableError(`forced:${alias}`, [alias], {
        [alias]: "provider not configured",
      });
    }
    const adapter = this.adapters[entry.adapter];
    if (!adapter) {
      throw new NoProvidersAvailableError(`forced:${alias}`, [alias], {
        [alias]: `adapter "${entry.adapter}" not registered`,
      });
    }
    if (priority > 0) {
      const key = this.scopedKey(alias, budgetScope);
      const budgetCheck = await this.budget.check(key, entry.budgetLimit);
      if (!budgetCheck.allowed) {
        throw new NoProvidersAvailableError(`forced:${alias}`, [alias], {
          [alias]: budgetCheck.reason ?? "budget exceeded",
        });
      }
      const costCheck = await this.cost.check(key, entry.costLimit);
      if (!costCheck.allowed) {
        throw new NoProvidersAvailableError(`forced:${alias}`, [alias], {
          [alias]: costCheck.reason ?? "cost cap exceeded",
        });
      }
    }
    const pricing =
      this.pricingOverrides[entry.modelId] ?? adapter.pricing[entry.modelId];
    if (!pricing) {
      throw new NoProvidersAvailableError(`forced:${alias}`, [alias], {
        [alias]: `no pricing entry for model "${entry.modelId}"`,
      });
    }
    return {
      alias,
      adapter,
      modelId: entry.modelId,
      pricing,
      port: adapter.createLLMPort?.(entry.modelId, alias),
      embeddingsPort: adapter.createEmbeddingsPort?.(entry.modelId, alias),
    };
  }

  /**
   * Resolve EVERY usable provider in the task's fallback chain, in order.
   * Used by the registry's port proxy to walk the chain on runtime errors
   * (alpha.7+). The eligibility checks (provider configured, adapter
   * registered, budget allows, cost cap allows, pricing exists) are the
   * same as `selectModel`; the difference is this method returns the full
   * viable list instead of just the first.
   *
   * Throws `NoProvidersAvailableError` if NO providers in the chain are
   * viable. Returns at least one `ModelSelection` otherwise.
   */
  async selectViableChain(
    taskType: string,
    priority: 0 | 1 | 2 | 3 = 2,
    budgetScope?: BudgetScopeRef,
  ): Promise<ModelSelection[]> {
    const chain = this.resolveTaskChain(taskType);
    if (chain.length === 0) {
      throw new NoProvidersAvailableError(taskType, [], {
        general: `No fallback chain configured for task "${taskType}" or "general"`,
      });
    }
    const viable: ModelSelection[] = [];
    const reasons: Record<string, string> = {};
    for (const alias of chain) {
      const entry = this.config.providers[alias];
      if (!entry) {
        reasons[alias] = "provider not configured";
        continue;
      }
      const adapter = this.adapters[entry.adapter];
      if (!adapter) {
        reasons[alias] = `adapter "${entry.adapter}" not registered`;
        continue;
      }
      if (priority > 0) {
        const key = this.scopedKey(alias, budgetScope);
        const budgetCheck = await this.budget.check(key, entry.budgetLimit);
        if (!budgetCheck.allowed) {
          reasons[alias] = budgetCheck.reason ?? "budget exceeded";
          continue;
        }
        const costCheck = await this.cost.check(key, entry.costLimit);
        if (!costCheck.allowed) {
          reasons[alias] = costCheck.reason ?? "cost cap exceeded";
          continue;
        }
      }
      const pricing =
        this.pricingOverrides[entry.modelId] ?? adapter.pricing[entry.modelId];
      if (!pricing) {
        reasons[alias] = `no pricing entry for model "${entry.modelId}"`;
        continue;
      }
      viable.push({
        alias,
        adapter,
        modelId: entry.modelId,
        pricing,
        port: adapter.createLLMPort?.(entry.modelId, alias),
        embeddingsPort: adapter.createEmbeddingsPort?.(entry.modelId, alias),
      });
    }
    if (viable.length === 0) {
      throw new NoProvidersAvailableError(taskType, chain, reasons);
    }
    return viable;
  }

  /** Returns an LLMPort whose methods route to the selected adapter per call. */
  getPort(): LLMPort {
    return new RegistryPort(this);
  }

  /** Returns an EmbeddingsPort whose methods route to the selected adapter per call. */
  getEmbeddingsPort(): EmbeddingsPort {
    return new RegistryEmbeddingsPort(this);
  }

  /**
   * Open a session-scoped cost gate. Returns a {@link CostSession} that
   * wraps an LLMPort with a hard USD cap, independent of the per-provider
   * hour/day/month gates. Throws `SessionBudgetExceededError` mid-loop
   * when the cap is reached.
   *
   * Designed for continuous-call workloads (screen capture loops, OCR
   * pipelines, multi-step agents) where a single stuck-open session can
   * otherwise burn arbitrary dollars.
   *
   * The returned session has its own LLMPort via `session.getPort()`; the
   * underlying registry's per-provider budget gates still apply on top.
   */
  openCostSession(opts: OpenCostSessionOptions): CostSession {
    return new CostSession(this.getPort(), opts);
  }

  /** Introspection: list all provider aliases. */
  listProviders(): ProviderEntry[] {
    return Object.values(this.config.providers);
  }

  /** Introspection: list all configured task routes. */
  listTasks(): Array<{ task: string; chain: string[] }> {
    return Object.entries(this.config.taskRoutes).map(([task, chain]) => ({ task, chain }));
  }

  /**
   * Compare bundled per-adapter pricing tables against each provider's live
   * model catalog (via `LLMPort.listModels()`). Reports drift: models bundled
   * but not exposed by the provider (deprecated), models exposed but not
   * bundled (newly launched), and per-model rate divergence when the provider
   * exposes pricing.
   *
   * Use as a CI / scheduled job to get a warning when a provider quietly
   * changes its catalog. The bundled pricing tables remain the source of
   * truth for cost computation; this method does NOT auto-update them.
   *
   * Adapters that don't implement `listModels()` (e.g. `adapter-vercel`)
   * are skipped and reported under `skipped`.
   *
   * Added in `0.1.0-alpha.9`.
   */
  async checkPricingFreshness(): Promise<PricingFreshnessReport> {
    const checked: PricingFreshnessAdapterReport[] = [];
    const skipped: Array<{ adapter: string; reason: string }> = [];

    // Group providers by adapter; only need to call listModels once per adapter.
    const adapterToProviders = new Map<string, Array<{ alias: string; modelId: string }>>();
    for (const [alias, entry] of Object.entries(this.config.providers)) {
      const list = adapterToProviders.get(entry.adapter) ?? [];
      list.push({ alias, modelId: entry.modelId });
      adapterToProviders.set(entry.adapter, list);
    }

    for (const [adapterName, providers] of adapterToProviders) {
      const adapter = this.adapters[adapterName];
      if (!adapter) {
        skipped.push({ adapter: adapterName, reason: "adapter not registered" });
        continue;
      }
      const first = providers[0]!;
      const port = adapter.createLLMPort?.(first.modelId, first.alias);
      if (!port?.listModels) {
        skipped.push({ adapter: adapterName, reason: "adapter does not implement listModels()" });
        continue;
      }
      try {
        const live = await port.listModels();
        const liveIds = new Set(live.map((m) => m.id));
        const bundledIds = new Set(Object.keys(adapter.pricing));

        const removed = [...bundledIds].filter((id) => !liveIds.has(id));
        const added = [...liveIds].filter((id) => !bundledIds.has(id));
        const drift: Array<{
          modelId: string;
          bundledInputPer1M: number;
          bundledOutputPer1M: number;
          liveInputPer1M: number;
          liveOutputPer1M: number;
        }> = [];
        for (const liveModel of live) {
          if (liveModel.inputPer1M === undefined && liveModel.outputPer1M === undefined) continue;
          const bundled = adapter.pricing[liveModel.id];
          if (!bundled) continue;
          if (
            liveModel.inputPer1M !== undefined &&
            liveModel.inputPer1M !== bundled.inputPer1M
          ) {
            drift.push({
              modelId: liveModel.id,
              bundledInputPer1M: bundled.inputPer1M,
              bundledOutputPer1M: bundled.outputPer1M,
              liveInputPer1M: liveModel.inputPer1M,
              liveOutputPer1M: liveModel.outputPer1M ?? bundled.outputPer1M,
            });
          } else if (
            liveModel.outputPer1M !== undefined &&
            liveModel.outputPer1M !== bundled.outputPer1M
          ) {
            drift.push({
              modelId: liveModel.id,
              bundledInputPer1M: bundled.inputPer1M,
              bundledOutputPer1M: bundled.outputPer1M,
              liveInputPer1M: liveModel.inputPer1M ?? bundled.inputPer1M,
              liveOutputPer1M: liveModel.outputPer1M,
            });
          }
        }
        checked.push({
          adapter: adapterName,
          liveModelCount: live.length,
          bundledModelCount: bundledIds.size,
          addedModels: added,
          removedModels: removed,
          priceDrift: drift,
        });
      } catch (err) {
        skipped.push({
          adapter: adapterName,
          reason: `listModels failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return { checked, skipped };
  }
}

/**
 * Output of {@link Registry.checkPricingFreshness}.
 *
 * `checked` has one entry per adapter that successfully reported its live
 * model catalog; `skipped` lists adapters that don't implement listModels()
 * or whose call failed.
 */
export interface PricingFreshnessReport {
  checked: PricingFreshnessAdapterReport[];
  skipped: Array<{ adapter: string; reason: string }>;
}

export interface PricingFreshnessAdapterReport {
  adapter: string;
  liveModelCount: number;
  bundledModelCount: number;
  /** Models exposed by the provider but not in the bundled pricing table. */
  addedModels: string[];
  /** Models in the bundled pricing table but no longer exposed by the provider. */
  removedModels: string[];
  /** Models where bundled USD/1M differs from live USD/1M (when the API exposes pricing). */
  priceDrift: Array<{
    modelId: string;
    bundledInputPer1M: number;
    bundledOutputPer1M: number;
    liveInputPer1M: number;
    liveOutputPer1M: number;
  }>;
}

/**
 * Convenience factory matching the public API surface advertised in the README.
 *
 *   const registry = createRegistryFromEnv({ adapters: { anthropic: ... } });
 *   const llm = registry.getPort();
 */
export function createRegistryFromEnv(opts: RegistryOptions): Registry {
  return new Registry(opts);
}

// ─── Internal port proxies ───────────────────────────────────────────

/**
 * Resolve the viable chain, filter to selections that actually have an
 * LLMPort, and walk through them attempting `attempt(sel)`. Walks on errors
 * matching `registry.shouldFallback`; surfaces other errors immediately.
 *
 * Records budget + cost ONLY on the successful attempt. If every viable
 * provider fails (or the chain is empty after filtering), throws a
 * `NoProvidersAvailableError` whose `reasons` map carries the per-alias
 * fallback error for diagnostics.
 */
/**
 * Metrics an alpha.29 attempt exposes to the shared instrumentation
 * service. `walkChain` calls the caller-supplied `extractMetrics` on
 * every successful attempt result to fill in `attempt.completed`'s
 * usage + cost + final_model_id + optional provider_response_id.
 *
 * Streams don't provide metrics at return time, so streaming methods
 * do not opt into instrumented `walkChain` — alpha.30 wires them.
 */
interface AttemptMetrics {
  usage: TokenUsage;
  cost: CostUsage;
  modelId: string;
  providerResponseId?: string;
}

async function walkChain<R>(
  registry: Registry,
  taskType: string,
  priority: 0 | 1 | 2 | 3 | undefined,
  attempt: (sel: ModelSelection) => Promise<R>,
  recordCost: (sel: ModelSelection, result: R, key: string) => Promise<void>,
  forceProviderAlias?: string,
  budgetScope?: BudgetScopeRef,
  operation:
    | "generateText"
    | "generateStructured"
    | "streamText"
    | "streamStructured"
    | "runAgent" = "generateText",
  refs?: Record<string, ArtifactRef>,
  opCtx?: OperationContext,
  extractMetrics?: (r: R) => AttemptMetrics,
): Promise<R> {
  // ─── Helper: run one attempt, optionally wrapped in withAttempt ────
  const runAttempt = async (sel: ModelSelection, isFallback: boolean): Promise<R> => {
    if (!opCtx || !extractMetrics) {
      return attempt(sel);
    }
    return withAttempt(
      opCtx,
      {
        providerAlias: sel.alias,
        modelId: sel.modelId,
        ...(isFallback ? { isFallback: true } : {}),
      },
      async () => {
        const raw = await attempt(sel);
        const m = extractMetrics(raw);
        return {
          value: raw,
          usage: m.usage,
          cost: m.cost,
          modelId: m.modelId,
          ...(m.providerResponseId ? { providerResponseId: m.providerResponseId } : {}),
        };
      },
    );
  };

  // forceProviderAlias short-circuit: bypass task routing entirely. Single-
  // element chain. Runtime fallback does NOT engage — caller explicitly asked
  // for this provider; falling back would defeat the point.
  if (forceProviderAlias !== undefined) {
    const sel = await registry.selectByAlias(forceProviderAlias, priority, budgetScope);
    if (!sel.port) {
      throw new NoProvidersAvailableError(`forced:${forceProviderAlias}`, [sel.alias], {
        [sel.alias]: `adapter "${sel.adapter.name}" does not implement LLMPort`,
      });
    }
    const result = await runAttempt(sel, false);
    const key = registry.scopedKey(sel.alias, budgetScope);
    await registry.budget.recordRequest(key);
    await recordCost(sel, result, key);
    // Alpha.30+: forced-provider success also marks the provider as
    // authenticated for future ctx-aware fallback decisions.
    registry.markProviderAuthenticated(sel.alias);
    return result;
  }
  const chain = await registry.selectViableChain(taskType, priority, budgetScope);
  const reasons: Record<string, string> = {};
  let lastErr: unknown;
  let prevSelForFallback: ModelSelection | undefined;
  for (const sel of chain) {
    if (!sel.port) {
      reasons[sel.alias] = `adapter "${sel.adapter.name}" does not implement LLMPort`;
      continue;
    }
    // If a previous alias failed, this is a fallback advancement. Emit
    // before we re-attempt so observers see the from→to transition in order.
    if (prevSelForFallback) {
      emitFallback(registry.observability.onFallback, {
        fromAlias: prevSelForFallback.alias,
        toAlias: sel.alias,
        cause: "provider-error",
        operation,
        taskType,
        reason: lastErr,
        ...(refs ? { refs } : {}),
      });
      // Alpha.29 contract event; alpha.30 adds a distinct cause when
      // the fallback was triggered by a never-established credential so
      // sinks can alert specifically on stale keys instead of lumping
      // them in with ordinary transient failures.
      const fbCause: FallbackCause =
        lastErr instanceof AuthenticationError
          ? "provider_authentication_never_established"
          : "provider_unavailable";
      emitFallbackSelected(opCtx, {
        fromProviderAlias: prevSelForFallback.alias,
        toProviderAlias: sel.alias,
        cause: fbCause,
      });
    }
    try {
      const result = await runAttempt(sel, prevSelForFallback !== undefined);
      const key = registry.scopedKey(sel.alias, budgetScope);
      await registry.budget.recordRequest(key);
      await recordCost(sel, result, key);
      // Alpha.30+: mark this provider as having authenticated in the
      // current process. Read by the ctx-aware fallback policy so a
      // subsequent auth failure on the same alias is treated as
      // "mid-flight" (abort) rather than "never established" (walk).
      registry.markProviderAuthenticated(sel.alias);
      return result;
    } catch (err) {
      lastErr = err;
      // Alpha.30+: pass the ctx-aware second argument so the policy
      // (default or aggressive or a caller-supplied opt-in classifier)
      // can distinguish first-time-failed auth (walk) from mid-flight
      // auth failure (abort). See ShouldFallbackContext JSDoc.
      const ctx: ShouldFallbackContext = {
        providerAlias: sel.alias,
        hasEverAuthenticated: registry.hasEverAuthenticated(sel.alias),
      };
      if (!registry.shouldFallback(err, ctx)) throw err;
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
      reasons[sel.alias] = `runtime fallback: ${message}`;
      prevSelForFallback = sel;
      continue;
    }
  }
  // Empty viable chain or every provider in the chain failed and fell through.
  const attempted = chain.map((s) => s.alias);
  if (lastErr instanceof Error && attempted.length > 0) {
    // Surface the last error's message in the NoProviders summary so the
    // caller doesn't have to dig through .reasons to see what actually failed.
    throw new NoProvidersAvailableError(taskType, attempted, reasons);
  }
  throw new NoProvidersAvailableError(taskType, attempted, reasons);
}

/**
 * Normalize the alpha.25/alpha.26 dual-shape input into a `messages`
 * array + a "messages-canonical" options bag ready for adapter dispatch.
 * (alpha.26+)
 *
 * Semantics:
 *   - If `opts.messages` is set AND non-empty, use it verbatim. Also
 *     throws `MessagesConflictError` if any legacy field is co-set —
 *     ambiguity is a caller bug.
 *   - If `opts.messages` is set but empty, throws `EmptyMessagesError`.
 *   - If `opts.messages` is unset and `opts.prompt` is set, synthesize
 *     `messages = toMessages(instructions, prompt)`, emit the deduplicated
 *     deprecation warning, and dispatch.
 *   - If both are missing, throws `MessagesRequiredError`.
 *
 * Returns the resolved `messages` array. Callers replace the original
 * `messages` field on options with this value before adapter dispatch;
 * the legacy `instructions`/`prompt` fields stay on the options bag for
 * backwards-compat adapter reads during the alpha.26 window.
 */
function normalizeMessagesOnOptions(
  method: "generateText" | "generateStructured" | "streamText" | "streamStructured",
  opts: {
    messages?: LLMMessage[];
  },
): LLMMessage[] {
  if (opts.messages === undefined) throw new MessagesRequiredError(method);
  if (opts.messages.length === 0) throw new EmptyMessagesError(method);
  return opts.messages;
}

class RegistryPort implements LLMPort {
  constructor(private readonly registry: Registry) {}

  /**
   * Emit OTel-aligned observability events for a completed result.
   *
   * Called from generateText, generateStructured, runAgent after walkChain
   * returns the successful result. Stream methods do not call this — streamed
   * cost surfacing is the alpha.22 follow-up. (alpha.21+)
   */
  private emitResultEvents(
    result: { cost: { inputUSD: number; outputUSD: number; totalUSD: number; cacheSavingsUSD?: number }; usage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }; modelId: string; providerAlias: string },
    operation: "generateText" | "generateStructured" | "streamText" | "streamStructured" | "runAgent" | "embed" | "rerank",
    taskType: string | undefined,
    budgetScope?: BudgetScopeRef,
    refs?: Record<string, ArtifactRef>,
  ): void {
    const hooks = this.registry.observability;
    if (hooks.onCost) {
      emitCost(hooks.onCost, {
        promptUsd: result.cost.inputUSD,
        completionUsd: result.cost.outputUSD,
        totalUsd: result.cost.totalUSD,
        ...(result.cost.cacheSavingsUSD !== undefined ? { cacheReadUsd: result.cost.cacheSavingsUSD } : {}),
        modelId: result.modelId,
        providerAlias: result.providerAlias,
        operation,
        ...(taskType ? { taskType } : {}),
        ...(budgetScope ? { budgetScope } : {}),
        ...(refs ? { refs } : {}),
      });
    }
    if (hooks.onTokenUsage) {
      emitTokenUsage(hooks.onTokenUsage, {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        ...(result.usage.cacheReadTokens !== undefined ? { cachedInputTokens: result.usage.cacheReadTokens } : {}),
        ...(result.usage.cacheWriteTokens !== undefined ? { cacheCreationTokens: result.usage.cacheWriteTokens } : {}),
        ...(result.usage.reasoningTokens !== undefined ? { reasoningTokens: result.usage.reasoningTokens } : {}),
        modelId: result.modelId,
        providerAlias: result.providerAlias,
        operation,
        ...(taskType ? { taskType } : {}),
        ...(budgetScope ? { budgetScope } : {}),
        ...(refs ? { refs } : {}),
      });
    }
    if (hooks.onCacheHit) {
      const hit = deriveCacheHit(result.usage, result.cost);
      if (hit) {
        emitCacheHit(hooks.onCacheHit, {
          cachedTokens: hit.cachedTokens,
          inputTokensTotal: hit.inputTokensTotal,
          hitRatio: hit.hitRatio,
          ...(hit.savingsUsd !== undefined ? { savingsUsd: hit.savingsUsd } : {}),
          modelId: result.modelId,
          providerAlias: result.providerAlias,
          operation,
          ...(taskType ? { taskType } : {}),
          ...(refs ? { refs } : {}),
        });
      }
    }
  }

  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    const messages = normalizeMessagesOnOptions("generateText", options);
    const normalizedOptions = { ...options, messages };
    const taskType = normalizedOptions.taskType ?? "general";
    const providerChain = normalizedOptions.forceProviderAlias
      ? [normalizedOptions.forceProviderAlias]
      : this.registry.resolveTaskChain(taskType);

    return withOperation(
      this.registry.instrumentation,
      { taskType, method: "generateText", providerChain },
      async (opCtx) => {
        maybeComputeFingerprint(opCtx, toFingerprintable(normalizedOptions));
        const result = await walkChain(
          this.registry,
          normalizedOptions.taskType,
          normalizedOptions.priority,
          (sel) =>
            withPerAttemptTimeout(
              this.registry.resolvePerAttemptTimeoutMs(
                normalizedOptions.taskType,
                normalizedOptions.perAttemptTimeoutMs,
              ),
              normalizedOptions.signal,
              (signal) => sel.port!.generateText(signal ? { ...normalizedOptions, signal } : normalizedOptions),
            ),
          (_sel, result, key) => this.registry.cost.recordCost(key, result.cost.totalUSD),
          normalizedOptions.forceProviderAlias,
          normalizedOptions.budgetScope,
          "generateText",
          normalizedOptions.refs,
          opCtx,
          toContractMetrics,
        );
        this.emitResultEvents(
          result,
          "generateText",
          normalizedOptions.taskType,
          normalizedOptions.budgetScope,
          normalizedOptions.refs,
        );
        return result;
      },
    );
  }

  async generateStructured<T>(
    options: GenerateStructuredOptions<T>,
  ): Promise<GenerateStructuredResult<T>> {
    const messages = normalizeMessagesOnOptions("generateStructured", options);
    const normalizedOptions = { ...options, messages };
    const taskType = normalizedOptions.taskType ?? "general";
    const providerChain = normalizedOptions.forceProviderAlias
      ? [normalizedOptions.forceProviderAlias]
      : this.registry.resolveTaskChain(taskType);

    return withOperation(
      this.registry.instrumentation,
      { taskType, method: "generateStructured", providerChain },
      async (opCtx) => {
        maybeComputeFingerprint(opCtx, toFingerprintable(normalizedOptions));
        const result = await walkChain(
          this.registry,
          normalizedOptions.taskType,
          normalizedOptions.priority,
          (sel) =>
            withPerAttemptTimeout(
              this.registry.resolvePerAttemptTimeoutMs(
                normalizedOptions.taskType,
                normalizedOptions.perAttemptTimeoutMs,
              ),
              normalizedOptions.signal,
              (signal) => sel.port!.generateStructured(signal ? { ...normalizedOptions, signal } : normalizedOptions),
            ),
          (_sel, result, key) => this.registry.cost.recordCost(key, result.cost.totalUSD),
          normalizedOptions.forceProviderAlias,
          normalizedOptions.budgetScope,
          "generateStructured",
          normalizedOptions.refs,
          opCtx,
          toContractMetrics,
        );
        this.emitResultEvents(
          result,
          "generateStructured",
          normalizedOptions.taskType,
          normalizedOptions.budgetScope,
          normalizedOptions.refs,
        );
        return result;
      },
    );
  }

  /**
   * Build a stream-complete callback that (a) emits `onCost` + `onTokenUsage`
   * + `onCacheHit` from the completion metadata the adapter surfaces, and
   * (b) records the streamed cost against the budget backend. (alpha.25+)
   *
   * The callback is attached to the caller's options object via
   * {@link attachStreamCompleteCallback}; the adapter reads it and fires
   * once at natural completion. Mid-stream errors and consumer aborts do
   * NOT fire the callback, so no cost or observability events are emitted
   * on failure paths (consistent with the alpha.24 non-streaming contract).
   */
  private buildStreamCompleteCallback(
    operation: "streamText" | "streamStructured",
    taskType: string | undefined,
    budgetScope: BudgetScopeRef | undefined,
    refs: Record<string, ArtifactRef> | undefined,
  ): StreamCompleteCallback {
    const registry = this.registry;
    return (meta) => {
      // 1. Emit observability events.
      this.emitResultEvents(
        { cost: meta.cost, usage: meta.usage, modelId: meta.modelId, providerAlias: meta.providerAlias },
        operation,
        taskType,
        budgetScope,
        refs,
      );
      // 2. Record streamed cost against the budget backend (fire-and-forget;
      //    same swallow-error contract as the observability emits above).
      const key = registry.scopedKey(meta.providerAlias, budgetScope);
      Promise.resolve()
        .then(() => registry.cost.recordCost(key, meta.cost.totalUSD))
        .catch(() => {
          // Budget backend errors on the streamed-cost path are not fatal
          // to the caller; the stream already yielded. Observability hooks
          // will still fire above.
        });
    };
  }

  async *streamText(options: StreamTextOptions): AsyncIterable<string> {
    const messages = normalizeMessagesOnOptions("streamText", options);
    const normalizedOptions = { ...options, messages };
    // Streaming runtime fallback is more nuanced — once we start yielding
    // chunks, switching providers mid-stream would emit a confusing mix.
    // For alpha.7 we walk the chain on the INITIAL `streamText()` call
    // (most failures happen at stream-creation time anyway), then yield
    // through whatever stream opened successfully. Mid-stream errors
    // propagate as-is to the consumer; users handle them with a try/catch
    // inside the for-await. Document this limit in the cancellation guide.
    const completeCallback = this.buildStreamCompleteCallback(
      "streamText",
      normalizedOptions.taskType,
      normalizedOptions.budgetScope,
      normalizedOptions.refs,
    );
    const optionsWithCallback = attachStreamCompleteCallback({ ...normalizedOptions }, completeCallback);
    const startStream = async (sel: ModelSelection): Promise<AsyncIterable<string>> => {
      return sel.port!.streamText(optionsWithCallback);
    };
    const stream = await walkChain(
      this.registry,
      normalizedOptions.taskType,
      normalizedOptions.priority,
      startStream,
      // No cost recording here — the stream-complete callback records cost
      // when the stream naturally finishes. This preserves the alpha.7
      // "no cost at stream-creation" behavior while adding the alpha.25
      // "cost at stream-completion" surface.
      async () => {
        /* noop */
      },
      normalizedOptions.forceProviderAlias,
      normalizedOptions.budgetScope,
      "streamText",
      normalizedOptions.refs,
    );
    yield* stream;
  }

  async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
    const messages = normalizeMessagesOnOptions("streamStructured", options);
    const normalizedOptions = { ...options, messages };
    const completeCallback = this.buildStreamCompleteCallback(
      "streamStructured",
      normalizedOptions.taskType,
      normalizedOptions.budgetScope,
      normalizedOptions.refs,
    );
    const optionsWithCallback = attachStreamCompleteCallback({ ...normalizedOptions }, completeCallback);
    const startStream = async (sel: ModelSelection): Promise<AsyncIterable<Partial<T>>> => {
      return sel.port!.streamStructured(optionsWithCallback);
    };
    const stream = await walkChain(
      this.registry,
      normalizedOptions.taskType,
      normalizedOptions.priority,
      startStream,
      async () => {
        /* noop */
      },
      normalizedOptions.forceProviderAlias,
      normalizedOptions.budgetScope,
      "streamStructured",
      normalizedOptions.refs,
    );
    yield* stream;
  }

  async runAgent(options: RunAgentOptions): Promise<AgentResult> {
    const taskType = options.taskType ?? "general";
    const providerChain = options.forceProviderAlias
      ? [options.forceProviderAlias]
      : this.registry.resolveTaskChain(taskType);

    return withOperation(
      this.registry.instrumentation,
      { taskType, method: "runAgent", providerChain },
      async (opCtx) => {
        maybeComputeFingerprint(opCtx, toFingerprintable(options));
        const result = await walkChain(
          this.registry,
          options.taskType,
          options.priority,
          (sel) =>
            withPerAttemptTimeout(
              this.registry.resolvePerAttemptTimeoutMs(
                options.taskType,
                options.perAttemptTimeoutMs,
              ),
              options.signal,
              (signal) => sel.port!.runAgent(signal ? { ...options, signal } : options),
            ),
          (_sel, result, key) => this.registry.cost.recordCost(key, result.cost.totalUSD),
          options.forceProviderAlias,
          options.budgetScope,
          "runAgent",
          options.refs,
          opCtx,
          toContractMetrics,
        );
        this.emitResultEvents(
          result,
          "runAgent",
          options.taskType,
          options.budgetScope,
          options.refs,
        );
        return result;
      },
    );
  }
}

/**
 * Translate a core `TokenUsage`+`CostUsage`-carrying result into the
 * observability contract's shape for `attempt.completed`. Field
 * renames: `cacheReadTokens` → `cachedInputTokens`; `cacheSavingsUSD`
 * → `savingsUSD`. `cacheWriteTokens` has no direct contract-side
 * equivalent (cache write telemetry lives in `CacheStats` which
 * alpha.29 adapters wire — for now dropped from AttemptCompletedData).
 */
function toContractMetrics(r: {
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
  };
  cost: {
    inputUSD: number;
    outputUSD: number;
    totalUSD: number;
    cacheSavingsUSD?: number;
  };
  modelId: string;
  providerAlias: string;
}): AttemptMetrics {
  const usage: TokenUsage = {
    inputTokens: r.usage.inputTokens,
    outputTokens: r.usage.outputTokens,
    totalTokens: r.usage.totalTokens,
  };
  if (r.usage.cacheReadTokens !== undefined) usage.cachedInputTokens = r.usage.cacheReadTokens;
  if (r.usage.reasoningTokens !== undefined) usage.reasoningTokens = r.usage.reasoningTokens;
  const cost: CostUsage = {
    inputUSD: r.cost.inputUSD,
    outputUSD: r.cost.outputUSD,
    totalUSD: r.cost.totalUSD,
  };
  if (r.cost.cacheSavingsUSD !== undefined) cost.savingsUSD = r.cost.cacheSavingsUSD;
  return { usage, cost, modelId: r.modelId };
}

/**
 * Extract the fingerprintable subset of an options bag. Copies only
 * behaviorally-relevant fields per the contract's `FingerprintableRequest`
 * shape. The compute helper's canonicalization does the rest.
 *
 * Options fields NOT in `FingerprintableRequest` (like `priority`,
 * `taskType`, `signal`, `budgetScope`, `refs`, `forceProviderAlias`,
 * `onRetry`) are Registry-side orchestration knobs, not part of the
 * request identity, and are intentionally excluded.
 */
function toFingerprintable(options: object): FingerprintableRequest {
  const opts = options as Record<string, unknown>;
  const req: FingerprintableRequest = {};
  const passthrough: (keyof FingerprintableRequest)[] = [
    "messages",
    "system",
    "instructions",
    "tools",
    "tool_choice",
    "response_format",
    "schema",
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "frequency_penalty",
    "presence_penalty",
    "stop_sequences",
    "seed",
    "reasoning_effort",
  ];
  for (const key of passthrough) {
    if (opts[key] !== undefined) {
      (req as Record<string, unknown>)[key] = opts[key];
    }
  }
  return req;
}

/**
 * Per-attempt timeout helper (alpha.23+).
 *
 * Composes a per-call timeout with a user-supplied AbortSignal. Both fire
 * the same wrapped controller; the shorter trigger wins. Called fresh per
 * provider attempt inside `walkChain` so each provider gets its own budget.
 *
 * When `timeoutMs` is undefined AND there's no user signal, the wrapper is
 * a pass-through (no AbortController created).
 */
async function withPerAttemptTimeout<R>(
  timeoutMs: number | undefined,
  userSignal: AbortSignal | undefined,
  fn: (signal: AbortSignal | undefined) => Promise<R>,
): Promise<R> {
  if (timeoutMs === undefined && !userSignal) {
    return fn(undefined);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  let userListener: (() => void) | undefined;
  if (userSignal) {
    // If user signal already aborted, forward immediately.
    if (userSignal.aborted) {
      controller.abort();
    } else {
      userListener = () => controller.abort();
      userSignal.addEventListener("abort", userListener, { once: true });
    }
  }
  try {
    return await fn(controller.signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (userListener && userSignal) userSignal.removeEventListener("abort", userListener);
  }
}

class RegistryEmbeddingsPort implements EmbeddingsPort {
  constructor(private readonly registry: Registry) {}

  private async resolve(taskType: string, budgetScope?: BudgetScopeRef): Promise<ModelSelection> {
    const sel = await this.registry.selectModel(taskType, 2, budgetScope);
    if (!sel.embeddingsPort) {
      throw new NoProvidersAvailableError(taskType, [sel.alias], {
        [sel.alias]: `adapter "${sel.adapter.name}" does not implement EmbeddingsPort`,
      });
    }
    return sel;
  }

  async generateEmbedding(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const sel = await this.resolve(options.taskType, options.budgetScope);
    const result = await sel.embeddingsPort!.generateEmbedding(options);
    const key = this.registry.scopedKey(sel.alias, options.budgetScope);
    await this.registry.budget.recordRequest(key);
    await this.registry.cost.recordCost(key, result.cost.totalUSD);
    return result;
  }

  async generateEmbeddings(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const sel = await this.resolve(options.taskType, options.budgetScope);
    const result = await sel.embeddingsPort!.generateEmbeddings(options);
    const key = this.registry.scopedKey(sel.alias, options.budgetScope);
    await this.registry.budget.recordRequest(key);
    await this.registry.cost.recordCost(key, result.cost.totalUSD);
    return result;
  }
}

// ─── Runtime-fallback predicate resolution ───────────────────────────

/**
 * Translate the user-friendly `runtimeFallback` config into a predicate
 * the registry uses to decide whether to walk the chain on an error.
 *
 *   - `"default"` (or undefined): walk on `ProviderUnavailableError` only.
 *   - `"aggressive"` (alpha.25+, LP-REQ-01): walk on any provider-side
 *     signal via {@link aggressiveShouldFallback}.
 *   - `"none"`: never walk — preserves v0.1 behavior.
 *   - `{ shouldFallback }`: caller-supplied predicate.
 */
function resolveRuntimeFallback(
  opt: RegistryOptions["runtimeFallback"],
): (err: unknown, ctx?: ShouldFallbackContext) => boolean {
  if (opt === "none") return () => false;
  if (opt === "aggressive") return aggressiveShouldFallback;
  if (opt && typeof opt === "object" && "shouldFallback" in opt) {
    return opt.shouldFallback;
  }
  // Default preset: `ProviderUnavailableError` walks unconditionally, plus
  // alpha.30+ ctx-aware `AuthenticationError` walk on never-authenticated.
  // Note: this is the "default" preset (unnamed, opt === undefined). The
  // `defaultShouldFallback` exported function is the alpha.28+ canonical
  // walk-table, which is a separate opt-in via
  // `{ shouldFallback: defaultShouldFallback }`.
  return (err, ctx) => {
    if (err instanceof ProviderUnavailableError) return true;
    if (err instanceof AuthenticationError) {
      return ctx !== undefined && !ctx.hasEverAuthenticated;
    }
    return false;
  };
}
