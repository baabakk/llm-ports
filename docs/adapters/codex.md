# `@llm-ports/adapter-codex`

Drives the OpenAI Codex CLI as a subprocess and returns its answer through `runAgent`.

```bash
pnpm add @llm-ports/adapter-codex
```

## What it is for, and what it is not

This adapter does **not** route model traffic. It starts a `codex exec` process, which uses whatever credentials the operator has already given the CLI, and reads its output. The governance you get from this library around it is the port surface, the observability events and the retry and failover behaviour of the registry. The model call itself happens inside the CLI.

**It implements `runAgent` and nothing else.** `generateText`, `generateStructured`, `streamText` and `streamStructured` throw, because a coding-agent command line does not map onto them. Route that traffic to an in-process adapter.

## Constructing it

```ts
import { createCodexAdapter } from "@llm-ports/adapter-codex";

const adapter = createCodexAdapter({
  defaultWorkingDirectory: "/srv/project",
  defaultSandbox: "read-only",
});

const port = adapter.createLLMPort();
```

| Option | Default | What it does |
|---|---|---|
| `cliPath` | `"codex"` | The binary to run. |
| `cliArgsPrefix` | `[]` | Arguments placed **before** the generated ones, so the CLI can be reached indirectly. |
| `defaultWorkingDirectory` | none | Used when a call supplies no working directory of its own. |
| `defaultSandbox` | `"read-only"` | `read-only`, `workspace-write` or `danger-full-access`. |
| `defaultModel` | none | Passed through with `-m`. |
| `timeoutMs` | 30 minutes | How long to wait before terminating the process. |

**`cliArgsPrefix` exists because `cliPath` alone assumes a bare executable on `PATH`.** That excludes `npx codex`, a wrapper script, a shim inside a container, and on Windows every `.cmd`, since Node refuses to spawn one without a shell.

```ts
createCodexAdapter({ cliPath: "npx", cliArgsPrefix: ["codex"] });
```

## The sandbox default is read-only, deliberately

A call whose output is a proposal should not be able to write files unless you ask for that. `workspace-write` and `danger-full-access` are available and are opt-in.

If your architecture routes consequential action through an approval gate, leave this alone. The point of such a gate is that the model proposes and something else decides, and a model that can edit the working tree has already decided.

## What it refuses, and why that is the feature

**Tools are refused**, with an error naming them. The CLI exposes caller-supplied tools over MCP, which needs tool definitions to travel as JSON Schema, and that arrived in `1.0.0-rc.36`; the MCP transport itself has not. Until it does, a tool passed here would reach nothing.

This used to be a silent drop. Before `1.0.0-rc.36` the adapter accepted `instructions`, `tools` and every assistant turn in `messages`, and discarded all three without raising anything, so an agent with a role prompt and eight tools ran as a generic model with none and reported success. That is fixed, and the refusal is the visible half of the fix.

## What a call sends

The CLI takes one prompt argument, so the whole call is composed into it: the `instructions` first, then the conversation with each turn labelled by role. Nothing is dropped. If something cannot be carried, the call throws rather than proceeding without it.

## What it reports back

**No cost.** The CLI does not say what a run cost and this adapter has no pricing table, so cost is absent rather than zero. An absent cost means unknown; a zero would be indistinguishable from a free call.

**Token usage where the CLI reports it**, taken from its JSON event stream.

**`stepsTaken` is 1**, because one invocation is one step from the port's point of view. It previously reported the number of output lines, which moved with how talkative the CLI happened to be.

## Reading next

- [`@llm-ports/adapter-aider`](/adapters/aider), the other subprocess adapter, which differs in one way that matters
- [Tool use](/guides/tool-use) for what these adapters do and do not do with tools
