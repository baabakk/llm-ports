/**
 * `@llm-ports/integration-livekit` — route a LiveKit Agents voice agent
 * through an `LLMPort`.
 *
 * ## What this is for
 *
 * LiveKit Agents already abstracts LLM providers: its plugin layer covers
 * many of them behind one `LLM` class. Provider abstraction is therefore
 * **not** what this package adds, and pitching it that way would be
 * offering something the framework already has.
 *
 * What LiveKit's LLM layer does not carry is governance. There is no
 * fallback chain when a provider goes down, no cost ceiling, no
 * per-provider budget, and no task routing. A revoked key is a silent
 * total failure; changing provider to work around one that mishandles
 * tool calls is a code change and a redeploy.
 *
 * All of those are configuration concerns under `@llm-ports`. Swapping
 * the plugin for this class is one constructor, and everything above it
 * (speech recognition, synthesis, turn detection, the agent's own tools)
 * is untouched.
 *
 * ```ts
 * import { LlmPortsLLM } from "@llm-ports/integration-livekit";
 *
 * const session = new voice.AgentSession({
 *   vad, stt, tts, turnDetection,
 *   llm: new LlmPortsLLM({ port: llm, taskType: "voice_coach" }),
 * });
 * ```
 *
 * ## Why this is an "integration" and not an "adapter"
 *
 * Every `@llm-ports/adapter-*` package points **outward**: from the port
 * to a provider. This points **inward**: from a framework into the port.
 * Reusing the word "adapter" would invert its established meaning in this
 * codebase and mislead every reader, so inbound packages take the
 * `integration-` prefix. Expect siblings.
 *
 * ## The loop stays with LiveKit
 *
 * This calls `LLMPort.streamChat`, which surfaces tool calls without
 * executing them. LiveKit's `AgentSession` owns the tool-use loop and
 * runs each tool's handler itself, which is exactly what its `chat()`
 * contract expects. Nothing here ever invokes a tool.
 */

import { llm as lkLlm } from "@livekit/agents";
import type {
  ChatStreamEvent,
  LLMMessage,
  LLMPort,
  StreamChatOptions,
  ToolDefinition,
} from "@llm-ports/core";

/** Options for {@link LlmPortsLLM}. */
export interface LlmPortsLLMOptions {
  /**
   * The port to route through. Normally `registry.getPort()`, so the
   * agent inherits whatever routing, fallback, and budget gating that
   * Registry is configured with.
   */
  port: LLMPort;

  /**
   * Task type used for routing. This is the knob that makes provider
   * choice configuration rather than code: point it at a route whose
   * chain you control in the environment, and swapping providers stops
   * requiring a redeploy.
   */
  taskType: string;

  /**
   * Per-attempt timeout in milliseconds.
   *
   * **Set this for realtime.** The library's default is tuned for batch
   * work and is far longer than a conversation can absorb: production
   * voice pipelines run around 680ms median end to end, including speech
   * recognition and synthesis, so an attempt that can run for tens of
   * seconds is indistinguishable from a hang. Something in the low
   * thousands of milliseconds keeps a failover inside a budget a listener
   * will tolerate.
   */
  perAttemptTimeoutMs?: number;

  /** Reported by LiveKit as the plugin label. */
  label?: string;

  /** Forwarded to the port on every call. */
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * A LiveKit `LLM` implementation backed by an `LLMPort`.
 */
export class LlmPortsLLM extends lkLlm.LLM {
  readonly #options: LlmPortsLLMOptions;

  constructor(options: LlmPortsLLMOptions) {
    super();
    this.#options = options;
  }

  label(): string {
    return this.#options.label ?? "llm-ports";
  }

  override get model(): string {
    // The concrete model is chosen per call by the Registry's routing and
    // may differ between calls when a chain walks, so the honest answer
    // here is the route rather than a fixed model id.
    return `route:${this.#options.taskType}`;
  }

  override get provider(): string {
    return "llm-ports";
  }

  chat({
    chatCtx,
    toolCtx,
    toolChoice,
  }: {
    chatCtx: lkLlm.ChatContext;
    toolCtx?: unknown;
    connOptions?: unknown;
    parallelToolCalls?: boolean;
    toolChoice?: unknown;
    extraKwargs?: Record<string, unknown>;
  }): lkLlm.LLMStream {
    return new LlmPortsLLMStream(this, {
      chatCtx,
      toolCtx: toolCtx as never,
      options: this.#options,
      toolChoice: normalizeToolChoice(toolChoice),
    });
  }
}

/**
 * The stream LiveKit iterates. Pulls from `streamChat` and republishes
 * each event as a `ChatChunk`.
 */
class LlmPortsLLMStream extends lkLlm.LLMStream {
  readonly #options: LlmPortsLLMOptions;
  readonly #toolChoice: StreamChatOptions["toolChoice"];
  #chunkSeq = 0;

  constructor(
    parent: lkLlm.LLM,
    args: {
      chatCtx: lkLlm.ChatContext;
      toolCtx?: never;
      options: LlmPortsLLMOptions;
      toolChoice: StreamChatOptions["toolChoice"];
    },
  ) {
    super(parent, {
      chatCtx: args.chatCtx,
      ...(args.toolCtx !== undefined ? { toolCtx: args.toolCtx } : {}),
      connOptions: {} as never,
    });
    this.#options = args.options;
    this.#toolChoice = args.toolChoice;
  }

