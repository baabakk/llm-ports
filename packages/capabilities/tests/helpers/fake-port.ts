/**
 * A controllable fake LLMPort for testing capability factories without
 * involving any real adapter. Tests inject canned responses and assert
 * against the typed result.
 */

import type {
  AgentResult,
  CostUsage,
  GenerateStructuredOptions,
  GenerateStructuredResult,
  GenerateTextOptions,
  GenerateTextResult,
  LLMPort,
  RunAgentOptions,
  StreamStructuredOptions,
  StreamTextOptions,
  TokenUsage,
} from "@llm-ports/core";

export interface RecordedCall {
  method: "generateText" | "generateStructured" | "streamText" | "streamStructured" | "runAgent";
  options: unknown;
}

export interface FakePortControl {
  port: LLMPort;
  /** Queue a generateText response. */
  enqueueText(text: string, opts?: { usage?: Partial<TokenUsage>; modelId?: string; cost?: Partial<CostUsage> }): void;
  /** Queue a generateStructured response (the data must satisfy the caller's schema). */
  enqueueStructured(data: unknown, opts?: { usage?: Partial<TokenUsage>; modelId?: string; cost?: Partial<CostUsage> }): void;
  /** Queue a network-style error. */
  enqueueError(err: Error): void;
  /** All calls made on the port, in order. */
  calls: RecordedCall[];
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 100, outputTokens: 30, totalTokens: 130 };
const DEFAULT_COST: CostUsage = { inputUSD: 0.0003, outputUSD: 0.0009, totalUSD: 0.0012 };

export function createFakePort(alias = "fake-alias", modelId = "fake-model"): FakePortControl {
  const queue: Array<{ kind: "text" | "structured" | "error"; payload: unknown; usage?: Partial<TokenUsage>; modelId?: string; cost?: Partial<CostUsage> }> = [];
  const calls: RecordedCall[] = [];

  function nextOrThrow(): { kind: "text" | "structured" | "error"; payload: unknown; usage?: Partial<TokenUsage>; modelId?: string; cost?: Partial<CostUsage> } {
    const next = queue.shift();
    if (!next) throw new Error("FakePort: response queue is empty");
    return next;
  }

  function buildCost(partial?: Partial<CostUsage>): CostUsage {
    if (!partial) return DEFAULT_COST;
    return {
      inputUSD: partial.inputUSD ?? DEFAULT_COST.inputUSD,
      outputUSD: partial.outputUSD ?? DEFAULT_COST.outputUSD,
      totalUSD: partial.totalUSD ?? DEFAULT_COST.totalUSD,
      ...(partial.cacheSavingsUSD !== undefined ? { cacheSavingsUSD: partial.cacheSavingsUSD } : {}),
    };
  }

  function buildUsage(partial?: Partial<TokenUsage>): TokenUsage {
    if (!partial) return DEFAULT_USAGE;
    const inputTokens = partial.inputTokens ?? DEFAULT_USAGE.inputTokens;
    const outputTokens = partial.outputTokens ?? DEFAULT_USAGE.outputTokens;
    return {
      inputTokens,
      outputTokens,
      totalTokens: partial.totalTokens ?? inputTokens + outputTokens,
      ...(partial.cacheReadTokens !== undefined ? { cacheReadTokens: partial.cacheReadTokens } : {}),
      ...(partial.cacheWriteTokens !== undefined ? { cacheWriteTokens: partial.cacheWriteTokens } : {}),
    };
  }

  const port: LLMPort = {
    async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
      calls.push({ method: "generateText", options });
      const next = nextOrThrow();
      if (next.kind === "error") throw next.payload as Error;
      if (next.kind !== "text") {
        throw new Error(`FakePort: queued response kind=${next.kind} but generateText was called`);
      }
      const usage = buildUsage(next.usage);
      return {
        text: next.payload as string,
        usage,
        cost: buildCost(next.cost),
        modelId: next.modelId ?? modelId,
        providerAlias: alias,
        latencyMs: 1,
      };
    },

    async generateStructured<T>(
      options: GenerateStructuredOptions<T>,
    ): Promise<GenerateStructuredResult<T>> {
      calls.push({ method: "generateStructured", options });
      const next = nextOrThrow();
      if (next.kind === "error") throw next.payload as Error;
      if (next.kind !== "structured") {
        throw new Error(`FakePort: queued response kind=${next.kind} but generateStructured was called`);
      }
      const usage = buildUsage(next.usage);
      // Validate against the caller's schema so we surface mismatches early.
      const parsed = options.schema.safeParse(next.payload);
      if (!parsed.success) {
        throw new Error(`FakePort: queued data did not match caller schema: ${parsed.error.message}`);
      }
      return {
        data: parsed.data as T,
        usage,
        cost: buildCost(next.cost),
        modelId: next.modelId ?? modelId,
        providerAlias: alias,
        latencyMs: 1,
        validationAttempts: 1,
      };
    },

    async *streamText(options: StreamTextOptions): AsyncIterable<string> {
      calls.push({ method: "streamText", options });
      const next = nextOrThrow();
      if (next.kind === "error") throw next.payload as Error;
      const text = next.payload as string;
      yield text;
    },

    async *streamStructured<T>(options: StreamStructuredOptions<T>): AsyncIterable<Partial<T>> {
      calls.push({ method: "streamStructured", options });
      const next = nextOrThrow();
      if (next.kind === "error") throw next.payload as Error;
      yield next.payload as Partial<T>;
    },

    async runAgent(options: RunAgentOptions): Promise<AgentResult> {
      calls.push({ method: "runAgent", options });
      const next = nextOrThrow();
      if (next.kind === "error") throw next.payload as Error;
      const usage = buildUsage(next.usage);
      return {
        text: next.payload as string,
        messages: options.messages,
        toolCalls: [],
        usage,
        cost: buildCost(next.cost),
        modelId: next.modelId ?? modelId,
        providerAlias: alias,
        latencyMs: 1,
        stepsTaken: 1,
        terminationReason: "completed",
      };
    },
  };

  return {
    port,
    enqueueText(text, opts) {
      queue.push({
        kind: "text",
        payload: text,
        ...(opts?.usage ? { usage: opts.usage } : {}),
        ...(opts?.modelId ? { modelId: opts.modelId } : {}),
        ...(opts?.cost ? { cost: opts.cost } : {}),
      });
    },
    enqueueStructured(data, opts) {
      queue.push({
        kind: "structured",
        payload: data,
        ...(opts?.usage ? { usage: opts.usage } : {}),
        ...(opts?.modelId ? { modelId: opts.modelId } : {}),
        ...(opts?.cost ? { cost: opts.cost } : {}),
      });
    },
    enqueueError(err) {
      queue.push({ kind: "error", payload: err });
    },
    calls,
  };
}
