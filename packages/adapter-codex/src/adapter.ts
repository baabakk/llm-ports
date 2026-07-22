/**
 * OpenAI Codex CLI adapter implementation.
 *
 * Runs `codex exec --json` as a subprocess, streams its JSON event
 * lines, and returns a runAgent result. Emits contract lifecycle
 * events via a caller-supplied ObservabilitySink so the port surface
 * looks like any other adapter.
 *
 * runAgent semantics per Plan 58 v0.4 §4.18: LLMPort methods that
 * don't map to codex's execution model (generateText,
 * generateStructured, streamText, streamStructured) throw
 * `UnsupportedOperationError`. Consumers route non-agent traffic to
 * in-process adapters.
 *
 * providerExtras.codex on RunAgentOptions:
 *   {
 *     workingDirectory: string;       // required; codex --cd DIR
 *     sandbox?: "read-only" | "workspace-write" | "danger-full-access";
 *     autoApprove?: boolean;          // --dangerously-bypass-approvals-and-sandbox
 *     model?: string;                 // -m MODEL
 *     imageFiles?: string[];          // -i IMAGE
 *   }
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  AgentResult,
  CostUsage,
  LLMPort,
  RunAgentOptions,
  TokenUsage,
} from "@llm-ports/core";
import {
  AdapterInternalError,
  ProviderUnavailableError,
} from "@llm-ports/core";
import {
  buildEvent,
  correlationFromContext,
  newAttemptId,
  newOperationId,
  type CorrelationContext,
  type EmitterConfig,
  type ObservabilityContext,
  type ObservabilitySink,
} from "@llm-ports/observability-contract";

// ─── Public types ──────────────────────────────────────────────────

/**
 * Options for constructing a Codex adapter instance.
 */
export interface CodexAdapterOptions {
  /**
   * Path to the codex binary. Defaults to `"codex"` (found via PATH).
   * Override when running from a project-local install.
   */
  cliPath?: string;

  /**
   * Default sandbox mode when `providerExtras.codex.sandbox` is not
   * set on a call. Defaults to `"workspace-write"`, which is codex's
   * own default for exec mode.
   */
  defaultSandbox?: "read-only" | "workspace-write" | "danger-full-access";

  /**
   * Default model to pass to codex via `-m`. Optional; codex has its
   * own default when omitted.
   */
  defaultModel?: string;

  /**
   * Env vars to pass to the subprocess. Merged over process.env by
   * default. Consumers supplying OPENAI_API_KEY etc. do it here.
   */
  env?: Record<string, string>;

  /**
   * Optional observability configuration. When supplied, the adapter
   * emits contract lifecycle events to `sink` for every runAgent
   * call.
   */
  observability?: {
    sink: ObservabilitySink;
    source?: EmitterConfig["source"];
    context?: ObservabilityContext;
  };

  /**
   * How long to wait for the subprocess to finish before terminating
   * it with SIGTERM. Defaults to 30 minutes.
   */
  timeoutMs?: number;
}

/**
 * The adapter interface. Consumers construct one via
 * `createCodexAdapter(options)` and call `createLLMPort()` to obtain
 * an `LLMPort` implementation.
 */
export interface CodexAdapter {
  name: "codex";
  createLLMPort: () => LLMPort;
}

/**
 * Codex-specific options carried on `RunAgentOptions.providerExtras.codex`.
 */
export interface CodexRunAgentOptions {
  workingDirectory: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  autoApprove?: boolean;
  model?: string;
  imageFiles?: string[];
}

// ─── Adapter factory ────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function createCodexAdapter(options: CodexAdapterOptions = {}): CodexAdapter {
  const cliPath = options.cliPath ?? "codex";
  const defaultSandbox = options.defaultSandbox ?? "workspace-write";
  const defaultModel = options.defaultModel;
  const envOverrides = options.env ?? {};
  const observability = options.observability;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "codex",
    createLLMPort(): LLMPort {
      const alias = "codex";
      return {
        async generateText(): Promise<never> {
          throw new AdapterInternalError(
            alias,
            "adapter-codex only supports runAgent; use an in-process adapter for generateText.",
          );
        },
        async generateStructured(): Promise<never> {
          throw new AdapterInternalError(
            alias,
            "adapter-codex only supports runAgent; use an in-process adapter for generateStructured.",
          );
        },
        streamText: async function* (): AsyncIterable<string> {
          throw new AdapterInternalError(
            alias,
            "adapter-codex only supports runAgent; use an in-process adapter for streamText.",
          );
          // eslint-disable-next-line no-unreachable
          yield "";
        },
        streamStructured: async function* <T>(): AsyncIterable<T> {
          throw new AdapterInternalError(
            alias,
            "adapter-codex only supports runAgent; use an in-process adapter for streamStructured.",
          );
          // eslint-disable-next-line no-unreachable
          yield {} as T;
        },
        async runAgent(callOptions: RunAgentOptions): Promise<AgentResult> {
          return runCodexAgent(callOptions, {
            cliPath,
            defaultSandbox,
            defaultModel,
            envOverrides,
            observability,
            timeoutMs,
          });
        },
      };
    },
  };
}

