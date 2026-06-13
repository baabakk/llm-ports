/**
 * Session-scoped cost gating.
 *
 * Wraps an LLMPort with session-level ceilings independent of the per-provider
 * windowed gates. Designed for continuous-call workloads (screen capture, OCR
 * loops, multi-step agents) where a single stuck-open session can burn
 * arbitrary dollars / tokens / tool calls.
 *
 * Usage:
 *
 *   const session = registry.openCostSession({ budgetUSD: 0.50 });
 *   const llm = session.getPort();
 *   try {
 *     for (const frame of screenCaptureFrames) {
 *       await llm.generateText({ taskType: "screen_analyze", prompt: [...] });
 *     }
 *   } finally {
 *     console.log("session spent:", session.totalSpentUSD());
 *     session.close();
 *   }
 *
 * Throws `SessionBudgetExceededError` mid-loop when a cap is reached. The
 * per-provider windowed gates still apply on top — session ceilings are a
 * hard backstop, not a replacement.
 *
 * alpha.20 additions:
 *   - tokensUsed() / toolCallsMade() / requestsMade() helpers.
 *   - Optional `maxTokens`, `maxToolCalls`, `maxRequests` ceilings that mirror
 *     the env-driven `total_tokens:N/session`, `tool_calls:N/session`, and
 *     `req:N/session` gating tokens. The error thrown is still
 *     `SessionBudgetExceededError` so existing catch-blocks keep working;
 *     the `reason` field distinguishes which cap tripped.
 */

import type {
  AgentResult,
  GenerateStructuredOptions,
  GenerateStructuredResult,
  GenerateTextOptions,
  GenerateTextResult,
  LLMPort,
  RunAgentOptions,
  StreamStructuredOptions,
  StreamTextOptions,
} from "../ports/llm-port.js";
import { SessionBudgetExceededError } from "../errors.js";

export interface OpenCostSessionOptions {
  /** Hard USD cap for this session. Required. */
  budgetUSD: number;
  /**
   * Optional client-supplied session ID. If omitted, a timestamp-keyed id
   * is generated. The ID appears in `SessionBudgetExceededError.sessionId`
   * and is useful for log correlation across multi-step flows.
   */
  sessionId?: string;
  /**
   * Optional ceiling on total tokens used in this session (input + output,
   * across every call). Maps to the `total_tokens:N/session` env gating
   * token. Tripping this throws `SessionBudgetExceededError`. (alpha.20+)
   */
  maxTokens?: number;
  /**
   * Optional ceiling on tool / function calls made by `runAgent` in this
   * session. Maps to the `tool_calls:N/session` env gating token. Tripping
   * this throws `SessionBudgetExceededError`. (alpha.20+)
   */
  maxToolCalls?: number;
  /**
   * Optional ceiling on requests made in this session (every call counts,
   * including streaming). Maps to the `req:N/session` env gating token.
   * Tripping this throws `SessionBudgetExceededError`. (alpha.20+)
   */
  maxRequests?: number;
}

/**
 * Handle returned by `Registry.openCostSession`.
 */
export class CostSession {
  public readonly id: string;
  public readonly budgetUSD: number;
  public readonly maxTokens?: number;
  public readonly maxToolCalls?: number;
  public readonly maxRequests?: number;
  private spentUSD = 0;
  private tokens = 0;
  private toolCalls = 0;
  private requests = 0;
  private closed = false;