  protected async run(): Promise<void> {
    const { port, taskType } = this.#options;
    if (typeof port.streamChat !== "function") {
      throw new Error(
        "@llm-ports/integration-livekit: the supplied port does not implement streamChat. " +
          "That method is optional on LLMPort and arrived in alpha.32; upgrade @llm-ports/core " +
          "and ensure the providers in this task's chain use an adapter that implements it.",
      );
    }

    const options: StreamChatOptions = {
      taskType,
      messages: chatContextToMessages(this.chatCtx),
      // The framework's tool definitions, converted per call. Each
      // provider attempt converts these itself, so a fallback provider is
      // never handed a schema dialect prepared for the one that failed.
      ...(toolContextToTools(this.toolCtx) ?? {}),
      ...(this.#toolChoice ? { toolChoice: this.#toolChoice } : {}),
      ...(this.#options.temperature !== undefined
        ? { temperature: this.#options.temperature }
        : {}),
      ...(this.#options.maxOutputTokens !== undefined
        ? { maxOutputTokens: this.#options.maxOutputTokens }
        : {}),
      ...(this.#options.perAttemptTimeoutMs !== undefined
        ? { perAttemptTimeoutMs: this.#options.perAttemptTimeoutMs }
        : {}),
      // Barge-in. LiveKit aborts the stream when the speaker interrupts,
      // and this is what carries that all the way to the provider's
      // in-flight HTTP request rather than merely stopping iteration.
      signal: this.abortController.signal,
    };

    for await (const event of port.streamChat(options)) {
      const chunk = toChatChunk(event, () => `llm-ports-${++this.#chunkSeq}`);
      if (chunk) this.queue.put(chunk);
      // A terminal error event is raised rather than published, so
      // LiveKit's own error handling sees a rejection from `run` exactly
      // as it would from any other plugin.
      if (event.type === "error") throw event.error;
    }
  }
}

// ─── Mapping ────────────────────────────────────────────────────────

/**
 * Flatten a LiveKit chat context into port messages.
 *
 * Only `message` items carry conversational text. Tool calls and their
 * outputs are represented in the context as their own item types, and
 * LiveKit replays them to the model itself on the following turn, so
 * forwarding them here would duplicate them.
 */
export function chatContextToMessages(chatCtx: lkLlm.ChatContext): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const item of chatCtx.items) {
    if ((item as { type?: string }).type !== "message") continue;
    const message = item as { role: string; content: unknown[] };
    const text = message.content
      .map((part) => (typeof part === "string" ? part : ""))
      .join("")
      .trim();
    if (text === "") continue;
    out.push({
      role: normalizeRole(message.role),
      content: text,
    });
  }
  return out;
}

/**
 * Convert LiveKit's tool context into port tool definitions.
 *
 * Returns an object suitable for spreading, so "no tools" spreads to
 * nothing rather than setting `tools: {}`, which some providers treat
 * differently from omitting the field.
 *
 * The `execute` handler is deliberately a thrower. LiveKit runs its own
 * tool handlers; if one were ever called through here it would mean the
 * loop had moved somewhere it should not be, and failing loudly is
 * better than silently running a duplicate.
 */
export function toolContextToTools(
  toolCtx: unknown,
): { tools: Record<string, ToolDefinition> } | undefined {
  if (!toolCtx || typeof toolCtx !== "object") return undefined;
  const entries = Object.entries(toolCtx as Record<string, unknown>);
  if (entries.length === 0) return undefined;

  const tools: Record<string, ToolDefinition> = {};
  for (const [name, raw] of entries) {
    const def = raw as { description?: string; parameters?: unknown; schema?: unknown };
    tools[name] = {
      name,
      description: def.description ?? "",
      inputSchema: (def.parameters ?? def.schema) as never,
      execute: async () => {
        throw new Error(
          `@llm-ports/integration-livekit: tool "${name}" was executed through the port. ` +
            "LiveKit owns the tool-use loop and runs its own handlers; streamChat only surfaces " +
            "calls. Reaching this means the loop moved somewhere it should not be.",
        );
      },
    };
  }
  return { tools };
}

/**
 * Map one port event onto a LiveKit chunk. Returns undefined for events
 * with no LiveKit equivalent, which are dropped rather than forced into
 * a shape that would mislead the framework.
 */
export function toChatChunk(
  event: ChatStreamEvent,
  nextId: () => string,
): lkLlm.ChatChunk | undefined {
  switch (event.type) {
    case "text-delta":
      return {
        id: nextId(),
        delta: { role: "assistant", content: event.text },
      };

    case "tool-call":
      return {
        id: nextId(),
        delta: {
          role: "assistant",
          toolCalls: [
            {
              // LiveKit's FunctionCall keeps arguments as the raw string
              // and parses them itself, so the raw text is forwarded
              // rather than the parsed object.
              id: event.toolCallId,
              callId: event.toolCallId,
              name: event.toolName,
              args: event.rawArguments,
              type: "function_call",
            } as never,
          ],
        },
      };

    case "finish":
      return {
        id: nextId(),
        usage: {
          promptTokens: event.usage.inputTokens,
          completionTokens: event.usage.outputTokens,
          totalTokens: event.usage.totalTokens,
          promptCachedTokens: 0,
        },
      };

    // `step-finish` has no LiveKit equivalent: the framework infers turn
    // boundaries from the stream ending. `error` is raised by the caller
    // rather than published, so LiveKit sees a rejection.
    case "step-finish":
    case "error":
      return undefined;
  }
}

function normalizeRole(role: string): LLMMessage["role"] {
  return role === "assistant" || role === "system" || role === "user"
    ? (role as LLMMessage["role"])
    : "user";
}

function normalizeToolChoice(raw: unknown): StreamChatOptions["toolChoice"] {
  return raw === "required" || raw === "none" || raw === "auto" ? raw : undefined;
}
