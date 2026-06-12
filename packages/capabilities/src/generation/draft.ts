/**
 * createDrafter — generate new text in a specific persona/style.
 *
 * Returns plain text. The persona is the most important configuration: it
 * tells the model who is "writing." Channel constraints (e.g. SMS = 160
 * chars, email = 150-250 words) help the model size its output.
 */

import type { CacheControl, LLMPort, LLMPriority, MessageContent } from "@llm-ports/core";
import {
  buildSystemPrompt,
  resolve,
  safelyInvoke,
  type CapabilityEvent,
  type Resolvable,
} from "../shared.js";

export interface DraftInput {
  /** Instruction for what to write (the user-facing intent). */
  instructions: string;
  /** Optional thread/conversation history the draft is responding to. */
  threadHistory?: MessageContent;
  /** Optional recipient context (e.g. CRM data, prior interactions). */
  recipientContext?: string;
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

export interface CreateDrafterConfig {
  port: LLMPort;
  /** Operation name used in logs. Default: "draft". */
  schemaName?: string;
  /** REQUIRED. The persona/voice the draft should adopt. Often a tone profile. */
  persona: Resolvable<DraftInput, string>;
  /** Optional channel constraint (e.g. SMS, email, LinkedIn DM). */
  channelConstraint?: Resolvable<DraftInput, string>;
  /** Optional anti-pattern blacklist (phrases to avoid). */
  antiPatterns?: Resolvable<DraftInput, string>;
  /** Optional examples of correctly-styled drafts. */
  writingSamples?: Resolvable<DraftInput, string>;
  systemContext?: Resolvable<DraftInput, string>;
  taskType?: string;
  priority?: LLMPriority;
  /** Default 0.4 (creative but controlled). */
  temperature?: number;
  /** Hard character cap; truncates output if exceeded. */
  maxLength?: number;
  maxOutputTokens?: number;
  /**
   * Reasoning effort hint for o-series / gpt-5-nano / Groq gpt-oss-120b.
   * Applies to every call from this drafter. (alpha.13+)
   */
  reasoningEffort?: "low" | "medium" | "high";
  onBeforeCall?: (input: DraftInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<string>) => void | Promise<void>;
  onError?: (error: Error, input: DraftInput) => void | Promise<void>;
}

export function createDrafter(
  config: CreateDrafterConfig,
): (input: DraftInput) => Promise<string> {
  const taskType = config.taskType ?? "draft";
  const schemaName = config.schemaName ?? "draft";

  return async (input: DraftInput): Promise<string> => {
    await safelyInvoke(config.onBeforeCall, input);
    try {
      const [persona, channel, antiPatterns, samples, context] = await Promise.all([
        resolve(config.persona, input),
        resolve(config.channelConstraint, input),
        resolve(config.antiPatterns, input),
        resolve(config.writingSamples, input),
        resolve(config.systemContext, input),
      ]);
      const fullContext = [
        context,
        input.contextOverride,
        input.recipientContext ? `Recipient:\n${input.recipientContext}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");

      const guardrailParts: string[] = [];
      if (channel) guardrailParts.push(`Channel rules: ${channel}`);
      if (antiPatterns) guardrailParts.push(`Avoid these phrases:\n${antiPatterns}`);
      if (config.maxLength !== undefined) {
        guardrailParts.push(`Maximum length: ${config.maxLength} characters.`);
      }
      guardrailParts.push("Output only the message text. No subject line, no commentary, no preamble.");

      const system = buildSystemPrompt({
        role: persona!,
        ...(fullContext ? { context: fullContext } : {}),
        ...(samples ? { examples: samples } : {}),
        guardrails: guardrailParts.join("\n\n"),
      });

      const userPrompt = input.threadHistory
        ? assemblePromptWithThread(input.threadHistory, input.instructions)
        : input.instructions;

      const result = await config.port.generateText({
        taskType,
        ...(config.priority !== undefined ? { priority: config.priority } : {}),
        instructions: system,
        prompt: userPrompt,
        temperature: config.temperature ?? 0.4,
        ...(config.maxOutputTokens !== undefined
          ? { maxOutputTokens: config.maxOutputTokens }
          : config.maxLength !== undefined
            ? { maxOutputTokens: Math.ceil(config.maxLength / 3) }
            : { maxOutputTokens: 800 }),
        ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.forceProviderAlias ? { forceProviderAlias: input.forceProviderAlias } : {}),
        ...(input.providerExtras ? { providerExtras: input.providerExtras } : {}),
        ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
      });

      let text = result.text;
      if (config.maxLength !== undefined && text.length > config.maxLength) {
        text = text.slice(0, config.maxLength).trimEnd();
      }

      await safelyInvoke(config.onResult, {
        capability: "draft",
        schemaName,
        modelId: result.modelId,
        providerAlias: result.providerAlias,
        usage: result.usage,
        cost: result.cost,
        latencyMs: result.latencyMs,
        output: text,
      });
      return text;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await safelyInvoke(config.onError, error, input);
      throw error;
    }
  };
}

function assemblePromptWithThread(thread: MessageContent, instructions: string): MessageContent {
  if (typeof thread === "string") {
    return `<thread>\n${thread}\n</thread>\n\n${instructions}`;
  }
  return [
    { type: "text", text: "<thread>" },
    ...thread,
    { type: "text", text: "</thread>\n\n" + instructions },
  ];
}
