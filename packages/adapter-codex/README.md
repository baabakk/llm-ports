# @llm-ports/adapter-codex

Subprocess-driven adapter for [OpenAI Codex CLI](https://github.com/openai/codex). Wraps `codex exec --json` as an in-process `LLMPort.runAgent` implementation.

## What this adapter does

- Spawns `codex exec` as a subprocess with a caller-supplied prompt.
- Parses codex's `--json` output stream into `@llm-ports/observability-contract` events.
- Returns an `AgentResult` compatible with the standard `LLMPort` interface.

## Shape A: passthrough governance

For alpha.28, this adapter operates in **passthrough** mode. The operator supplies codex with its own OpenAI credentials (via env vars or `~/.codex/auth.toml`); `@llm-ports`'s registry does NOT route codex's LLM traffic. The port owns lifecycle observability and orchestration; the LLM calls themselves fly directly from codex to OpenAI.

The alternative (routing codex's LLM traffic through `@llm-ports`) would require a local OpenAI Responses API gateway that's substantial to build and fragile to maintain. Per the 2026-07-22 architectural decision, that direction is not on the roadmap.

## Usage

```typescript
import { createCodexAdapter } from "@llm-ports/adapter-codex";
import { createCollectingSink } from "@llm-ports/observability-contract";

const sink = createCollectingSink();

const adapter = createCodexAdapter({
  cliPath: "codex", // or absolute path
  defaultSandbox: "workspace-write",
  defaultModel: "gpt-5-codex",
  env: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  },
  observability: { sink },
});

const port = adapter.createLLMPort();

const result = await port.runAgent({
  taskType: "code-review",
  messages: [
    {
      role: "user",
      content: "Add a docstring to the top-level function in main.ts.",
    },
  ],
  tools: {}, // ignored; codex uses its own built-in tools
  providerExtras: {
    codex: {
      workingDirectory: "E:\\projects\\my-repo",
      sandbox: "workspace-write",
    },
  },
});

console.log(result.text);
console.log(`Codex emitted ${sink.events.length} observability events`);
```

## Options

### `CodexAdapterOptions`

- `cliPath?: string` — Path to the codex binary. Defaults to `"codex"`.
- `defaultSandbox?: "read-only" | "workspace-write" | "danger-full-access"` — Default sandbox mode. Defaults to `"workspace-write"`.
- `defaultModel?: string` — Default model to pass to codex via `-m`. Optional.
- `env?: Record<string, string>` — Environment variables merged over `process.env`. Where you set `OPENAI_API_KEY`.
- `observability?: { sink, source?, context? }` — Optional observability configuration. When supplied, the adapter emits lifecycle events to `sink` for every `runAgent` call.
- `timeoutMs?: number` — Subprocess timeout. Defaults to 30 minutes.

### `RunAgentOptions.providerExtras.codex` (required)

- `workingDirectory: string` — **Required.** The git repo codex operates in.
- `sandbox?: "read-only" | "workspace-write" | "danger-full-access"` — Overrides `defaultSandbox` per call.
- `autoApprove?: boolean` — Skip all confirmation prompts (`--dangerously-bypass-approvals-and-sandbox`). Default `false`.
- `model?: string` — Overrides `defaultModel` per call.
- `imageFiles?: string[]` — Image files to attach to the initial prompt.

## Non-runAgent methods

`generateText`, `generateStructured`, `streamText`, and `streamStructured` throw `AdapterInternalError`. Codex is an agent runtime, not a raw completion runtime. Consumers who need raw completions route those task types to an in-process adapter (`@llm-ports/adapter-openai`, `@llm-ports/adapter-anthropic`, etc.).

## License

MIT.
