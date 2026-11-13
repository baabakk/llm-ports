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
 * Options for constructing an Aider adapter instance.
 */
export interface AiderAdapterOptions {
  /**
   * Path to the aider binary. Defaults to `"aider"` (found via PATH).
   * Override when running from a project-local install.
   */
  cliPath?: string;

  /**
   * Arguments placed before the generated aider arguments.
   *
   * `cliPath` alone assumes the CLI is a single executable on PATH, which
   * excludes `node ./aider.mjs`, `npx`, a wrapper script, a shim inside a
   * container, and on Windows every `.cmd`, because Node refuses to spawn one
   * without a shell. It also makes the adapter untestable, which is how it
   * stayed outside the shared contract suite.
   */
  cliArgsPrefix?: readonly string[];

  /**
   * Default working directory, used when a call supplies no
   * `providerExtras.aider.workingDirectory`.
   *
   * Without this the adapter cannot serve a plain contract-shaped call, because
   * the working directory is the one genuinely required field and the only way
   * to supply it was a provider-specific bag the caller had to know about.
   */
  defaultWorkingDirectory?: string;

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

/**
 * Reported on every observability event as the emitting library's version.
 * Guarded by a test against `package.json`, because the literal this replaces
 * was five releases stale, and so is the one in the contract package under a
 * comment claiming a sync script that was never written.
 */
export const ADAPTER_VERSION = "1.0.0-rc.36";

export function createAiderAdapter(options: AiderAdapterOptions = {}): AiderAdapter {
  const cliPath = options.cliPath ?? "aider";
  const cliArgsPrefix = options.cliArgsPrefix ?? [];
  const defaultWorkingDirectory = options.defaultWorkingDirectory;
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
            cliArgsPrefix,
            defaultWorkingDirectory,
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
  cliArgsPrefix: readonly string[];
  defaultWorkingDirectory?: string;
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
  const aiderOpts = extractAiderOptions(options, config.defaultWorkingDirectory);
  assertToolsUnsupported(options);
  const prompt = extractPromptFromMessages(options);
  const model = aiderOpts.model ?? config.defaultModel;
  const editFormat = aiderOpts.editFormat ?? config.defaultEditFormat;

  const args = buildAiderArgs({
    prompt,
    files: aiderOpts.files ?? [],
    model,
    editFormat,
    // Stays true, unlike the Codex adapter's sandbox default, and the
    // difference is a capability fact rather than a looser choice. Aider is a
    // code editor with no read-only mode: it edits files and commits to git,
    // and without --yes-always it waits for an interactive confirmation a
    // subprocess will never supply, so the call hangs rather than being safe.
    //
    // So this adapter cannot be made side-effect-free. That is something a
    // caller needs declared rather than defaulted, which is the requirement
    // recorded in
    // TD-LLMPORTS-CONSUMER-REQUIREMENTS-FOR-THE-SUBPROCESS-ADAPTER-FAMILY:
    // an explicit statement of whether a call may write.
    yesAlways: aiderOpts.yesAlways ?? true,
    verbose: aiderOpts.verbose ?? false,
    mapTokens: aiderOpts.mapTokens,
  });

  const instrumentation = buildAdapterInstrumentation(config.observability, {
    library: "@llm-ports/adapter-aider",
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
          { providerAlias: alias, modelId: model ?? "(aider-default)" },
          async () => {
            const start = Date.now();
            let outcome: SpawnOutcome;
            try {
              outcome = await spawnAider({
                cliPath: config.cliPath,
                args: [...config.cliArgsPrefix, ...args],
                cwd: aiderOpts.workingDirectory,
                env: { ...process.env, ...config.envOverrides } as NodeJS.ProcessEnv,
                timeoutMs: config.timeoutMs,
                signal: options.signal,
              });
            } catch (spawnErr) {
              // See adapter-codex for the classification rationale.
              if (spawnErr instanceof Error) {
                throw new AdapterInternalError(alias, spawnErr.message, spawnErr);
              }
              throw new AdapterInternalError(alias, String(spawnErr));
            }
            const latencyMs = Date.now() - start;

            // Aider doesn't emit a structured JSON stream (unlike codex).
            // Report zeros for usage; the caller can layer richer accounting
            // via observability metadata or by scraping stdout downstream.
            const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
            // No cost is reported (alpha.34+). The Aider CLI does not tell this
            // adapter what a run cost, and this adapter has no pricing table to
            // compute one from. It previously reported an explicit zero, which
            // is indistinguishable from a genuinely free run and made every spend
            // total that included these calls under-count without saying so.
            const finalText = outcome.stdout;
            const modelId = model ?? "(aider-default)";

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

/** @internal exported for tests, not part of the public API surface. */
export function extractAiderOptions(
  options: RunAgentOptions,
  defaultWorkingDirectory?: string,
): AiderRunAgentOptions {
  const bag = (options as unknown as { providerExtras?: { aider?: AiderRunAgentOptions } })
    .providerExtras?.aider;
  const workingDirectory =
    bag && typeof bag.workingDirectory === "string" && bag.workingDirectory.length > 0
      ? bag.workingDirectory
      : defaultWorkingDirectory;
  if (!workingDirectory) {
    throw new AdapterInternalError(
      "aider",
      "runAgent requires providerExtras.aider.workingDirectory (the git repo the CLI operates in), " +
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
 * Compose the single `--message` argument from the whole call.
 *
 * **Every part of the call reaches the prompt or the call is refused.** The
 * earlier version kept user messages only, silently dropping the role prompt
 * and every assistant turn, and its own tests pinned that as the requirement
 * under the name "ignores non-user roles entirely". The Codex adapter had the
 * identical defect and the identically named test.
 *
 * Aider has no system-prompt flag, so the instructions go into the message
 * ahead of the transcript. That is the only channel available, which makes it
 * the honest one rather than merely the convenient one.
 *
 * **Duplicated from the Codex adapter deliberately, not extracted.** The two
 * are identical today, which argues for sharing, and the next member of this
 * family argues against doing it yet: the Claude Code CLI has a real
 * `--append-system-prompt`, so its composition will not look like this one. A
 * helper extracted from two identical copies would be the wrong shape for the
 * third.
 */
export function extractPromptFromMessages(options: RunAgentOptions): string {
  if (options.messages.length === 0) {
    throw new AdapterInternalError("aider", "runAgent requires at least one message.");
  }

  const sections: string[] = [];
  const instructions = options.instructions?.trim();
  if (instructions) sections.push(instructions);

  sections.push(
    options.messages.map((m) => `${m.role}: ${renderContent(m.content)}`).join("\n\n"),
  );

  return sections.join("\n\n---\n\n");
}

/**
 * Refuse a call carrying tools, because this adapter has no channel for them.
 *
 * Verified 2026-11-12 against the installed aider 0.86.2: zero MCP flags and
 * zero schema flags in its help output, and its own documentation site
 * surfaces no MCP page. Native MCP support in the CLI is an open request
 * upstream rather than a shipped feature, so unlike the Codex adapter this
 * refusal is not waiting on a tool definition format. It is waiting on the
 * tool itself.
 */
export function assertToolsUnsupported(options: RunAgentOptions): void {
  const names = Object.keys(options.tools ?? {});
  if (names.length === 0) return;
  throw new AdapterInternalError(
    "aider",
    `runAgent cannot forward tools: aider exposes no tool channel, so the ${names.length} ` +
      `supplied tool(s) (${names.join(", ")}) would be silently dropped. Route tool-using agent ` +
      `traffic to an in-process adapter, or call without tools.`,
  );
}

/** @internal exported for tests. */
export interface BuildArgsInput {
  prompt: string;
  files: string[];
  model?: string;
  editFormat?: string;
  yesAlways: boolean;
  verbose: boolean;
  mapTokens?: number;
}

/** @internal exported for tests, not part of the public API surface. */
export function buildAiderArgs(input: BuildArgsInput): string[] {
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
