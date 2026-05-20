/**
 * @llm-ports/core — public API.
 *
 * The foundation of llm-ports: SDK-independent port interfaces, multimodal
 * content blocks, registry with cost-and-budget gating, validation strategies,
 * error types. Adapters and capabilities import from here; user code imports
 * either from here directly or from @llm-ports/capabilities.
 */

// ─── Ports ───────────────────────────────────────────────────────────
export type {
  AgentResult,
  CostUsage,
  GenerateStructuredOptions,
  GenerateStructuredResult,
  GenerateTextOptions,
  GenerateTextResult,
  LLMMessage,
  LLMPort,
  LLMPriority,
  MessageRole,
  RunAgentOptions,
  StreamStructuredOptions,
  StreamTextOptions,
  TaskType,
  TokenUsage,
  ToolDefinition,
} from "./ports/llm-port.js";

export type {
  BatchEmbeddingOptions,
  BatchEmbeddingResult,
  EmbeddingOptions,
  EmbeddingResult,
  EmbeddingsPort,
} from "./ports/embeddings-port.js";

// ─── Content blocks ──────────────────────────────────────────────────
export type {
  AudioBlock,
  AudioSource,
  ContentBlock,
  ImageBlock,
  ImageSource,
  MessageContent,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./content/blocks.js";

export {
  extractText,
  isStringContent,
  toBlocks,
  tryCollapseToText,
} from "./content/normalize.js";

// ─── Registry ────────────────────────────────────────────────────────
export {
  createRegistryFromEnv,
  Registry,
  type AdapterRegistration,
  type ModelSelection,
  type RegistryOptions,
} from "./registry/registry.js";

export {
  parseRegistryConfig,
  type ParseConfigOptions,
  type ProviderEntry,
  type RegistryConfig,
} from "./registry/config.js";

export {
  declareTasks,
  getTaskConfig,
  type TaskConfig,
} from "./registry/tasks.js";

// ─── Budget and cost ─────────────────────────────────────────────────
export type {
  BudgetBackend,
  BudgetCheckResult,
  BudgetLimit,
  CostBackend,
  CostCheckResult,
  CostLimit,
  ModelCapabilities,
  ModelPricing,
} from "./budget/types.js";

export { InMemoryBudget, InMemoryCost } from "./budget/memory.js";
export { computeChatCost, computeEmbeddingCost } from "./budget/cost.js";

// ─── Validation ──────────────────────────────────────────────────────
export {
  buildCorrectionPrompt,
  DEFAULT_VALIDATION_STRATEGY,
  failValidation,
  type ValidationFailureContext,
  type ValidationStrategy,
} from "./validation.js";

// ─── Errors ──────────────────────────────────────────────────────────
export {
  BudgetExceededError,
  ConfigError,
  ContentBlockUnsupportedError,
  EmptyResponseError,
  NoProvidersAvailableError,
  ProviderUnavailableError,
  ValidationError,
} from "./errors.js";

// ─── Retry observability ─────────────────────────────────────────────
export type { OnRetry, RetryEvent, RetryReason } from "./retry.js";
export { emitRetryEvent } from "./retry-emit.js";

// ─── Capability learning (shared across adapters) ────────────────────
export {
  createCapabilityLearner,
  type CapabilityLearner,
  type KnownModelConstraint,
} from "./capabilities-learning.js";

// ─── Notification on runtime-learned constraints ─────────────────────
export {
  buildLearningIssueUrl,
  emitFirstLearningWarning,
  _resetWarnedState,
  type FirstLearningEvent,
} from "./notify-learning.js";