// ─── runAgent implementation ────────────────────────────────────────

interface AdapterConfig {
  cliPath: string;
  defaultSandbox: "read-only" | "workspace-write" | "danger-full-access";
  defaultModel?: string;
  envOverrides: Record<string, string>;
  observability?: CodexAdapterOptions["observability"];
  timeoutMs: number;
}

async function runCodexAgent(
  options: RunAgentOptions,
  config: AdapterConfig,
): Promise<AgentResult> {
  const alias = "codex";
  const codexOpts = extractCodexOptions(options);
  const prompt = extractPromptFromMessages(options);
  const model = codexOpts.model ?? config.defaultModel;
  const sandbox = codexOpts.sandbox ?? config.defaultSandbox;

  const args = buildCodexArgs({
    prompt,
    workingDirectory: codexOpts.workingDirectory,
    model,
    sandbox,
    autoApprove: codexOpts.autoApprove ?? false,
    imageFiles: codexOpts.imageFiles,
  });

  const operationId = config.observability?.context?.operation_id ?? newOperationId();
  const attemptId = newAttemptId();
  const correlation: CorrelationContext = config.observability?.context
    ? correlationFromContext(config.observability.context, {
        operation_id: operationId,
        attempt_id: attemptId,
      })
    : { operation_id: operationId, attempt_id: attemptId };

  const emitterConfig: EmitterConfig | null = config.observability
    ? {
        source: config.observability.source ?? {
          library: "@llm-ports/adapter-codex",
          library_version: "0.1.0-alpha.28",
        },
        sink: config.observability.sink,
      }
    : null;

  if (emitterConfig) {
    const opCorr: CorrelationContext = { operation_id: correlation.operation_id };
    emitterConfig.sink.emit(
      buildEvent(emitterConfig, "llm.operation.started", opCorr, {
        task_type: options.taskType,
        provider_chain: [alias],
        method: "runAgent",
      }),
    );
    emitterConfig.sink.emit(
      buildEvent(emitterConfig, "llm.attempt.started", correlation, {
        provider_alias: alias,
        model_id: model ?? "(codex-default)",
        attempt_number: 1,
        is_retry: false,
        is_fallback: false,
      }),
    );
  }

  const start = Date.now();

  try {
    const outcome = await spawnCodex({
      cliPath: config.cliPath,
      args,
      env: { ...process.env, ...config.envOverrides } as NodeJS.ProcessEnv,
      timeoutMs: config.timeoutMs,
      signal: options.signal,
    });

    const latencyMs = Date.now() - start;

    // Codex --json emits one JSON object per line. Parse each; on
    // parse failure fall through to treating the line as opaque text.
    const parsedEvents = parseCodexJsonLines(outcome.stdout);
    const usage = deriveUsage(parsedEvents);
    const cost: CostUsage = { inputUSD: 0, outputUSD: 0, totalUSD: 0 };
    const finalText = deriveFinalText(parsedEvents) ?? outcome.stdout.trim();
    const modelId = deriveModelId(parsedEvents) ?? model ?? "(codex-default)";

    if (emitterConfig) {
      emitterConfig.sink.emit(
        buildEvent(emitterConfig, "llm.attempt.completed", correlation, {
          usage,
          cost,
          latency_ms: latencyMs,
          final_model_id: modelId,
        }),
      );
      const opCorr: CorrelationContext = { operation_id: correlation.operation_id };
      emitterConfig.sink.emit(
        buildEvent(emitterConfig, "llm.operation.completed", opCorr, {
          aggregate_usage: usage,
          aggregate_cost: cost,
          attempts_made: 1,
          final_provider_alias: alias,
          total_duration_ms: latencyMs,
          result_summary: { exit_code: outcome.exitCode },
        }),
      );
    }

    return {
      text: finalText,
      messages: [{ role: "user", content: prompt }, { role: "assistant", content: finalText }],
      toolCalls: [],
      usage,
      cost,
      modelId,
      providerAlias: alias,
      latencyMs,
      stepsTaken: parsedEvents.length,
      terminationReason: "completed",
    };
  } catch (err) {
    // Local failure or subprocess error. Emit failure lifecycle events
    // before propagating.
    const latencyMs = Date.now() - start;
    const errorInfo = {
      error_type: err instanceof Error ? err.name : "UnknownError",
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
      fallback_worthy: false,
      cause_category: "port_internal" as const,
    };
    if (emitterConfig) {
      emitterConfig.sink.emit(
        buildEvent(emitterConfig, "llm.attempt.failed", correlation, {
          error: errorInfo,
          latency_ms: latencyMs,
        }),
      );
      const opCorr: CorrelationContext = { operation_id: correlation.operation_id };
      emitterConfig.sink.emit(
        buildEvent(emitterConfig, "llm.operation.failed", opCorr, {
          error: errorInfo,
          attempts_made: 1,
          providers_tried: [alias],
          total_duration_ms: latencyMs,
        }),
      );
    }
    if (err instanceof Error) {
      throw new ProviderUnavailableError(alias, err);
    }
    throw new ProviderUnavailableError(alias, new Error(String(err)));
  }
}