  constructor(
    private readonly underlying: LLMPort,
    opts: OpenCostSessionOptions,
  ) {
    if (!Number.isFinite(opts.budgetUSD) || opts.budgetUSD <= 0) {
      throw new Error(
        `CostSession requires a positive finite budgetUSD; got ${opts.budgetUSD}`,
      );
    }
    this.budgetUSD = opts.budgetUSD;
    this.id = opts.sessionId ?? `cs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (opts.maxTokens !== undefined) this.maxTokens = opts.maxTokens;
    if (opts.maxToolCalls !== undefined) this.maxToolCalls = opts.maxToolCalls;
    if (opts.maxRequests !== undefined) this.maxRequests = opts.maxRequests;
  }

  totalSpentUSD(): number {
    return this.spentUSD;
  }

  remainingUSD(): number {
    return Math.max(0, this.budgetUSD - this.spentUSD);
  }

  /** Total tokens billed (input + output) across all calls. (alpha.20+) */
  tokensUsed(): number {
    return this.tokens;
  }

  /** Tool / function calls made by runAgent across the session. (alpha.20+) */
  toolCallsMade(): number {
    return this.toolCalls;
  }

  /** Total port calls made in this session. (alpha.20+) */
  requestsMade(): number {
    return this.requests;
  }

  /**
   * Returns an LLMPort proxy that tracks every call's cost / tokens / tool
   * calls / request count against this session. Before invoking the
   * underlying port, the proxy checks every ceiling; the first one that
   * would be exceeded throws `SessionBudgetExceededError`.
   */
  getPort(): LLMPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const session = this;
    const ensureOpen = (): void => {
      if (session.closed) {
        throw new Error(
          `CostSession "${session.id}" is closed; cannot make further calls.`,
        );
      }
    };
    const checkBefore = (): void => {
      ensureOpen();
      if (session.spentUSD >= session.budgetUSD) {
        throw new SessionBudgetExceededError(
          session.id,
          session.budgetUSD,
          session.spentUSD,
        );
      }
      if (session.maxTokens !== undefined && session.tokens >= session.maxTokens) {
        throw new SessionBudgetExceededError(
          session.id,
          session.maxTokens,
          session.tokens,
          `tokens (${session.tokens} >= ${session.maxTokens})`,
        );
      }
      if (
        session.maxToolCalls !== undefined &&
        session.toolCalls >= session.maxToolCalls
      ) {
        throw new SessionBudgetExceededError(
          session.id,
          session.maxToolCalls,
          session.toolCalls,
          `tool_calls (${session.toolCalls} >= ${session.maxToolCalls})`,
        );
      }
      if (
        session.maxRequests !== undefined &&
        session.requests >= session.maxRequests
      ) {
        throw new SessionBudgetExceededError(
          session.id,
          session.maxRequests,
          session.requests,
          `requests (${session.requests} >= ${session.maxRequests})`,
        );
      }
    };
    const recordResult = (
      cost: { totalUSD: number },
      usage?: { totalTokens?: number },
      toolCalls?: number,
    ): void => {
      session.spentUSD += cost.totalUSD;
      session.requests += 1;
      if (usage?.totalTokens !== undefined) session.tokens += usage.totalTokens;
      if (toolCalls !== undefined) session.toolCalls += toolCalls;
    };

    return {
      async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
        checkBefore();
        const result = await session.underlying.generateText(options);
        recordResult(result.cost, result.usage);
        return result;
      },
      async generateStructured<T>(
        options: GenerateStructuredOptions<T>,
      ): Promise<GenerateStructuredResult<T>> {
        checkBefore();
        const result = await session.underlying.generateStructured(options);
        recordResult(result.cost, result.usage);
        return result;
      },
      async *streamText(options: StreamTextOptions): AsyncIterable<string> {
        checkBefore();
        // Streaming doesn't return aggregated cost/usage; the request counts
        // toward perRequest gates but tokens / cost can't update mid-stream.
        session.requests += 1;
        yield* session.underlying.streamText(options);
      },
      async *streamStructured<T>(
        options: StreamStructuredOptions<T>,
      ): AsyncIterable<Partial<T>> {
        checkBefore();
        session.requests += 1;
        yield* session.underlying.streamStructured(options);
      },
      async runAgent(options: RunAgentOptions): Promise<AgentResult> {
        checkBefore();
        const result = await session.underlying.runAgent(options);
        recordResult(result.cost, result.usage, result.toolCalls.length);
        return result;
      },
    };
  }

  /**
   * Close the session. After `close()`, calls through any port previously
   * returned by `getPort()` throw an error.
   *
   * Returns the total USD spent during the session — useful for logging
   * or charging back to a tenant.
   */
  close(): number {
    this.closed = true;
    return this.spentUSD;
  }
}
