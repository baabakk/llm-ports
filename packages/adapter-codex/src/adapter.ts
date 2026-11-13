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
   * Arguments placed before the generated codex arguments.
   *
   * `cliPath` alone assumes the CLI is a single executable on PATH, which
   * excludes every indirect invocation: `node ./codex.mjs`, `npx codex`, a
   * wrapper script, or a shim inside a container. On Windows it also excludes
   * any `.cmd` or `.bat`, because Node refuses to spawn those without a shell.
   *
   * With this, `{ cliPath: "node", cliArgsPrefix: ["./codex.mjs"] }` runs
   * `node ./codex.mjs exec --json ...`.
   */
  cliArgsPrefix?: readonly string[];

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
   * Default working directory, used when a call supplies no
   * `providerExtras.codex.workingDirectory`.
   *
   * Without this the adapter cannot serve a plain contract-shaped call at all,
   * because the working directory is the one genuinely required field and the
   * only way to supply it was a provider-specific bag the caller had to know
   * about. A port whose methods cannot be called through the port's own
   * options is not really implementing the port.
   */
  defaultWorkingDirectory?: string;

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

/**
 * Reported on every observability event as the emitting library's version.
 *
 * A constant rather than a runtime read of `package.json`, because this
 * package builds to both ESM and CJS and `import.meta.url` is not available in
 * the latter. **A constant alone is what went wrong before**: this said
 * `0.1.0-alpha.30` for five releases, and the aider adapter still does, and the
 * contract package's `SPEC_VERSION` is seven releases behind under a comment
 * claiming a sync script that was never written.
 *
 * So the constant comes with a test that compares it against `package.json`
 * and fails on the next version bump. The guard is the part that matters; the
 * constant is just where the value lives.
 */
export const ADAPTER_VERSION = "0.1.0-alpha.35";

export function createCodexAdapter(options: CodexAdapterOptions = {}): CodexAdapter {
  const cliPath = options.cliPath ?? "codex";
  const cliArgsPrefix = options.cliArgsPrefix ?? [];
  const defaultWorkingDirectory = options.defaultWorkingDirectory;
  // Read-only unless a caller opts out. `workspace-write` was the previous
  // default, so a call whose output is a proposal could write files in the
  // working directory without anyone asking for that. For a consumer whose
  // architecture routes consequential action through an approval gate, the
  // permissive mode has to be chosen rather than assumed.
  const defaultSandbox = options.defaultSandbox ?? "read-only";
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
            cliArgsPrefix,
            defaultSandbox,
            defaultModel,
            defaultWorkingDirectory,
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
  cliArgsPrefix: readonly string[];
  defaultSandbox: "read-only" | "workspace-write" | "danger-full-access";
  defaultModel?: string;
  defaultWorkingDirectory?: string;
  envOverrides: Record<string, string>;
  observability?: CodexAdapterOptions["observability"];
  timeoutMs: number;
}

async function runCodexAgent(
  options: RunAgentOptions,
  config: AdapterConfig,
): Promise<AgentResult> {
  const alias = "codex";
  const codexOpts = extractCodexOptions(options, config.defaultWorkingDirectory);
  assertToolsUnsupported(options);
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
    library_version: ADAPTER_VERSION,
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
                args: [...config.cliArgsPrefix, ...args],
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
            // No cost is reported (alpha.34+). The Codex CLI does not tell this
            // adapter what a run cost, and this adapter has no pricing table to
            // compute one from. It previously reported an explicit zero, which
            // is indistinguishable from a genuinely free run and made every spend
            // total that included these calls under-count without saying so.
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
              modelId,
              providerAlias: alias,
              latencyMs,
              // One subprocess invocation is one step from this port's point of
              // view. The previous value was the number of parsed output lines,
              // which looks like a measurement and is not one: it moves with
              // how chatty the CLI happens to be.
              stepsTaken: 1,
              terminationReason: "completed",
            };

            return {
              value: result,
              usage,
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
export function extractCodexOptions(
  options: RunAgentOptions,
  defaultWorkingDirectory?: string,
): CodexRunAgentOptions {
  const bag = (options as unknown as { providerExtras?: { codex?: CodexRunAgentOptions } })
    .providerExtras?.codex;
  const workingDirectory =
    bag && typeof bag.workingDirectory === "string" && bag.workingDirectory.length > 0
      ? bag.workingDirectory
      : defaultWorkingDirectory;
  if (!workingDirectory) {
    throw new AdapterInternalError(
      "codex",
      "runAgent requires providerExtras.codex.workingDirectory (the git repo the CLI operates in), " +
        "or a defaultWorkingDirectory on the adapter.",
    );
  }
  return { ...(bag ?? {}), workingDirectory };
}

/** @internal exported for tests, not part of the public API surface. */
function renderContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Compose the single prompt argument the CLI takes from the whole call.
 *
 * **Every part of the call reaches the prompt or the call is refused.** The
 * earlier version kept only the user messages, which silently dropped the
 * role prompt and every assistant turn: a ten-role agent system became ten
 * identical generic models, and the result reported success. The CLI documents
 * its prompt argument as the agent's initial instructions, so there is a
 * channel for all of it, and concatenating is the honest use of it.
 *
 * Roles are labelled rather than run together, because a model asked to
 * continue a conversation needs to know which turns were its own.
 */
export function extractPromptFromMessages(options: RunAgentOptions): string {
  if (options.messages.length === 0) {
    throw new AdapterInternalError("codex", "runAgent requires at least one message.");
  }

  const sections: string[] = [];

  // The role prompt first, which is how the CLI reads its prompt argument.
  const instructions = options.instructions?.trim();
  if (instructions) sections.push(instructions);

  const transcript = options.messages
    .map((m) => `${m.role}: ${renderContent(m.content)}`)
    .join("\n\n");
  sections.push(transcript);

  return sections.join("\n\n---\n\n");
}

/**
 * Refuse a call carrying tools, because this adapter has no channel for them.
 *
 * The CLI exposes caller-supplied tools over MCP, which needs the tool
 * definitions to travel as JSON Schema. They are Zod-only until
 * `TD-LLMPORTS-TOOLS-ARE-ZOD-ONLY` lands in the release candidate, so the
 * honest answer today is a refusal naming the field. Accepting them and
 * dropping them is what this change exists to stop: an agent that reaches
 * none of its tools looks like a weak model rather than a broken wiring.
 */
export function assertToolsUnsupported(options: RunAgentOptions): void {
  const names = Object.keys(options.tools ?? {});
  if (names.length === 0) return;
  throw new AdapterInternalError(
    "codex",
    `runAgent cannot forward tools: adapter-codex has no tool channel yet, so the ${names.length} ` +
      `supplied tool(s) (${names.join(", ")}) would be silently dropped. Route tool-using agent ` +
      `traffic to an in-process adapter, or call without tools.`,
  );
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