// ─── Subprocess helpers ─────────────────────────────────────────────

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SpawnRequest {
  cliPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

async function spawnCodex(req: SpawnRequest): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(req.cliPath, req.args, { env: req.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, req.timeoutMs);

    const abortHandler = () => child.kill("SIGTERM");
    req.signal?.addEventListener("abort", abortHandler);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", (err) => {
      clearTimeout(timeout);
      req.signal?.removeEventListener("abort", abortHandler);
      reject(err);
    });

    child.once("close", (code) => {
      clearTimeout(timeout);
      req.signal?.removeEventListener("abort", abortHandler);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

// ─── Option extraction + arg building ───────────────────────────────

/** @internal exported for tests, not part of the public API surface. */
export function extractCodexOptions(options: RunAgentOptions): CodexRunAgentOptions {
  const bag = (options as unknown as { providerExtras?: { codex?: CodexRunAgentOptions } })
    .providerExtras?.codex;
  if (!bag || typeof bag.workingDirectory !== "string" || bag.workingDirectory.length === 0) {
    throw new AdapterInternalError(
      "codex",
      "runAgent requires providerExtras.codex.workingDirectory (the git repo the CLI operates in).",
    );
  }
  return bag;
}

/** @internal exported for tests, not part of the public API surface. */
export function extractPromptFromMessages(options: RunAgentOptions): string {
  // Concatenate every user message (in order) into a single prompt.
  // Codex takes one prompt argument; multi-turn context flows via
  // codex's own session state, not through our messages array.
  const userMessages = options.messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) {
    throw new AdapterInternalError("codex", "runAgent requires at least one user message.");
  }
  return userMessages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n\n");
}

/** @internal exported for tests. */
export interface BuildArgsInput {
  prompt: string;
  workingDirectory: string;
  model?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  autoApprove: boolean;
  imageFiles?: string[];
}

/** @internal exported for tests, not part of the public API surface. */
export function buildCodexArgs(input: BuildArgsInput): string[] {
  const args: string[] = ["exec", "--json", "--cd", input.workingDirectory];
  if (input.model) {
    args.push("-m", input.model);
  }
  args.push("-s", input.sandbox);
  if (input.autoApprove) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (input.imageFiles && input.imageFiles.length > 0) {
    for (const file of input.imageFiles) {
      args.push("-i", file);
    }
  }
  args.push(input.prompt);
  return args;
}

// ─── JSON output parsing ────────────────────────────────────────────

/**
 * A single line of codex's --json output. Shape is codex-defined;
 * we treat it as an opaque record for observability + best-effort
 * extraction.
 */
/** @internal exported for tests. */
export interface CodexJsonEvent {
  [key: string]: unknown;
  type?: string;
}

/** @internal exported for tests, not part of the public API surface. */
export function parseCodexJsonLines(stdout: string): CodexJsonEvent[] {
  const events: CodexJsonEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        events.push(parsed as CodexJsonEvent);
      }
    } catch {
      // Non-JSON line; ignore for structured extraction. The raw
      // stdout is still available as the fallback finalText source.
    }
  }
  return events;
}

/**
 * Best-effort token-usage extraction. Codex reports usage on a
 * completion-shaped event when the underlying provider returns one.
 * When absent, return zeros.
 */
/** @internal exported for tests, not part of the public API surface. */
export function deriveUsage(events: CodexJsonEvent[]): TokenUsage {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    const usage = (ev as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } })
      .usage;
    if (usage && typeof usage === "object") {
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
      return { inputTokens, outputTokens, totalTokens };
    }
  }
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/** @internal exported for tests, not part of the public API surface. */
export function deriveFinalText(events: CodexJsonEvent[]): string | null {
  // Walk backwards looking for a final assistant message or a
  // response-complete-shaped event carrying `text` or `content`.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (typeof (ev as { text?: string }).text === "string") {
      return (ev as { text: string }).text;
    }
    if (typeof (ev as { content?: string }).content === "string") {
      return (ev as { content: string }).content;
    }
  }
  return null;
}

/** @internal exported for tests, not part of the public API surface. */
export function deriveModelId(events: CodexJsonEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    const model = (ev as { model?: string }).model;
    if (typeof model === "string" && model.length > 0) return model;
  }
  return null;
}
