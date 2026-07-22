# @llm-ports/adapter-aider

Subprocess-driven adapter for [Aider](https://github.com/paul-gauthier/aider). Wraps `aider --no-stream --yes-always --message "<prompt>"` as an in-process `LLMPort.runAgent` implementation.

## What this adapter does

- Spawns `aider` as a subprocess with a caller-supplied prompt.
- Captures stdout as the assistant's final text.
- Emits `@llm-ports/observability-contract` lifecycle events for every `runAgent` call.
- Returns an `AgentResult` compatible with the standard `LLMPort` interface.

## Shape A: passthrough governance

For alpha.28, this adapter operates in **passthrough** mode. The operator supplies aider with its own provider credentials (via env vars, `~/.aider.conf.yml`, or per-invocation flags); `@llm-ports`'s registry does NOT route aider's LLM traffic. The port owns lifecycle observability and orchestration; the LLM calls themselves fly directly from aider to the provider.

Shape B (aider talking to a local OpenAI-Chat-Completions shim so `@llm-ports` can route the model calls) is deferred to alpha.29 per the 2026-07-21 architectural decision.

## Usage

```typescript
import { createAiderAdapter } from "@llm-ports/adapter-aider";
import { createCollectingSink } from "@llm-ports/observability-contract";

const sink = createCollectingSink();

const adapter = createAiderAdapter({
  cliPath: "aider", // or absolute path
  defaultModel: "gpt-4o",
  env: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  },
  observability: { sink },
});

const port = adapter.createLLMPort();

const result = await port.runAgent({
  taskType: "code-edit",
  messages: [
    {
      role: "user",
      content: "Add a docstring to the top-level function in main.py.",
    },
  ],
  tools: {}, // ignored; aider uses its own built-in tools
  providerExtras: {
    aider: {
      workingDirectory: "E:\\projects\\my-repo",
      files: ["main.py"],
      yesAlways: true,
    },
  },
});

console.log(result.text);
console.log(`Aider emitted ${sink.events.length} observability events`);
```

## Options

### `AiderAdapterOptions`

- `cliPath?: string` — Path to the aider binary. Defaults to `"aider"`.
- `defaultModel?: string` — Default model passed via `--model`. Optional.
- `defaultEditFormat?: string` — Default edit format passed via `--edit-format`. Optional.
- `env?: Record<string, string>` — Environment variables merged over `process.env`. Where you set `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.
- `observability?: { sink, source?, context? }` — Optional observability configuration.
- `timeoutMs?: number` — Subprocess timeout. Defaults to 30 minutes.

### `RunAgentOptions.providerExtras.aider` (required)

- `workingDirectory: string` — **Required.** The git repo aider operates in (the subprocess `cwd`).
- `files?: string[]` — Files to add to the aider chat context (positional args on the CLI).
- `model?: string` — Overrides `defaultModel` per call.
- `editFormat?: string` — Overrides `defaultEditFormat` per call.
- `yesAlways?: boolean` — Skip all confirmation prompts (`--yes-always`). Default `true`.
- `verbose?: boolean` — Pass `--verbose`. Default `false`.
- `mapTokens?: number` — Pass `--map-tokens N`. Optional.

## Non-runAgent methods

`generateText`, `generateStructured`, `streamText`, and `streamStructured` throw `AdapterInternalError`. Aider is an agent runtime, not a raw completion runtime. Consumers who need raw completions route those task types to an in-process adapter (`@llm-ports/adapter-openai`, `@llm-ports/adapter-anthropic`, etc.).

## Token usage and cost

For alpha.28, `usage` and `cost` are reported as zeros. Aider's stdout carries token counts as free-form text; downstream consumers who need accurate accounting should either subscribe to observability metadata via alpha.29's runtime instrumentation or scrape stdout using their own parser.

## License

MIT.
