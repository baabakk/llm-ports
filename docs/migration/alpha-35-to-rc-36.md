# alpha.35 to 1.0.0-rc.36

**This is the freeze.** After this release the shapes you build against stop moving, and a breaking change announces itself as a major version your dependency range refuses automatically. That protection is the whole reason for the number.

This page is being written as the release is built, so it grows. Everything landed so far is below.

```bash
pnpm add @llm-ports/core@1.0.0-rc.36
```

Upgrade every `@llm-ports/*` package together.

## What changed so far

| Change | Who it affects | Impact |
|---|---|---|
| `ToolDefinition.inputSchema` is optional | Code that **reads** the field | **TypeScript-strict break.** See below. |
| `inputJsonSchema` accepted instead | Anyone holding a JSON Schema already | Additive, with a real trade-off. |
| `transientAuthBackoffMs` removed from the OpenAI adapter's options | Nobody, as far as we can tell | **Removal.** See below. |
| The Codex and aider adapters stop discarding `instructions`, `tools` and assistant turns | Anyone using either | **A fix, and a behaviour change.** They now throw where they used to succeed quietly. |
| The Codex adapter defaults to a read-only sandbox | Anyone using it | **Behaviour change.** A call can no longer write files unless you ask it to. |

## The break: `ToolDefinition.inputSchema` is optional

A tool can now describe its parameters with a JSON Schema instead of a Zod schema, so exactly one of the two is required rather than `inputSchema` always being there. Supplying neither throws `ConfigError`, and so does supplying both.

**If you build tools and pass `inputSchema`, nothing changes.** The break is at the read site, and only under TypeScript's `exactOptionalPropertyTypes`, because the field now reads as `TParams | undefined`.

The shape that breaks is reading a tool's schema and handing it somewhere that expects Zod:

```ts
// Before: compiled.
// After: ZodTypeAny | undefined is not assignable to ZodTypeAny.
const jsonSchema = zodToJsonSchema(myTool.inputSchema);
```

Use the resolver rather than narrowing by hand, so the both-and-neither rules stay in one place:

```ts
import { resolveToolSchema } from "@llm-ports/core";

const resolved = resolveToolSchema(myTool, myTool.name);
if (resolved.kind === "zod") {
  // resolved.zod is a Zod schema
} else {
  // resolved.jsonSchema is the object the caller supplied
}
```

## Tool parameters from a JSON Schema

If a tool definition arrives over the wire, you no longer have to convert it into Zod so the adapter can convert it back:

```ts
await llm.runAgent({
  taskType: "assist",
  instructions: "You are a helpful assistant.",
  messages,
  tools: {
    lookup_invoice: {
      name: "lookup_invoice",
      description: "Look up an invoice by id",
      inputJsonSchema: schemaFromTheWire,
      execute: async (input) => findInvoice(input),
    },
  },
});
```

**What you give up, because it is not obvious.** This library carries no JSON Schema validator. The schema reaches the provider, whose own tool-calling enforces it where supported, and the model's arguments are handed to your `execute` **without local validation**. That is the same trade `generateStructured`'s `jsonSchema` makes, and the same advice follows: prefer `inputSchema` unless the schema genuinely came from somewhere else.

**A tool that takes no arguments still has to say so**, with an empty object schema. Omitting both fields is refused rather than treated as "no parameters", because the two are indistinguishable from a typo and the model would otherwise be told the tool accepts anything.

## `transientAuthBackoffMs` is gone from the OpenAI adapter

It existed so this project's own tests could skip a retry wait. It had no documented production use case, and publishing it at version 1 would have frozen it into the contract.

**If you were setting it**, you are the first we know of, and we would like to hear from you: open an issue and it comes back as a supported option with a stated purpose. The capability itself is unchanged, and the default backoff is still `500ms`, `1500ms`, `4500ms` between transient-401 retries.

## The subprocess adapters stop failing quietly

`@llm-ports/adapter-codex` and `@llm-ports/adapter-aider` accepted three things on a `runAgent` call and discarded all three without raising anything: the `instructions`, the `tools`, and every assistant turn in `messages`.

The effect was worst where it was least visible. A system with several agent roles, differing only by their system prompt and tool set, got the same generic model for every role, with a well-formed result and no error.

**What changes for you:**

- **`instructions` now reach the model**, composed ahead of the conversation.
- **The full transcript reaches the model**, with each turn labelled by role, rather than only the user turns.
- **`tools` are now refused with an error naming them**, rather than dropped. Neither CLI exposes a channel for caller-supplied tools today. If you were passing tools to these adapters, they were never reaching the model, and the call now tells you so.
- **The Codex adapter's sandbox defaults to `read-only`**, where it was `workspace-write`. A call whose output is a proposal should not be able to write files unless you ask. Pass `defaultSandbox` to opt out.

**The aider adapter is different and cannot be made the same.** It is a code editor with no read-only mode, and without `--yes-always` it waits for a confirmation a subprocess never supplies. So it still runs with confirmations auto-accepted, and **a call through it can modify files and commit**. That is a property of the tool, not a default we chose, and it is stated here because the two adapters now differ in a way that matters.

**Two new options on both adapters**, because neither could previously be invoked except as a bare executable on `PATH`:

- `cliArgsPrefix` places arguments before the generated ones, so `{ cliPath: "npx", cliArgsPrefix: ["codex"] }` works, as does any wrapper script.
- `defaultWorkingDirectory` supplies the working directory a call otherwise has to pass through a provider-specific options bag.

## Reading next

- [Tool use](/guides/tool-use) for the full picture on tools, including the methods that surface calls without executing them
- [What ships next](/v0-1-status) for the rest of this release
