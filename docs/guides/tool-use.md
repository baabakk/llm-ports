# Tool use: letting a model call your functions

A tool is a named function you hand the model, with a schema describing its input. The model decides when to call it, the library executes it, feeds the result back, and loops until the model answers in words. That loop is `runAgent`.

This page is the registration reference. For gating which tools may run without a human saying yes, read [Tool-Use Security](/guides/security) afterwards.

## A tool, in full

```ts
import { z } from "zod";
import type { ToolDefinition } from "@llm-ports/core";

const getOrderStatus: ToolDefinition = {
  name: "get_order_status",
  description: "Look up the current status of a customer order by its id.",
  inputSchema: z.object({
    orderId: z.string().describe("The order id, e.g. ORD-10293"),
  }),
  execute: async ({ orderId }) => {
    const row = await db.orders.findById(orderId);
    return { status: row.status, shippedAt: row.shipped_at };
  },
};
```

Four fields are required and three are optional.

| Field | Required | What it does |
|---|---|---|
| `name` | yes | The name the model calls. Use the same string as the record key below |
| `description` | yes | How the model decides whether this is the right tool. Write it for a reader who cannot see your code |
| `inputSchema` | yes | A Zod schema. The adapter converts it to the provider's own tool-schema format |
| `execute` | yes | Your function. Receives the parsed input, returns anything JSON-serialisable |
| `destructive` | no | Marks the tool as writing or deleting state |
| `requiresConfirmation` | no | Marks the tool as needing a human yes before it runs |
| `maxOutputBytes` | no | Truncates the returned output, so one chatty tool cannot flood the context |

`destructive` and `requiresConfirmation` are **declarations, not enforcement**. Nothing in the port refuses to run a tool because it is marked destructive; the marks exist so your own gate can act on them. [Tool-Use Security](/guides/security) shows the wrapper that does the acting.

`execute` returning a rejected promise is not special-cased: the error propagates out of `runAgent`. If a tool failing is a normal outcome in your domain, return a value describing the failure instead of throwing, so the model can react to it.

## Running the loop

Tools go in as a record, keyed by name:

```ts
const result = await llm.runAgent({
  taskType: "support",
  instructions: "You are a support agent. Answer using the tools when a fact is needed.",
  messages: [{ role: "user", content: "Where is ORD-10293?" }],
  tools: {
    get_order_status: getOrderStatus,
    issue_refund: issueRefund,
  },
  maxSteps: 10,
});
```

`taskType`, `instructions`, `messages` and `tools` are required. `maxSteps` defaults to 10, and one step is one model call plus any tools it asked for.

Everything else you can pass to an ordinary call works here too: `temperature`, `maxOutputTokens`, `signal`, `reasoningEffort`, `forceProviderAlias`, `perAttemptTimeoutMs`, `cacheControl` and `providerExtras`.

## What comes back

```ts
result.text;              // the model's final answer, in words
result.toolCalls;         // [{ name, input, output }], in call order
result.messages;          // the full conversation, including tool turns
result.stepsTaken;        // how many model calls it took
result.terminationReason; // "completed" | "max_steps" | "stopped_by_user"
result.usage;             // tokens, aggregated across every step
result.cost;              // USD, or undefined when the model has no known price
result.modelId;
result.providerAlias;     // which provider actually served it
result.latencyMs;
```

**Check `terminationReason` before trusting `text`.** `"completed"` means the model stopped because it had an answer. `"max_steps"` means it was still working when the budget ran out, so `text` is whatever it had said last, which may be nothing useful. Treating the two alike is the most common way an agent silently half-answers.

`toolCalls` carries the input the model supplied and the output your function returned, which makes it the record to log when you need to explain later why the agent did what it did.

## Cost and usage are aggregated for you

`usage` and `cost` cover the whole run, not the last step. A five-step agent reports the sum, which is what a budget gate needs. Per-step figures are available through the observability hooks if you need them; see [Observability](/concepts/observability).

## Failover and your schemas

If the first provider fails mid-run, the registry moves to the next one in the chain. **Your Zod schema is converted to the provider format by the adapter that serves each attempt**, never converted once and reused, because two providers do not accept the same tool-schema dialect. You write the schema once and it stays correct across a chain of providers that disagree.

One consequence worth knowing: a provider that rejects your schema outright rejects it on its own attempt, and the chain walks on. A schema every provider rejects fails everywhere, which is a schema problem rather than a provider problem.

## Which adapters run agents

| Adapter | `runAgent` |
|---|---|
| `adapter-openai`, `adapter-anthropic`, `adapter-google`, `adapter-ollama` | Multi-turn, native tool calling |
| `adapter-vercel` | Multi-turn through the Vercel AI SDK's own loop, since `0.1.0-alpha.8` |
| `adapter-codex`, `adapter-aider` | `runAgent` only. These drive a coding-agent command line, which owns its own tools; the other port methods throw |

## When you want the calls but not the execution

Sometimes the loop is not ours to run. An OpenAI-compatible HTTP surface, for instance, has to hand the tool calls to whoever called it and let them decide. Two methods do that, and **neither executes anything**:

| Method | Shape | Use it when |
|---|---|---|
| `streamChat` | Yields text as it arrives, then the assembled tool calls | The caller is streaming to a user or a socket |
| `generateChat` | Returns one complete assistant turn | The caller wants the whole turn before deciding, or is not streaming at all |

`generateChat` was added in `0.1.0-alpha.35`, because until then the only non-streaming option was `runAgent`, which runs the loop for you.

```ts
const turn = await llm.generateChat({ taskType: "assist", messages, tools });

if (turn.toolCalls.length > 0) {
  for (const call of turn.toolCalls) {
    // call.toolName, call.toolCallId,
    // call.args (parsed) and call.rawArguments (as the model sent them)
  }
} else {
  console.log(turn.text);
}
```

**Tool arguments are parsed where they parse.** Where a model emits arguments that are not valid JSON, `args` is left undefined and `rawArguments` keeps the original text, rather than the call failing. A caller owning the loop is better placed to decide what a malformed argument means than we are.

**Both methods are optional on the port**, unlike `generateText` and the rest. Not every adapter implements them, so the registry checks which aliases do and filters the chain to those. A chain mixing adapters that do and do not support the method still works, and one where none do throws `NoProvidersAvailableError` naming each alias, rather than failing on the first attempt with a confusing type error.

```ts
registry.aliasSupportsGenerateChat("fast");   // ask before routing, if you need to
```

**Optional in the type as well as at runtime**, which means two checks rather than one. The compiler requires the first:

```ts
if (!llm.generateChat) throw new Error("this port does not offer generateChat");
const turn = await llm.generateChat({ taskType, messages, tools });
```

The second is whether any alias in the chain implements it, and the registry does that one for you: it filters the chain and throws `NoProvidersAvailableError` naming each alias when none qualify.

## A worked, runnable example

[`examples/agent-with-approval`](https://github.com/baabakk/llm-ports/tree/main/examples/agent-with-approval) registers three tools, one read-only, one destructive and auto-approved, one destructive and requiring confirmation, and runs all three scenarios end to end.
