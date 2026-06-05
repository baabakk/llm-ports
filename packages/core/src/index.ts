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
  ProviderModelInfo,
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

export type {
  RerankedDocument,
  RerankInput,
  RerankPort,
  RerankResult,
} from "./ports/rerank-port.js";

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
  type PricingFreshnessAdapterReport,
  type PricingFreshnessReport,
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
  AuthenticationError,
  BadRequestError,
  BudgetExceededError,
  ConfigError,
  ContentBlockUnsupportedError,
  ContentPolicyViolationError,
  ContextWindowExceededError,
  EmptyResponseError,
  errorMatchers,
  ImageTooLargeError,
  InvalidImageUrlError,
  LLMPortError,
  NoProvidersAvailableError,
  ProviderUnavailableError,
  RateLimitError,
  ServiceUnavailableError,
  SessionBudgetExceededError,
  ValidationError,
} from "./errors.js";

// ─── Retry observability ─────────────────────────────────────────────
export type {
  BackoffConfig,
  JitterStrategy,
  OnRetry,
  RetryEvent,
  RetryReason,
} from "./retry.js";
export { computeBackoffDelay } from "./retry.js";
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

// ─── Shared adapter utilities ────────────────────────────────────────
export { wrapProviderError } from "./utils/wrap-provider-error.js";
export { stringifyContentBlocks } from "./utils/stringify-content.js";
export { extractJSON, tryParsePartialJSON } from "./utils/json.js";
export { mergeTokenUsage } from "./utils/usage.js";
export { attemptValidationRepair } from "./utils/repair-validation.js";
export { validateImageBlocks, validateImageUrl } from "./utils/validate-image.js";
export type { ValidateImageOptions } from "./utils/validate-image.js";

// ─── Cost session ────────────────────────────────────────────────────
export { CostSession } from "./registry/cost-session.js";
export type { OpenCostSessionOptions } from "./registry/cost-session.js";

// ─── Abort signal helper ─────────────────────────────────────────────
export { throwIfAborted } from "./utils/abort.js";
