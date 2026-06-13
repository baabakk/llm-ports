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
  GenerateStructuredOptions,
  GenerateStructuredResult,
  GenerateTextOptions,
  GenerateTextResult,
  LLMPort,
  RunAgentOptions,
  StreamStructuredOptions,
  StreamTextOptions,
} from "../ports/llm-port.js";
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
  ConfigError,
  NoProvidersAvailableError,
  ProviderUnavailableError,
} from "../errors.js";
import type { ProviderEntry, RegistryConfig } from "./config.js";
import { parseRegistryConfig } from "./config.js";
import { CostSession, type OpenCostSessionOptions } from "./cost-session.js";

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
   */
  runtimeFallback?:
    | "default" // walk on ProviderUnavailableError
    | "none" // disable; caller handles errors
    | { shouldFallback: (err: unknown) => boolean };
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
   */
  public readonly shouldFallback: (err: unknown) => boolean;
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

  /** Resolve the first usable provider in the task's fallback chain. */
  async selectModel(
    taskType: string,
    priority: 0 | 1 | 2 | 3 = 2,
    budgetScope?: BudgetScopeRef,
  ): Promise<ModelSelection> {
    const chain = this.config.taskRoutes[taskType] ?? this.config.taskRoutes["general"] ?? [];
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
    const chain = this.config.taskRoutes[taskType] ?? this.config.taskRoutes["general"] ?? [];
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
async function walkChain<R>(
  registry: Registry,
  taskType: string,
  priority: 0 | 1 | 2 | 3 | undefined,
  attempt: (sel: ModelSelection) => Promise<R>,
  recordCost: (sel: ModelSelection, result: R, key: string) => Promise<void>,
  forceProviderAlias?: string,
  budgetScope?: BudgetScopeRef,
): Promise<R> {
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
    const result = await attempt(sel);
    const key = registry.scopedKey(sel.alias, budgetScope);
    await registry.budget.recordRequest(key);
    await recordCost(sel, result, key);
    return result;
  }
  const chain = await registry.selectViableChain(taskType, priority, budgetScope);
  const reasons: Record<string, string> = {};
  let lastErr: unknown;
  for (const sel of chain) {
    if (!sel.port) {
      reasons[sel.alias] = `adapter "${sel.adapter.name}" does not implement LLMPort`;
      continue;
    }
    try {
      const result = await attempt(sel);
      const key = registry.scopedKey(sel.alias, budgetScope);
      await registry.budget.recordRequest(key);
      await recordCost(sel, result, key);
      return result;
    } catch (err) {
      lastErr = err;
      if (!registry.shouldFallback(err)) throw err;
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
      reasons[sel.alias] = `runtime fallback: ${message}`;
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

class RegistryPort implements LLMPort {
  constructor(private readonly registry: Registry) {}

  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    return walkChain(
      this.registry,
      options.taskType,
      options.priority,
      (sel) => sel.port!.generateText(options),
      (_sel, result, key) => this.registry.cost.recordCost(key, result.cost.totalUSD),
      options.forceProviderAlias,
      options.budgetScope,
    );
  }

  async generateStructured<T>(
    options: GenerateStructuredOptions<T>,
  ): Promise<GenerateStructuredResult<T>> {
    return walkChain(
      this.registry,
      options.taskType,
      options.priority,
      (sel) => sel.port!.generateStructured(options),
      (_sel, result, key) => this.registry.cost.recordCost(key, result.cost.totalUSD),
      options.forceProviderAlias,
      options.budgetScope,
    );
  }

  async *streamText(options: StreamTextOptions): AsyncIterable<string> {
    // Streaming runtime fallback is more nuanced — once we start yielding
    // chunks, switching providers mid-stream would emit a confusing mix.
    // For alpha.7 we walk the chain on the INITIAL `streamText()` call
    // (most failures happen at stream-creation time anyway), then yield
    // through whatever stream opened successfully. Mid-stream errors
    // propagate as-is to the consumer; users handle them with a try/catch
    // inside the for-await. Document this limit in the cancellation guide.
    const startStream = async (sel: ModelSelection): Promise<AsyncIterable<string>> => {
      // walkChain records the request after startStream resolves; pre-record
      // is intentional only for streaming since the cost isn't observed.
      return sel.port!.streamText(options);
    };
    const stream = await walkChain(
      this.registry,
      options.taskType,
      options.priority,
      startStream,
      // No cost to record at stream-creation; streaming costs surface as the
      // stream completes, and the existing v0.1 contract doesn't record per-chunk.
      async () => {
        /* noop */
      },
      options.forceProviderAlias,
      options.budgetScope,
    );
    yield* stream;
  }

  async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
    const startStream = async (sel: ModelSelection): Promise<AsyncIterable<Partial<T>>> => {
      return sel.port!.streamStructured(options);
    };
    const stream = await walkChain(
      this.registry,
      options.taskType,
      options.priority,
      startStream,
      async () => {
        /* noop */
      },
      options.forceProviderAlias,
      options.budgetScope,
    );
    yield* stream;
  }

  async runAgent(options: RunAgentOptions): Promise<AgentResult> {
    return walkChain(
      this.registry,
      options.taskType,
      options.priority,
      (sel) => sel.port!.runAgent(options),
      (_sel, result, key) => this.registry.cost.recordCost(key, result.cost.totalUSD),
      options.forceProviderAlias,
      options.budgetScope,
    );
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
 *   - `"none"`: never walk — preserves v0.1 behavior.
 *   - `{ shouldFallback }`: caller-supplied predicate.
 */
function resolveRuntimeFallback(
  opt: RegistryOptions["runtimeFallback"],
): (err: unknown) => boolean {
  if (opt === "none") return () => false;
  if (opt && typeof opt === "object" && "shouldFallback" in opt) {
    return opt.shouldFallback;
  }
  // Default
  return (err) => err instanceof ProviderUnavailableError;
}
