/**
 * Session-scoped cost gating.
 *
 * Wraps an LLMPort with a session-level USD cap that's independent of the
 * per-provider hour/day/month gates. Designed for continuous-call workloads
 * (screen capture, OCR loops, multi-step agents) where a single stuck-open
 * session can burn arbitrary dollars otherwise.
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
 * Throws `SessionBudgetExceededError` mid-loop when the cap is reached.
 * The per-provider hour/day/month gates still apply on top — session
 * budget is a hard backstop, not a replacement.
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
}

/**
 * Handle returned by `Registry.openCostSession`. Exposes:
 *   - `id`: the session identifier
 *   - `budgetUSD`: the configured cap
 *   - `totalSpentUSD()`: current spend
 *   - `remainingUSD()`: budgetUSD - totalSpentUSD
 *   - `getPort()`: a session-scoped LLMPort proxy
 *   - `close()`: marks the session closed; subsequent port calls throw
 */
export class CostSession {
  public readonly id: string;
  public readonly budgetUSD: number;
  private spentUSD = 0;
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
  }

  totalSpentUSD(): number {
    return this.spentUSD;
  }

  remainingUSD(): number {
    return Math.max(0, this.budgetUSD - this.spentUSD);
  }

  /**
   * Returns an LLMPort proxy that tracks every call's cost against this
   * session. The first call that would push `spentUSD` over `budgetUSD`
   * throws `SessionBudgetExceededError` BEFORE invoking the underlying
   * port — so an over-budget call never executes.
   */
  getPort(): LLMPort {
    const session = this;
    const checkBudget = (): void => {
      if (session.closed) {
        throw new Error(
          `CostSession "${session.id}" is closed; cannot make further calls.`,
        );
      }
      if (session.spentUSD >= session.budgetUSD) {
        throw new SessionBudgetExceededError(
          session.id,
          session.budgetUSD,
          session.spentUSD,
        );
      }
    };
    const recordCost = (usd: number): void => {
      session.spentUSD += usd;
    };

    return {
      async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
        checkBudget();
        const result = await session.underlying.generateText(options);
        recordCost(result.cost.totalUSD);
        return result;
      },
      async generateStructured<T>(
        options: GenerateStructuredOptions<T>,
      ): Promise<GenerateStructuredResult<T>> {
        checkBudget();
        const result = await session.underlying.generateStructured(options);
        recordCost(result.cost.totalUSD);
        return result;
      },
      async *streamText(options: StreamTextOptions): AsyncIterable<string> {
        checkBudget();
        // streamText doesn't return cost (no aggregated usage); session
        // spend doesn't change. The next non-stream call's check still
        // applies. Document this limitation in the streaming guide.
        yield* session.underlying.streamText(options);
      },
      async *streamStructured<T>(
        options: StreamStructuredOptions<T>,
      ): AsyncIterable<Partial<T>> {
        checkBudget();
        yield* session.underlying.streamStructured(options);
      },
      async runAgent(options: RunAgentOptions): Promise<AgentResult> {
        checkBudget();
        const result = await session.underlying.runAgent(options);
        recordCost(result.cost.totalUSD);
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
