/**
 * EmbeddingsPort — sibling interface to LLMPort for embedding generation.
 *
 * Split from LLMPort because most chat adapters (e.g. Anthropic) do not
 * expose embeddings, and some adapters (voyage-ai, cohere-embed-only) do
 * only embeddings. Forcing one port to span both kinds would produce
 * many stub implementations.
 *
 * See implementation plan v3 §6.2.
 */

import type { CostUsage, TaskType } from "./llm-port.js";
import type { BudgetScopeRef } from "../budget/types.js";

export interface EmbeddingOptions {
  taskType: TaskType;
  /** The text to embed. */
  input: string;
  /** Optional model hint; the registry typically picks via taskType. */
  modelHint?: string;
  /** Per-call scope hint for gating. Same semantics as LLMPort. (alpha.20+) */
  budgetScope?: BudgetScopeRef;
}

export interface BatchEmbeddingOptions {
  taskType: TaskType;
  /** Multiple inputs to embed in a single API call (provider-dependent batching). */
  inputs: string[];
  modelHint?: string;
  /** Per-call scope hint for gating. Same semantics as LLMPort. (alpha.20+) */
  budgetScope?: BudgetScopeRef;
}

export interface EmbeddingResult {
  vector: number[];
  dimensions: number;
  modelId: string;
  providerAlias: string;
  usage: { inputTokens: number };
  cost: CostUsage;
  latencyMs: number;
}

export interface BatchEmbeddingResult {
  vectors: number[][];
  dimensions: number;
  modelId: string;
  providerAlias: string;
  usage: { inputTokens: number };
  cost: CostUsage;
  latencyMs: number;
}

/**
 * Adapters that support embeddings implement this interface.
 * The registry exposes it via `getEmbeddingsPort()`, separate from `getPort()`.
 */
export interface EmbeddingsPort {
  generateEmbedding(options: EmbeddingOptions): Promise<EmbeddingResult>;
  generateEmbeddings(options: BatchEmbeddingOptions): Promise<BatchEmbeddingResult>;
}
