/**
 * Validation strategies for generateStructured() output that fails schema.
 *
 * The default is `retry-with-feedback` with maxAttempts=2: when validation
 * fails, the strategy injects the Zod errors into the next prompt and asks
 * the model to regenerate. BEPA's production NL workflow engine achieves
 * ~70% fix rate on the second attempt with this strategy.
 *
 * See implementation plan v3 §6.7 and decision 13.
 */

import type { z, ZodIssue } from "zod";
import { ValidationError } from "./errors.js";

/**
 * Strategy applied when generated structured output fails schema validation.
 *
 * - `throw`:                     fail immediately with ValidationError.
 * - `retry-with-feedback`:       re-prompt the model with the Zod errors
 *                                injected into the next user message. Default.
 * - `fallback-to-next-provider`: skip to the next provider in the task chain
 *                                (the registry handles the actual fallback).
 * - `custom`:                    user-provided handler decides what to do.
 */
export type ValidationStrategy =
  | { kind: "throw" }
  | {
      kind: "retry-with-feedback";
      maxAttempts: number;
      includeOriginalError: boolean;
    }
  | { kind: "fallback-to-next-provider" }
  | {
      kind: "custom";
      handler: <T>(ctx: ValidationFailureContext<T>) => Promise<T>;
    };

export interface ValidationFailureContext<T> {
  attempt: number;
  schema: z.ZodType<T>;
  rawOutput: unknown;
  issues: ZodIssue[];
  /** Re-invoke the model with a (possibly modified) prompt. */
  retry: (correctionMessage?: string) => Promise<T>;
}

/** Default strategy: retry twice with the validation errors fed back. */
export const DEFAULT_VALIDATION_STRATEGY: ValidationStrategy = {
  kind: "retry-with-feedback",
  maxAttempts: 2,
  includeOriginalError: true,
};

/**
 * Build a correction prompt from Zod issues. Adapters call this when
 * implementing retry-with-feedback to construct the re-prompt.
 */
export function buildCorrectionPrompt(issues: ZodIssue[]): string {
  const bullets = issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `- ${path}: ${issue.message}`;
    })
    .join("\n");
  return `Your previous response failed validation:\n${bullets}\n\nPlease regenerate the response with valid output that conforms to the schema.`;
}

/**
 * Helper for adapters: throw the canonical ValidationError when the strategy
 * has exhausted attempts or kind is "throw".
 */
export function failValidation(issues: ZodIssue[], attempts: number): never {
  throw new ValidationError(issues, attempts);
}
