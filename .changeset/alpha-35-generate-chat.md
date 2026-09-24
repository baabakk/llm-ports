---
"@llm-ports/core": minor
"@llm-ports/adapter-openai": minor
---

**`generateChat`: tool calls surfaced without streaming.**

The shape that had no implementation path. `runAgent` accepts tools and runs the loop itself, so it executes what the caller meant to execute and resolves once at the end. `streamChat` surfaces tool calls without executing them, which is the right semantics, but only as a stream. A request with tools and `stream: false`, **the default for most agent frameworks and for the OpenAI SDK's own tool loop**, could only be faked by draining a stream and reassembling it, or served by silently dropping the caller's tools.

```ts
const result = await llm.generateChat({
  taskType: "chat",
  messages,
  tools: { get_weather },
});

result.toolCalls;   // assembled, and never executed by this library
result.stopReason;  // "tool_calls" or the provider's own finish reason
result.text;        // empty when the model only asked for tools
```

**Read `stopReason` before trusting `text`.** A turn that stopped to call a tool and a turn that finished answering are different things, and an empty `text` alongside tool calls is the ordinary case rather than a failure.

Options are identical to `streamChat`, so a call moves between the two by changing the method name. A tool call whose arguments are not valid JSON reports `args` as `undefined` with `rawArguments` intact, rather than failing the turn.

**Optional on the port, like `streamChat`.** An adapter that cannot serve it omits the method, and the registry filters those providers out of the chain and names them in the failure when none can serve it, instead of failing mid-call with a missing-function error. Detect support with `typeof port.generateChat === "function"`. Implemented here for `adapter-openai`.

**One strict-mode note.** The observability `operation` field and the instrumentation `method` field each gain `"generateChat"` as a possible value. Code that switches exhaustively over either union sees a new case, which is the only way a new method can be reported at all.

From `TD-LLMPORTS-NO-NONSTREAMING-CHAT-WITH-TOOLS`, raised by the RLM gateway, whose OpenAI-compatible surface was accepting client tool definitions and discarding them because no port method could carry them.
