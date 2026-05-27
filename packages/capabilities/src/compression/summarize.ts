/**
 * createSummarizer — compress input text while preserving the key meaning.
 *
 * Returns plain text. For structured summaries (e.g. bullet points + an
 * explicit list of action items), use createExtractor with a schema instead.
 */

import type { LLMPort, LLMPriority, MessageContent } from "@llm-ports/core";
import {
  buildSystemPrompt,
  resolve,
  safelyInvoke,
  wrapContent,
  type CapabilityEvent,
  type Resolvable,
} from "../shared.js";

export interface SummarizeInput {
  content: MessageContent;
  contextOverride?: string;
  /** Cancellation signal for this specific call. Threaded to the port. (alpha.13+) */
  signal?: AbortSignal;
  /** Override task routing for this call only. (alpha.13+) */
  forceProviderAlias?: string;
}

export interface CreateSummarizerConfig {
  port: LLMPort;
  /** Operation name used in logs. Default: "summarize". */
  schemaName?: string;
  /** Optional persona / focus instructions. */
  persona?: Resolvable<SummarizeInput, string>;
  /** Optional output style guide (e.g. "3-5 bullets, active voice"). */
  styleGuide?: Resolvable<SummarizeInput, string>;
  systemContext?: Resolvable<SummarizeInput, string>;
  /** Approximate target length in words. */
  targetWords?: number;
  taskType?: string;
  priority?: LLMPriority;
  /** Default 0.2. */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Reasoning effort hint for o-series / gpt-5-nano / Groq gpt-oss-120b.
   * Applies to every call from this summarizer. (alpha.13+)
   */
  reasoningEffort?: "low" | "medium" | "high";
  onBeforeCall?: (input: SummarizeInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<string>) => void | Promise<void>;
  onError?: (error: Error, input: SummarizeInput) => void | Promise<void>;
}

const ROLE_DEFAULT = "Summarization system. Compress the input while preserving the most important facts and intent.";

export function createSummarizer(
  config: CreateSummarizerConfig,
): (input: SummarizeInput) => Promise<string> {
  const taskType = config.taskType ?? "summarize";
  const schemaName = config.schemaName ?? "summary";

  return async (input: SummarizeInput): Promise<string> => {
    await safelyInvoke(config.onBeforeCall, input);
    try {
      const [persona, styleGuide, context] = await Promise.all([
        resolve(config.persona, input),
        resolve(config.styleGuide, input),
        resolve(config.systemContext, input),
      ]);
      const fullContext = [context, input.contextOverride].filter(Boolean).join("\n\n");
      const guardrails: string[] = [];
      if (config.targetWords !== undefined) {
        guardrails.push(`Target length: about ${config.targetWords} words.`);
      }
      guardrails.push("Do not include opinions or speculation. Stick to what the input says.");
      const system = buildSystemPrompt({
        role: persona ?? ROLE_DEFAULT,
        ...(fullContext ? { context: fullContext } : {}),
        ...(styleGuide ? { rubric: styleGuide } : {}),
        guardrails: guardrails.join(" "),
      });
      const result = await config.port.generateText({
        taskType,
        ...(config.priority !== undefined ? { priority: config.priority } : {}),
        instructions: system,
        prompt: wrapContent(input.content),
        temperature: config.temperature ?? 0.2,
        ...(config.maxOutputTokens !== undefined
          ? { maxOutputTokens: config.maxOutputTokens }
          : config.targetWords !== undefined
            ? { maxOutputTokens: Math.ceil(config.targetWords * 1.5) }
            : {}),
        ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.forceProviderAlias ? { forceProviderAlias: input.forceProviderAlias } : {}),
      });
      await safelyInvoke(config.onResult, {
        capability: "summarize",
        schemaName,
        modelId: result.modelId,
        providerAlias: result.providerAlias,
        usage: result.usage,
        cost: result.cost,
        latencyMs: result.latencyMs,
        output: result.text,
      });
      return result.text;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await safelyInvoke(config.onError, error, input);
      throw error;
    }
  };
}
