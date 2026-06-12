/**
 * Shared utilities used by every capability factory.
 *
 * These helpers handle:
 *   - dynamic prompt fragment resolution (string-or-function fields)
 *   - safe hook invocation (errors in user hooks must not crash the call)
 *   - common system prompt assembly
 */

import type { LLMMessage, LLMPort, MessageContent, TaskType } from "@llm-ports/core";

// ─── Common types ────────────────────────────────────────────────────

/**
 * A prompt fragment may be a literal string OR a function that returns one.
 * Functions can be sync or async; capabilities resolve them lazily so users
 * can plug in DB lookups, feature flags, or context-derived content.
 */
export type Resolvable<TInput, TOutput> =
  | TOutput
  | ((input: TInput) => TOutput | Promise<TOutput>);

export interface CapabilityEvent<TOutput> {
  /** Human-readable capability name, e.g. "classify". */
  capability: string;
  /** Schema/operation name as configured by the user. */
  schemaName: string;
  /** Model id reported by the adapter. */
  modelId: string;
  /** Provider alias used. */
  providerAlias: string;
  /** Token usage and USD cost. */
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /**
   * USD cost. `cacheSavingsUSD` is populated when the provider returned cache
   * telemetry on this call (so the consumer can attribute savings per-capability).
   * (alpha.19.1+)
   */
  cost: { inputUSD: number; outputUSD: number; totalUSD: number; cacheSavingsUSD?: number };
  latencyMs: number;
  /** The validated output the capability returned. */
  output: TOutput;
  /** Number of attempts (>1 if retry-with-feedback fired). */
  validationAttempts?: number;
}

// ─── Resolvers ───────────────────────────────────────────────────────

/** Resolve a Resolvable<TInput, TOutput> by invoking it with the input if it's a function. */
export async function resolve<TInput, TOutput>(
  value: Resolvable<TInput, TOutput> | undefined,
  input: TInput,
): Promise<TOutput | undefined> {
  if (value === undefined) return undefined;
  if (typeof value === "function") {
    return await (value as (input: TInput) => TOutput | Promise<TOutput>)(input);
  }
  return value;
}

// ─── Hook safety ─────────────────────────────────────────────────────

/**
 * Invoke a user-provided hook. Hook errors are caught and logged to console
 * but never re-thrown — observability hooks should not break the actual call.
 */
export async function safelyInvoke<TArgs extends unknown[]>(
  hook: ((...args: TArgs) => void | Promise<void>) | undefined,
  ...args: TArgs
): Promise<void> {
  if (!hook) return;
  try {
    await hook(...args);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[llm-ports/capabilities] hook failed:", err);
  }
}

// ─── System prompt assembly ──────────────────────────────────────────

export interface SystemPromptParts {
  role: string;
  context?: string;
  rubric?: string;
  examples?: string;
  guardrails?: string;
}

/**
 * Assemble a system prompt from labeled fragments. Sections are wrapped in
 * XML-style tags so capable models parse them deterministically.
 */
export function buildSystemPrompt(parts: SystemPromptParts): string {
  const out: string[] = [`<role>${parts.role}</role>`];
  if (parts.context) out.push(`<context>\n${parts.context}\n</context>`);
  if (parts.rubric) out.push(`<rules>\n${parts.rubric}\n</rules>`);
  if (parts.examples) out.push(`<examples>\n${parts.examples}\n</examples>`);
  if (parts.guardrails) out.push(parts.guardrails);
  return out.join("\n\n");
}

/** Wrap user content in a content tag so the model can distinguish data from instructions. */
export function wrapContent(content: MessageContent): MessageContent {
  if (typeof content === "string") {
    return `<content>\n${content}\n</content>`;
  }
  // For multimodal content, prepend a labeling text block so non-text content
  // is still framed as data.
  return [{ type: "text", text: "<content>" }, ...content, { type: "text", text: "</content>" }];
}

// ─── Re-exports ──────────────────────────────────────────────────────

export type { LLMMessage, LLMPort, MessageContent, TaskType };
