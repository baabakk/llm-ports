# `@llm-ports/adapter-aider`

Drives the aider CLI as a subprocess and returns its answer through `runAgent`.

```bash
pnpm add @llm-ports/adapter-aider
```

## Read this first: a call can modify your files

**aider is a code editor.** It edits files in the working directory and commits them to git, and it does so as part of answering. That is what the tool is for, and this adapter does not change it.

It also cannot be made to stop. aider has no read-only mode, and without `--yes-always` it waits for an interactive confirmation that a subprocess never supplies, so the call hangs instead of being safe. The adapter therefore runs with confirmations auto-accepted.

**This is the one way it differs from [`adapter-codex`](/adapters/codex)**, which defaults to a read-only sandbox. If you need a model that proposes without acting, that adapter can do it and this one cannot. Point this adapter at a working tree you are willing to have changed.

## What it is for

It does **not** route model traffic. It starts an `aider` process, which uses whatever credentials and model configuration the operator has already given the CLI, and reads its output.

**It implements `runAgent` and nothing else.** The other port methods throw.

## Constructing it

```ts
import { createAiderAdapter } from "@llm-ports/adapter-aider";

const adapter = createAiderAdapter({
  defaultWorkingDirectory: "/srv/project",
});

const port = adapter.createLLMPort();
```

| Option | Default | What it does |
|---|---|---|
| `cliPath` | `"aider"` | The binary to run. |
| `cliArgsPrefix` | `[]` | Arguments placed **before** the generated ones, so the CLI can be reached indirectly. |
| `defaultWorkingDirectory` | none | Used when a call supplies no working directory of its own. |
| `defaultModel` | none | Passed through with `--model`. |
| `timeoutMs` | 30 minutes | How long to wait before terminating the process. |

## What it refuses

**Tools are refused**, with an error naming them. Verified against aider 0.86.2: it exposes no tool channel, and native support for one is an open request upstream rather than a shipped feature. Unlike the Codex adapter, this refusal is not waiting on a tool definition format; it is waiting on the tool.

This used to be a silent drop, along with `instructions` and every assistant turn. Fixed in `1.0.0-rc.36`.

## What a call sends

The CLI takes one `--message` argument, so the whole call is composed into it: the `instructions` first, then the conversation with each turn labelled by role. aider has no system-prompt flag, so that is the only channel available.

## What it reports back

**No cost**, because the CLI does not report what a run cost. Absent means unknown, not free.

**No token usage either.** aider emits plain text with no counts. The adapter reports zeros because the contract's `TokenUsage` requires numbers, and `undefined` would be the truthful answer. Treat zeros from this adapter as unknown rather than as a measurement; the gap is tracked and the contract is expected to grow a way to say so.

## Reading next

- [`@llm-ports/adapter-codex`](/adapters/codex), the other subprocess adapter
- [Tool use](/guides/tool-use)
