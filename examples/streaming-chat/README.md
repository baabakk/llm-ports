# `@llm-ports/example-streaming-chat`

Three Express routes that cover the most common LLM UX patterns: one-shot chat, Server-Sent Events streaming, and a tool-augmented agent. Total Express glue: ~30 lines. Total handler logic: ~10 lines per route. **A production chat backend is mostly LLM plumbing, and llm-ports keeps the plumbing thin.**

## Run it

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# Optional fallback: export OPENAI_API_KEY=sk-...

pnpm --filter @llm-ports/example-streaming-chat start
# → Streaming chat example listening on http://localhost:3000
```

In another terminal:

### One-shot chat

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the capital of France?"}]}'
```

```json
{
  "content": "Paris.",
  "usage": { "inputTokens": 32, "outputTokens": 3, "totalTokens": 35 },
  "cost": 0.0000284,
  "provider": "primary",
  "model": "claude-haiku-4-5"
}
```

### Server-Sent Events streaming

```bash
curl -N -X POST http://localhost:3000/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Count from 1 to 10."}]}'
```

```
data: {"delta":"1, "}

data: {"delta":"2, "}

data: {"delta":"3, "}

...

event: done
data: {}
```

### Tool-augmented agent

```bash
curl -X POST http://localhost:3000/chat/agent \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Where is order ORD-1234?"}]}'
```

```json
{
  "content": "Order ORD-1234 has shipped. Estimated delivery: 2026-05-08.",
  "toolCalls": [
    { "name": "lookupOrder", "input": { "orderId": "ORD-1234" }, "output": { "status": "shipped", "eta": "2026-05-08" } }
  ],
  "stepsTaken": 2,
  "terminationReason": "completed",
  "usage": { "inputTokens": 280, "outputTokens": 25, "totalTokens": 305 },
  "cost": 0.000242,
  "provider": "primary"
}
```

## Browser-side: consuming the SSE stream

The `/chat/stream` route is consumable from any browser via the [EventSource](https://developer.mozilla.org/docs/Web/API/EventSource) API. Sketch:

```ts
const res = await fetch("/chat/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: history }),
});

const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value);
  const lines = buffer.split("\n\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const { delta } = JSON.parse(line.slice(6));
      appendToUI(delta); // append to your chat bubble
    }
  }
}
```

## What each route demonstrates

| Route | llm-ports method | Why use this shape |
|---|---|---|
| `POST /chat` | `generateText` | Fastest path. Use when you don't need real-time output. |
| `POST /chat/stream` | `streamText` | Real-time UX for chat UIs. The `for await (const chunk of ...)` loop is the same shape regardless of provider. |
| `POST /chat/agent` | `runAgent` | When the assistant might need to call tools (DB lookups, API calls). Multi-turn loop terminates on `completed` / `max_steps` / `stopped_by_user`. |

All three share the same registry, the same fallback chain (Anthropic primary → OpenAI backup), and the same USD cost gating.

## Production-shape extensions

What this example doesn't do but a real app would:

- **Persistence.** Conversations are not stored. A real chat backend writes each message to a DB and includes the full history when calling the LLM.
- **Auth.** No authentication on the routes; in production add JWT / session middleware before the handlers.
- **Rate limiting.** `cost:10/day` caps per-provider total spend, but per-user rate limiting (e.g. 10 messages/min/user) is a separate concern handled at the Express middleware layer.
- **Tool security.** The `lookupOrder` tool is read-only and safe. For destructive tools (cancel-order, refund), see [`examples/agent-with-approval`](../agent-with-approval/) which demonstrates the `destructive` and `requiresConfirmation` flags.
- **Error handling.** The example surfaces errors as 500s. Typed errors from llm-ports (`ProviderUnavailableError`, `BudgetExceededError`, `NoProvidersAvailableError`) carry enough info to render distinct UX (retry vs. show "limit reached" vs. show fallback message).

## Compare to alternatives

The same three routes in different libraries:

| Library | What changes |
|---|---|
| Direct `@anthropic-ai/sdk` | You'd reimplement: SSE-friendly chunk extraction, tool-call extraction, cost computation, multi-turn message normalization. ~3-4× the code. |
| Vercel AI SDK (`streamText` from `ai`) | Similar streaming shape, but no fallback chain, no USD cost gating, and `runAgent` would need bolt-on logic for tools. |
| LangChain `ChatModel` | Different abstraction — you'd compose chains. The agent route in particular requires more ceremony (LangChain agents have richer state but heavier setup). |

The shape of this example — three routes that any TypeScript dev recognizes — is the test of whether the library actually saves you time. Each route is ~10 lines because the registry, retries, fallback, and cost gating are all under the surface.
