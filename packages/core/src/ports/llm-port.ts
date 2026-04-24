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

// ─── Routing primitives ───────────────────────────────────────────────

/**
 * Task type. Free-form string; users define their own vocabulary.
 * For type-safe usage with autocomplete, see `declareTasks<T>()`.
 */
export type TaskType = string;

/** Priority tier. 0 = critical (bypasses budget gating); 3 = low. */
export type LLMPriority = 0 | 1 | 2 | 3;

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
  outputTokens: number;
  totalTokens: number;
  /** Tokens read from prompt cache (Anthropic feature; 0 elsewhere). */
  cacheReadTokens?: number;
  /** Tokens written to prompt cache. */
  cacheWriteTokens?: number;
}

export interface CostUsage {
  inputUSD: number;
  outputUSD: number;
  totalUSD: number;
  /** Discount applied due to prompt cache reads. */
  cacheDiscountUSD?: number;
}

// ─── Request option types ─────────────────────────────────────────────

export interface GenerateTextOptions {
  taskType: TaskType;
  priority?: LLMPriority;
  /** System-level instructions ("system" prompt). */
  instructions?: string;
  /** User input. Either a single string or a structured prompt. */
  prompt: MessageContent;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface GenerateStructuredOptions<T> {
  taskType: TaskType;
  priority?: LLMPriority;
  instructions?: string;
  prompt: MessageContent;
  schema: z.ZodType<T>;
  /** Hint for the model about what the schema represents. */
  schemaName?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface StreamTextOptions {
  taskType: TaskType;
  priority?: LLMPriority;
  instructions?: string;
  prompt: MessageContent;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface StreamStructuredOptions<T> {
  taskType: TaskType;
  priority?: LLMPriority;
  instructions?: string;
  prompt: MessageContent;
  schema: z.ZodType<T>;
  schemaName?: string;
  maxOutputTokens?: number;
  temperature?: number;
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
}
