/**
 * createAnalyzer — evaluate, critique, or compare. Returns Zod-validated
 * structured output. Use when the user wants a "what do you think about
 * this?" answer with explicit reasoning and recommendations.
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

export interface AnalyzeInput {
  content: MessageContent;
  /** Optional explicit question; if omitted, the analyzer's framework drives the analysis. */
  question?: string;
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

export interface CreateAnalyzerConfig<TSchema extends z.ZodTypeAny> {
  port: LLMPort;
  schema: TSchema;
  schemaName: string;
  /** REQUIRED. The analytical framework (e.g. SWOT, pros/cons, root-cause). */
  framework: Resolvable<AnalyzeInput, string>;
  /** Optional examples of well-structured analyses. */
  examples?: Resolvable<AnalyzeInput, string>;
  systemContext?: Resolvable<AnalyzeInput, string>;
  taskType?: string;
  priority?: LLMPriority;
  /** Default 0.3 — analysis benefits from some perspective variety. */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Reasoning effort hint for o-series / gpt-5-nano / Groq gpt-oss-120b.
   * Applies to every call from this analyzer. (alpha.13+)
   */
  reasoningEffort?: "low" | "medium" | "high";
  onBeforeCall?: (input: AnalyzeInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<z.infer<TSchema>>) => void | Promise<void>;
  onError?: (error: Error, input: AnalyzeInput) => void | Promise<void>;
}

const ROLE = "Analytical system. Evaluate the input through the requested framework. Be specific; avoid hand-waving.";
const GUARDRAILS = "Every claim should be traceable to something in the input. Flag uncertainty explicitly rather than hedging vaguely.";

export function createAnalyzer<TSchema extends z.ZodTypeAny>(
  config: CreateAnalyzerConfig<TSchema>,
): (input: AnalyzeInput) => Promise<z.infer<TSchema>> {
  const taskType = config.taskType ?? "analyze";

  return async (input: AnalyzeInput): Promise<z.infer<TSchema>> => {
    await safelyInvoke(config.onBeforeCall, input);
    try {
      const [framework, examples, context] = await Promise.all([
        resolve(config.framework, input),
        resolve(config.examples, input),
        resolve(config.systemContext, input),
      ]);
      const fullContext = [context, input.contextOverride].filter(Boolean).join("\n\n");
      const system = buildSystemPrompt({
        role: ROLE,
        ...(fullContext ? { context: fullContext } : {}),
        rubric: framework!,
        ...(examples ? { examples } : {}),
        guardrails: GUARDRAILS,
      });
      const userPrompt = input.question
        ? assembleWithQuestion(input.content, input.question)
        : wrapContent(input.content);
      const result = await config.port.generateStructured({
        taskType,
        ...(config.priority !== undefined ? { priority: config.priority } : {}),
        instructions: system,
        prompt: userPrompt,
        schema: config.schema,
        schemaName: config.schemaName,
        temperature: config.temperature ?? 0.3,
        ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
        ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.forceProviderAlias ? { forceProviderAlias: input.forceProviderAlias } : {}),
        ...(input.providerExtras ? { providerExtras: input.providerExtras } : {}),
        ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
      });
      await safelyInvoke(config.onResult, {
        capability: "analyze",
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

function assembleWithQuestion(content: MessageContent, question: string): MessageContent {
  if (typeof content === "string") {
    return `<content>\n${content}\n</content>\n\n<question>\n${question}\n</question>`;
  }
  return [
    { type: "text", text: "<content>" },
    ...content,
    { type: "text", text: `</content>\n\n<question>\n${question}\n</question>` },
  ];
}
