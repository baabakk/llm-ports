/**
 * Aider CLI adapter implementation.
 *
 * Runs `aider --no-stream --yes-always --message "<prompt>"` as a
 * subprocess, captures stdout/stderr, and emits contract lifecycle
 * events via a caller-supplied ObservabilitySink so the port surface
 * looks like any other adapter.
 *
 * runAgent semantics per Plan 58 v0.4 §4.18: LLMPort methods that
 * don't map to aider's execution model (generateText,
 * generateStructured, streamText, streamStructured) throw
 * `AdapterInternalError`. Consumers route non-agent traffic to
 * in-process adapters.
 *
 * providerExtras.aider on RunAgentOptions:
 *   {
 *     workingDirectory: string;       // required; process cwd
 *     files?: string[];               // files added to the aider chat
 *     model?: string;                 // --model (overrides default)
 *     editFormat?: string;            // --edit-format
 *     yesAlways?: boolean;            // --yes-always (default true)
 *     verbose?: boolean;              // --verbose
 *     mapTokens?: number;             // --map-tokens
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
 * Options for constructing an Aider adapter instance.
 */
export interface AiderAdapterOptions {
  /**
   * Path to the aider binary. Defaults to `"aider"` (found via PATH).
   * Override when running from a project-local install.
   */
  cliPath?: string;

  /**
   * Default model to pass to aider via `--model`. Optional; aider has
   * its own default when omitted.
   */
  defaultModel?: string;

  /**
   * Default edit format (`--edit-format`). Optional.
   */
  defaultEditFormat?: string;

  /**
   * Env vars to pass to the subprocess. Merged over process.env by
   * default. Consumers supplying OPENAI_API_KEY / ANTHROPIC_API_KEY
   * etc. do it here.
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
 * `createAiderAdapter(options)` and call `createLLMPort()` to obtain
 * an `LLMPort` implementation.
 */
export interface AiderAdapter {
  name: "aider";
  createLLMPort: () => LLMPort;
}

/**
 * Aider-specific options carried on `RunAgentOptions.providerExtras.aider`.
 */
export interface AiderRunAgentOptions {
  workingDirectory: string;
  files?: string[];
  model?: string;
  editFormat?: string;
  yesAlways?: boolean;
  verbose?: boolean;
  mapTokens?: number;
}

// ─── Adapter factory ────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function createAiderAdapter(options: AiderAdapterOptions = {}): AiderAdapter {
  const cliPath = options.cliPath ?? "aider";
  const defaultModel = options.defaultModel;
  const defaultEditFormat = options.defaultEditFormat;
  const envOverrides = options.env ?? {};
  const observability = options.observability;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "aider",
    createLLMPort(): LLMPort {
      const alias = "aider";
      return {
        async generateText(): Promise<never> {
          throw new AdapterInternalError(
            alias,
            "adapter-aider only supports runAgent; use an in-process adapter for generateText.",
          );
        },
        async generateStructured(): Promise<never> {
          throw new AdapterInternalError(
            alias,
            "adapter-aider only supports runAgent; use an in-process adapter for generateStructured.",
          );
        },
        streamText: async function* (): AsyncIterable<string> {
          throw new AdapterInternalError(
            alias,
            "adapter-aider only supports runAgent; use an in-process adapter for streamText.",
          );
          // eslint-disable-next-line no-unreachable
          yield "";
        },
        streamStructured: async function* <T>(): AsyncIterable<T> {
          throw new AdapterInternalError(
            alias,
            "adapter-aider only supports runAgent; use an in-process adapter for streamStructured.",
          );
          // eslint-disable-next-line no-unreachable
          yield {} as T;
        },
        async runAgent(callOptions: RunAgentOptions): Promise<AgentResult> {
          return runAiderAgent(callOptions, {
            cliPath,
            defaultModel,
            defaultEditFormat,
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
  defaultModel?: string;
  defaultEditFormat?: string;
  envOverrides: Record<string, string>;
  observability?: AiderAdapterOptions["observability"];
  timeoutMs: number;
}

async function runAiderAgent(
  options: RunAgentOptions,
  config: AdapterConfig,
): Promise<AgentResult> {
  const alias = "aider";
  const aiderOpts = extractAiderOptions(options);
  const prompt = extractPromptFromMessages(options);
  const model = aiderOpts.model ?? config.defaultModel;
  const editFormat = aiderOpts.editFormat ?? config.defaultEditFormat;

  const args = buildAiderArgs({
    prompt,
    files: aiderOpts.files ?? [],
    model,
    editFormat,
    yesAlways: aiderOpts.yesAlways ?? true,
    verbose: aiderOpts.verbose ?? false,
    mapTokens: aiderOpts.mapTokens,
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
          library: "@llm-ports/adapter-aider",
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
        model_id: model ?? "(aider-default)",
        attempt_number: 1,
        is_retry: false,
        is_fallback: false,
      }),
    );
  }

  const start = Date.now();

  try {
    const outcome = await spawnAider({
      cliPath: config.cliPath,
      args,
      cwd: aiderOpts.workingDirectory,
      env: { ...process.env, ...config.envOverrides } as NodeJS.ProcessEnv,
      timeoutMs: config.timeoutMs,
      signal: options.signal,
    });

    const latencyMs = Date.now() - start;

    // Aider doesn't emit a structured JSON stream (unlike codex).
    // Report zeros for usage; the caller can layer richer accounting
    // via observability metadata or by scraping stdout downstream.
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const cost: CostUsage = { inputUSD: 0, outputUSD: 0, totalUSD: 0 };
    const finalText = outcome.stdout;
    const modelId = model ?? "(aider-default)";

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
      stepsTaken: 1,
      terminationReason: "completed",
    };
  } catch (err) {
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
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

async function spawnAider(req: SpawnRequest): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(req.cliPath, req.args, {
        cwd: req.cwd,
        env: req.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
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

function extractAiderOptions(options: RunAgentOptions): AiderRunAgentOptions {
  const bag = (options as unknown as { providerExtras?: { aider?: AiderRunAgentOptions } })
    .providerExtras?.aider;
  if (!bag || typeof bag.workingDirectory !== "string" || bag.workingDirectory.length === 0) {
    throw new AdapterInternalError(
      "aider",
      "runAgent requires providerExtras.aider.workingDirectory (the git repo the CLI operates in).",
    );
  }
  return bag;
}

function extractPromptFromMessages(options: RunAgentOptions): string {
  // Concatenate every user message (in order) into a single prompt.
  // Aider takes one --message argument; multi-turn context flows via
  // aider's own chat history, not through our messages array.
  const userMessages = options.messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) {
    throw new AdapterInternalError("aider", "runAgent requires at least one user message.");
  }
  return userMessages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n\n");
}

interface BuildArgsInput {
  prompt: string;
  files: string[];
  model?: string;
  editFormat?: string;
  yesAlways: boolean;
  verbose: boolean;
  mapTokens?: number;
}

function buildAiderArgs(input: BuildArgsInput): string[] {
  const args: string[] = ["--no-stream"];
  if (input.yesAlways) {
    args.push("--yes-always");
  }
  if (input.verbose) {
    args.push("--verbose");
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.editFormat) {
    args.push("--edit-format", input.editFormat);
  }
  if (typeof input.mapTokens === "number") {
    args.push("--map-tokens", String(input.mapTokens));
  }
  args.push("--message", input.prompt);
  for (const file of input.files) {
    args.push(file);
  }
  return args;
}
