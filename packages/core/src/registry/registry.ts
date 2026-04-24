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
import type { BudgetBackend, CostBackend, ModelPricing } from "../budget/types.js";
import { InMemoryBudget, InMemoryCost } from "../budget/memory.js";
import {
  DEFAULT_VALIDATION_STRATEGY,
  type ValidationStrategy,
} from "../validation.js";
import {
  ConfigError,
  NoProvidersAvailableError,
} from "../errors.js";
import type { ProviderEntry, RegistryConfig } from "./config.js";
import { parseRegistryConfig } from "./config.js";

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
  private readonly adapters: Record<string, AdapterRegistration>;
  private readonly pricingOverrides: Record<string, ModelPricing>;

  constructor(opts: RegistryOptions) {
    this.config = parseRegistryConfig({ envPrefix: opts.envPrefix, env: opts.env });
    this.adapters = opts.adapters;
    this.budget = opts.budget ?? new InMemoryBudget();
    this.cost = opts.cost ?? new InMemoryCost();
    this.validationStrategy = opts.validationStrategy ?? DEFAULT_VALIDATION_STRATEGY;
    this.pricingOverrides = opts.pricingOverrides ?? {};
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

  /** Resolve the first usable provider in the task's fallback chain. */
  async selectModel(
    taskType: string,
    priority: 0 | 1 | 2 | 3 = 2,
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
        const budgetCheck = await this.budget.check(alias, entry.budgetLimit);
        if (!budgetCheck.allowed) {
          reasons[alias] = budgetCheck.reason ?? "budget exceeded";
          continue;
        }
        const costCheck = await this.cost.check(alias, entry.costLimit);
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

  /** Returns an LLMPort whose methods route to the selected adapter per call. */
  getPort(): LLMPort {
    return new RegistryPort(this);
  }

  /** Returns an EmbeddingsPort whose methods route to the selected adapter per call. */
  getEmbeddingsPort(): EmbeddingsPort {
    return new RegistryEmbeddingsPort(this);
  }

  /** Introspection: list all provider aliases. */
  listProviders(): ProviderEntry[] {
    return Object.values(this.config.providers);
  }

  /** Introspection: list all configured task routes. */
  listTasks(): Array<{ task: string; chain: string[] }> {
    return Object.entries(this.config.taskRoutes).map(([task, chain]) => ({ task, chain }));
  }
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

class RegistryPort implements LLMPort {
  constructor(private readonly registry: Registry) {}

  private async resolve(taskType: string, priority?: 0 | 1 | 2 | 3): Promise<ModelSelection> {
    const sel = await this.registry.selectModel(taskType, priority);
    if (!sel.port) {
      throw new NoProvidersAvailableError(taskType, [sel.alias], {
        [sel.alias]: `adapter "${sel.adapter.name}" does not implement LLMPort`,
      });
    }
    return sel;
  }

  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    const sel = await this.resolve(options.taskType, options.priority);
    const result = await sel.port!.generateText(options);
    await this.registry.budget.recordRequest(sel.alias);
    await this.registry.cost.recordCost(sel.alias, result.cost.totalUSD);
    return result;
  }

  async generateStructured<T>(
    options: GenerateStructuredOptions<T>,
  ): Promise<GenerateStructuredResult<T>> {
    const sel = await this.resolve(options.taskType, options.priority);
    const result = await sel.port!.generateStructured(options);
    await this.registry.budget.recordRequest(sel.alias);
    await this.registry.cost.recordCost(sel.alias, result.cost.totalUSD);
    return result;
  }

  async *streamText(options: StreamTextOptions): AsyncIterable<string> {
    const sel = await this.resolve(options.taskType, options.priority);
    await this.registry.budget.recordRequest(sel.alias);
    yield* sel.port!.streamText(options);
  }

  async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
    const sel = await this.resolve(options.taskType, options.priority);
    await this.registry.budget.recordRequest(sel.alias);
    yield* sel.port!.streamStructured(options);
  }

  async runAgent(options: RunAgentOptions): Promise<AgentResult> {
    const sel = await this.resolve(options.taskType, options.priority);
    const result = await sel.port!.runAgent(options);
    await this.registry.budget.recordRequest(sel.alias);
    await this.registry.cost.recordCost(sel.alias, result.cost.totalUSD);
    return result;
  }
}

class RegistryEmbeddingsPort implements EmbeddingsPort {
  constructor(private readonly registry: Registry) {}

  private async resolve(taskType: string): Promise<ModelSelection> {
    const sel = await this.registry.selectModel(taskType, 2);
    if (!sel.embeddingsPort) {
      throw new NoProvidersAvailableError(taskType, [sel.alias], {
        [sel.alias]: `adapter "${sel.adapter.name}" does not implement EmbeddingsPort`,
      });
    }
    return sel;
  }

  async generateEmbedding(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const sel = await this.resolve(options.taskType);
    const result = await sel.embeddingsPort!.generateEmbedding(options);
    await this.registry.budget.recordRequest(sel.alias);
    await this.registry.cost.recordCost(sel.alias, result.cost.totalUSD);
    return result;
  }

  async generateEmbeddings(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult> {
    const sel = await this.resolve(options.taskType);
    const result = await sel.embeddingsPort!.generateEmbeddings(options);
    await this.registry.budget.recordRequest(sel.alias);
    await this.registry.cost.recordCost(sel.alias, result.cost.totalUSD);
    return result;
  }
}
