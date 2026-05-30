/**
 * createClassifier — pick one of N categories from input content.
 *
 * Returns a typed function that, given input content, returns a parsed
 * Zod-validated object (typically including the chosen category plus a
 * reasoning field). Configure once at app startup; call many times.
 */

import type { LLMPort, LLMPriority, MessageContent } from "@llm-ports/core";
import type { z } from "zod";
import {
  buildSystemPrompt,
  resolve,
  safelyInvoke,
  wrapContent,
  type CapabilityEvent,
  type Resolvable,
} from "../shared.js";

export interface ClassifyInput {
  content: MessageContent;
  /** Per-call context override; appended to systemContext. */
  contextOverride?: string;
  /** Cancellation signal for this specific call. Threaded to the port. (alpha.13+) */
  signal?: AbortSignal;
  /** Override task routing for this call only. (alpha.13+) */
  forceProviderAlias?: string;
  /** Per-call escape hatch for provider-specific request fields (vLLM chat_template_kwargs, SGLang regex, etc.). Threaded to the underlying port call. (alpha.16+) */
  providerExtras?: Record<string, unknown>;
}

export interface CreateClassifierConfig<TSchema extends z.ZodTypeAny> {
  /** The LLM port. Typically `registry.getPort()`. */
  port: LLMPort;
  /** The Zod schema the model's output must conform to. */
  schema: TSchema;
  /** Operation name used in logs and the model prompt. */
  schemaName: string;

  /** Optional rules text that defines the categories. */
  rubric?: Resolvable<ClassifyInput, string>;
  /** Optional boundary examples ("X is intent A; Y is intent B"). */
  boundaryExamples?: Resolvable<ClassifyInput, string>;
  /** Optional extra context (per-input) the model should consider. */
  systemContext?: Resolvable<ClassifyInput, string>;

  /** Task type for routing. Default: "classify". */
  taskType?: string;
  priority?: LLMPriority;
  /** Default 0 (deterministic). */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Reasoning effort hint for o-series / gpt-5-nano / Groq gpt-oss-120b.
   * Applies to every call from this classifier. (alpha.13+)
   */
  reasoningEffort?: "low" | "medium" | "high";

  /** Hooks. Errors in hooks are caught and logged, never re-thrown. */
  onBeforeCall?: (input: ClassifyInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<z.infer<TSchema>>) => void | Promise<void>;
  onError?: (error: Error, input: ClassifyInput) => void | Promise<void>;
}

const ROLE_DEFAULT = "Classification system. Pick exactly one category that best matches.";
const GUARDRAILS_DEFAULT = "Classify decisively. Do not hedge. If uncertain between two options, round toward higher urgency.";

/**
 * Create a configured classifier function.
 *
 * @example
 * const classify = createClassifier({
 *   port: llm,
 *   schema: z.object({
 *     intent: z.enum(["question", "request", "complaint"]),
 *     reasoning: z.string(),
 *   }),
 *   schemaName: "user-intent",
 *   rubric: "question: asking for info\nrequest: wants action\ncomplaint: reports problem",
 * });
 *
 * const result = await classify({ content: "Can I get a refund?" });
 * // { intent: "request", reasoning: "..." }
 */
export function createClassifier<TSchema extends z.ZodTypeAny>(
  config: CreateClassifierConfig<TSchema>,
): (input: ClassifyInput) => Promise<z.infer<TSchema>> {
  const taskType = config.taskType ?? "classify";

  return async (input: ClassifyInput): Promise<z.infer<TSchema>> => {
    await safelyInvoke(config.onBeforeCall, input);

    try {
      const [rubric, examples, context] = await Promise.all([
        resolve(config.rubric, input),
        resolve(config.boundaryExamples, input),
        resolve(config.systemContext, input),
      ]);
      const fullContext = [context, input.contextOverride].filter(Boolean).join("\n\n");

      const system = buildSystemPrompt({
        role: ROLE_DEFAULT,
        ...(fullContext ? { context: fullContext } : {}),
        ...(rubric ? { rubric } : {}),
        ...(examples ? { examples } : {}),
        guardrails: GUARDRAILS_DEFAULT,
      });

      const result = await config.port.generateStructured({
        taskType,
        ...(config.priority !== undefined ? { priority: config.priority } : {}),
        instructions: system,
        prompt: wrapContent(input.content),
        schema: config.schema,
        schemaName: config.schemaName,
        temperature: config.temperature ?? 0,
        ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
        ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.forceProviderAlias ? { forceProviderAlias: input.forceProviderAlias } : {}),
        ...(input.providerExtras ? { providerExtras: input.providerExtras } : {}),
      });

      await safelyInvoke(config.onResult, {
        capability: "classify",
        schemaName: config.schemaName,
        modelId: result.modelId,
        providerAlias: result.providerAlias,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        },
        cost: {
          inputUSD: result.cost.inputUSD,
          outputUSD: result.cost.outputUSD,
          totalUSD: result.cost.totalUSD,
        },
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
