/**
 * createPlanner — decompose a goal into ordered or DAG-shaped steps.
 *
 * Returns Zod-validated structured output. The user supplies the schema
 * for what a "step" looks like (typically id + description + dependencies).
 */

import { toMessages, type CacheControl, type LLMPort, type LLMPriority, type MessageContent } from "@llm-ports/core";
import type { z } from "zod";
import {
  buildSystemPrompt,
  resolve,
  safelyInvoke,
  wrapContent,
  type CapabilityEvent,
  type Resolvable,
} from "../shared.js";

export interface PlanInput {
  goal: MessageContent;
  contextOverride?: string;
  /** Cancellation signal for this specific call. Threaded to the port. (alpha.13+) */
  signal?: AbortSignal;
  /** Override task routing for this call only. (alpha.13+) */
  forceProviderAlias?: string;
  /** Per-call escape hatch for provider-specific request fields (vLLM chat_template_kwargs, SGLang regex, etc.). Threaded to the underlying port call. (alpha.16+) */
  providerExtras?: Record<string, unknown>;
  /** Per-call prompt cache configuration. Forwarded to the underlying port call. (alpha.19.1+) */
  cacheControl?: CacheControl;
  /**
   * Per-call override for strict-schema response_format mode. (alpha.21+)
   * Forwarded to the underlying port call. See `GenerateStructuredOptions.strict`.
   */
  strict?: boolean;
}

export interface CreatePlannerConfig<TSchema extends z.ZodTypeAny> {
  port: LLMPort;
  schema: TSchema;
  schemaName: string;
  /** Optional planning approach (e.g. "depth-first; minimize dependencies"). */
  strategy?: Resolvable<PlanInput, string>;
  /** Available tools / capabilities the plan may reference. */
  toolCatalog?: Resolvable<PlanInput, string>;
  /** Examples of well-formed plans for similar goals. */
  examples?: Resolvable<PlanInput, string>;
  systemContext?: Resolvable<PlanInput, string>;
  taskType?: string;
  priority?: LLMPriority;
  /** Default 0.2. */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Reasoning effort hint for o-series / gpt-5-nano / Groq gpt-oss-120b.
   * Applies to every call from this planner. (alpha.13+)
   */
  reasoningEffort?: "low" | "medium" | "high";
  onBeforeCall?: (input: PlanInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<z.infer<TSchema>>) => void | Promise<void>;
  onError?: (error: Error, input: PlanInput) => void | Promise<void>;
}

const ROLE = "Planning system. Decompose the goal into the smallest set of well-ordered steps that accomplishes it.";
const GUARDRAILS = "Each step should be concrete enough to execute. Reference only tools that exist in the catalog. State dependencies explicitly.";

export function createPlanner<TSchema extends z.ZodTypeAny>(
  config: CreatePlannerConfig<TSchema>,
): (input: PlanInput) => Promise<z.infer<TSchema>> {
  const taskType = config.taskType ?? "plan";

  return async (input: PlanInput): Promise<z.infer<TSchema>> => {
    await safelyInvoke(config.onBeforeCall, input);
    try {
      const [strategy, toolCatalog, examples, context] = await Promise.all([
        resolve(config.strategy, input),
        resolve(config.toolCatalog, input),
        resolve(config.examples, input),
        resolve(config.systemContext, input),
      ]);
      const fullContext = [context, input.contextOverride].filter(Boolean).join("\n\n");
      const rubricParts = [strategy, toolCatalog ? `Available tools:\n${toolCatalog}` : undefined]
        .filter(Boolean)
        .join("\n\n");
      const system = buildSystemPrompt({
        role: ROLE,
        ...(fullContext ? { context: fullContext } : {}),
        ...(rubricParts ? { rubric: rubricParts } : {}),
        ...(examples ? { examples } : {}),
        guardrails: GUARDRAILS,
      });
      const result = await config.port.generateStructured({
        taskType,
        ...(config.priority !== undefined ? { priority: config.priority } : {}),
        messages: toMessages(system, wrapContent(input.goal)),
        schema: config.schema,
        schemaName: config.schemaName,
        temperature: config.temperature ?? 0.2,
        ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
        ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.forceProviderAlias ? { forceProviderAlias: input.forceProviderAlias } : {}),
        ...(input.providerExtras ? { providerExtras: input.providerExtras } : {}),
        ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
        ...(input.strict !== undefined ? { strict: input.strict } : {}),
      });
      await safelyInvoke(config.onResult, {
        capability: "plan",
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
