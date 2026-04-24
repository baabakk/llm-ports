/**
 * createExtractor — pull structured fields from unstructured input.
 *
 * Returns Zod-validated typed data. Useful for: parsing emails for action
 * items, extracting contact info from text, structured data from documents.
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

export interface ExtractInput {
  content: MessageContent;
  contextOverride?: string;
}

export interface CreateExtractorConfig<TSchema extends z.ZodTypeAny> {
  port: LLMPort;
  schema: TSchema;
  schemaName: string;
  /** What to extract (instructions describing each field). */
  fieldGuide?: Resolvable<ExtractInput, string>;
  /** Examples of input -> extracted output. */
  examples?: Resolvable<ExtractInput, string>;
  systemContext?: Resolvable<ExtractInput, string>;
  taskType?: string;
  priority?: LLMPriority;
  /** Default 0 (deterministic). */
  temperature?: number;
  maxOutputTokens?: number;
  onBeforeCall?: (input: ExtractInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<z.infer<TSchema>>) => void | Promise<void>;
  onError?: (error: Error, input: ExtractInput) => void | Promise<void>;
}

const ROLE = "Extraction system. Pull the requested fields from the input. Use only what is supported by the input itself.";
const GUARDRAILS = "Do not infer fields that aren't in the input. Use null/empty for missing data rather than guessing.";

export function createExtractor<TSchema extends z.ZodTypeAny>(
  config: CreateExtractorConfig<TSchema>,
): (input: ExtractInput) => Promise<z.infer<TSchema>> {
  const taskType = config.taskType ?? "extract";

  return async (input: ExtractInput): Promise<z.infer<TSchema>> => {
    await safelyInvoke(config.onBeforeCall, input);
    try {
      const [fieldGuide, examples, context] = await Promise.all([
        resolve(config.fieldGuide, input),
        resolve(config.examples, input),
        resolve(config.systemContext, input),
      ]);
      const fullContext = [context, input.contextOverride].filter(Boolean).join("\n\n");
      const system = buildSystemPrompt({
        role: ROLE,
        ...(fullContext ? { context: fullContext } : {}),
        ...(fieldGuide ? { rubric: fieldGuide } : {}),
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
        temperature: config.temperature ?? 0,
        ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
      });
      await safelyInvoke(config.onResult, {
        capability: "extract",
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
