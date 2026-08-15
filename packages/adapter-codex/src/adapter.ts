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
  Instrumentation,
  LLMPort,
  RunAgentOptions,
  TokenUsage,
} from "@llm-ports/core";
import {
  AdapterInternalError,
  ProviderUnavailableError,
  withAttempt,
  withOperation,
} from "@llm-ports/core";
import type {
  EmitterConfig,
  ObservabilityContext,
  ObservabilitySink,
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

  const instrumentation = buildAdapterInstrumentation(config.observability, {
    library: "@llm-ports/adapter-codex",
    library_version: "0.1.0-alpha.30",
  });

  try {
    return await withOperation(
      instrumentation,
      {
        taskType: options.taskType ?? "general",
        method: "runAgent",
        providerChain: [alias],
      },
      async (opCtx) => {
        return withAttempt(
          opCtx,
          { providerAlias: alias, modelId: model ?? "(codex-default)" },
          async () => {
            const start = Date.now();
            let outcome: SpawnOutcome;
            try {
              outcome = await spawnCodex({
                cliPath: config.cliPath,
                args,
                env: { ...process.env, ...config.envOverrides } as NodeJS.ProcessEnv,
                timeoutMs: config.timeoutMs,
                signal: options.signal,
              });
            } catch (spawnErr) {
              // Preserve pre-refactor `cause_category: "port_internal"`
              // classification on the emitted `llm.attempt.failed` /
              // `.operation.failed` events. Bare `Error` from spawn maps
              // to `"unknown"` in `errorTypeToCauseCategory`, so wrap it
              // as `AdapterInternalError` first (which maps to
              // `"port_internal"`). The outer catch still re-throws as
              // `ProviderUnavailableError` for the caller so external
              // behavior is unchanged.
              if (spawnErr instanceof Error) {
                throw new AdapterInternalError(alias, spawnErr.message, spawnErr);
              }
              throw new AdapterInternalError(alias, String(spawnErr));
            }
            const latencyMs = Date.now() - start;

            // Codex --json emits one JSON object per line. Parse each; on
            // parse failure fall through to treating the line as opaque text.
            const parsedEvents = parseCodexJsonLines(outcome.stdout);
            const usage = deriveUsage(parsedEvents);
            const cost: CostUsage = { inputUSD: 0, outputUSD: 0, totalUSD: 0 };
            const finalText = deriveFinalText(parsedEvents) ?? outcome.stdout.trim();
            const modelId = deriveModelId(parsedEvents) ?? model ?? "(codex-default)";

            // Carry codex's exit code through to `operation.completed`'s
            // result_summary so consumers preserve the pre-shared-service
            // signal.
            if (opCtx) {
              opCtx.resultSummary = { exit_code: outcome.exitCode };
            }

            const result: AgentResult = {
              text: finalText,
              messages: [
                { role: "user", content: prompt },
                { role: "assistant", content: finalText },
              ],
              toolCalls: [],
              usage,
              cost,
              modelId,
              providerAlias: alias,
              latencyMs,
              stepsTaken: parsedEvents.length,
              terminationReason: "completed",
            };

            return {
              value: result,
              usage,
              cost,
              modelId,
              responseCharCount: finalText.length,
              responsePreviewSource: finalText,
            };
          },
        );
      },
    );
  } catch (err) {
    if (err instanceof ProviderUnavailableError) throw err;
    if (err instanceof Error) {
      throw new ProviderUnavailableError(alias, err);
    }
    throw new ProviderUnavailableError(alias, new Error(String(err)));
  }
}

/**
 * Alpha.30+ §2.5: build an `Instrumentation` handle for the shared
 * service from the adapter's config.observability shape (which predates
 * the shared service and mirrors `EmitterConfig` inline). Returns
 * undefined when observability is not configured so the wrap-around
 * helpers no-op cheaply.
 */
function buildAdapterInstrumentation(
  observability: AdapterConfig["observability"] | undefined,
  defaultSource: EmitterConfig["source"],
): Instrumentation | undefined {
  if (!observability) return undefined;
  const instrumentation: Instrumentation = {
    config: {
      source: observability.source ?? defaultSource,
      sink: observability.sink,
    },
  };
  if (observability.context) instrumentation.context = observability.context;
  return instrumentation;
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
