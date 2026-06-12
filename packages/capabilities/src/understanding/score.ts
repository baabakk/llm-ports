/**
 * createScorer — rate input against a rubric. Schema typically includes a
 * numerical score plus reasoning.
 */

import type { CacheControl, LLMPort, LLMPriority, MessageContent } from "@llm-ports/core";
import type { z } from "zod";
import {
  buildSystemPrompt,
  resolve,
  safelyInvoke,
  wrapContent,
  type CapabilityEvent,
  type Resolvable,
} from "../shared.js";

export interface ScoreInput {
  content: MessageContent;
  contextOverride?: string;
  /** Cancellation signal for this specific call. Threaded to the port. (alpha.13+) */
  signal?: AbortSignal;
  /** Override task routing for this call only. (alpha.13+) */
  forceProviderAlias?: string;
  /** Per-call escape hatch for provider-specific request fields (vLLM chat_template_kwargs, SGLang regex, etc.). Threaded to the underlying port call. (alpha.16+) */
  providerExtras?: Record<string, unknown>;
  /** Per-call prompt cache configuration. Forwarded to the underlying port call. (alpha.19.1+) */
  cacheControl?: CacheControl;
}

export interface CreateScorerConfig<TSchema extends z.ZodTypeAny> {
  port: LLMPort;
  schema: TSchema;
  schemaName: string;
  /** Required: the scoring rubric (what determines a high vs low score). */
  rubric: Resolvable<ScoreInput, string>;
  /** Optional examples of low/medium/high scored items. */
  examples?: Resolvable<ScoreInput, string>;
  systemContext?: Resolvable<ScoreInput, string>;
  taskType?: string;
  priority?: LLMPriority;
  /** Default 0.1 — slight randomness helps surface borderline cases consistently. */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Reasoning effort hint for o-series / gpt-5-nano / Groq gpt-oss-120b.
   * Applies to every call from this scorer. (alpha.13+)
   */
  reasoningEffort?: "low" | "medium" | "high";
  onBeforeCall?: (input: ScoreInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<z.infer<TSchema>>) => void | Promise<void>;
  onError?: (error: Error, input: ScoreInput) => void | Promise<void>;
}

const ROLE = "Scoring system. Rate the input against the provided rubric. Be calibrated; explain your reasoning.";
const GUARDRAILS = "Score on the rubric's defined scale. Justify with one or two specific observations from the input.";

export function createScorer<TSchema extends z.ZodTypeAny>(
  config: CreateScorerConfig<TSchema>,
): (input: ScoreInput) => Promise<z.infer<TSchema>> {
  const taskType = config.taskType ?? "score";

  return async (input: ScoreInput): Promise<z.infer<TSchema>> => {
    await safelyInvoke(config.onBeforeCall, input);
    try {
      const [rubric, examples, context] = await Promise.all([
        resolve(config.rubric, input),
        resolve(config.examples, input),
        resolve(config.systemContext, input),
      ]);
      const fullContext = [context, input.contextOverride].filter(Boolean).join("\n\n");
      const system = buildSystemPrompt({
        role: ROLE,
        ...(fullContext ? { context: fullContext } : {}),
        rubric: rubric!,
        ...(examples ? { examples } : {}),
        guardrails: GUARDRAILS,
      });
      const result = await config.port.generateStructured({
        taskType,
        ...(config.priority !== undefined ? { priority: config.priority } : {}),
        instructions: system,
        prompt: wrapContent(input.content),
        schema: config.schema,
        schemaName: config.schemaName,
        temperature: config.temperature ?? 0.1,
        ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
        ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.forceProviderAlias ? { forceProviderAlias: input.forceProviderAlias } : {}),
        ...(input.providerExtras ? { providerExtras: input.providerExtras } : {}),
        ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
      });
      await safelyInvoke(config.onResult, {
        capability: "score",
        schemaName: config.schemaName,
        modelId: result.modelId,
        providerAlias: result.providerAlias,
        usage: result.usage,
        cost: result.cost,
        latencyMs: result.latencyMs,
        output: result.data,
        validationAttempts: result.validationAttempts,
      });
      return result.data;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await safelyInvoke(config.onError, error, input);
      throw error;
    }
  };
}
