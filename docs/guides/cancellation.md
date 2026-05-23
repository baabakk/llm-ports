# Cancellation with `AbortSignal`

Shipped in `0.1.0-alpha.6`. Every `LLMPort` method accepts a `signal?: AbortSignal` that's threaded through to the provider SDK's fetch options. Calling `controller.abort()` cancels the in-flight HTTP request, not just the JS await — so the LLM call doesn't keep running and billing tokens after the user clicks "cancel".

## The contract

```ts
const controller = new AbortController();

const promise = llm.generateText({
  taskType: "screen_analyze",
  prompt: [{ type: "text", text: "Is this a login form?" }, screenshotBlock],
  signal: controller.signal,
});

// Later: user clicks cancel, or a timeout fires
controller.abort();

// promise rejects with signal.reason; the HTTP request to OpenAI/Anthropic/Google
// is cancelled mid-flight.
```

This works on `generateText`, `generateStructured`, `streamText`, `streamStructured`, and `runAgent`. For `runAgent`, the signal is also re-checked between agent steps so cancellation propagates mid-loop, not just at entry.

## Two checks, per call

When `signal` is supplied, the adapter performs two abort checks:

1. **Entry-time** (`throwIfAborted`): If `signal.aborted` is already true when the port method is called, the adapter throws immediately and never invokes the SDK. This is the cheap path — useful when a sequence of calls runs in a loop and an early one already exhausted the budget.

2. **Mid-flight**: The signal is threaded through to the SDK's request options. If `controller.abort()` fires while the HTTP request is in flight, the underlying fetch is cancelled.

The error you catch is whatever you passed to `controller.abort(reason)`. If you called `controller.abort()` with no argument, you get a `DOMException("AbortError")`.

## Per-adapter behavior

| Adapter | `signalSupport` | What happens when `controller.abort()` fires mid-flight |
|---|---|---|
| `@llm-ports/adapter-openai` | `entry+inflight` | OpenAI SDK cancels the fetch; promise rejects with `signal.reason` |
| `@llm-ports/adapter-anthropic` | `entry+inflight` | Anthropic SDK cancels the fetch (`messages.create` and `messages.stream`) |
| `@llm-ports/adapter-google` | `entry+inflight` | `@google/genai` cancels the `generateContent` fetch |
| `@llm-ports/adapter-vercel` | `entry+inflight` | Vercel `abortSignal` field on `generateText`/`streamText` |
| `@llm-ports/adapter-ollama` | `entry-only` | Entry-time check only — the call still runs to completion on the Ollama daemon (see caveat below) |

### Ollama caveat

`ollama-js` does NOT expose a per-call `AbortSignal`. The `Ollama` client class has a coarse `abort()` method that cancels ALL in-flight requests on the client, which is too blunt for per-call cancellation. The adapter honors `options.signal` at entry (`throwIfAborted`) but cannot cancel a request once it's flying. The call keeps running on the daemon until it completes.

Tracking upstream for ollama-js v0.7+. When the SDK exposes a per-call signal, the adapter will upgrade to `entry+inflight` without any consumer-facing change.

## Patterns

### Timeout-based cancellation

```ts
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(new Error("timeout: 10s")), 10_000);

try {
  const result = await llm.generateText({
    taskType: "describe",
    prompt: [...],
    signal: controller.signal,
  });
  return result.text;
} finally {
  clearTimeout(timeoutId);
}
```

Or use the modern `AbortSignal.timeout`:

```ts
await llm.generateText({
  taskType: "describe",
  prompt: [...],
  signal: AbortSignal.timeout(10_000),
});
```

### User-driven cancellation in a UI

```ts
// In your component:
const controllerRef = useRef<AbortController | null>(null);

async function describe(image: Uint8Array) {
  controllerRef.current?.abort(); // cancel any prior call
  controllerRef.current = new AbortController();
  try {
    const result = await llm.generateText({
      taskType: "describe",
      prompt: [textBlock, { type: "image", source: { kind: "base64", mediaType: "image/png", data: btoa(image) } }],
      signal: controllerRef.current.signal,
    });
    setOutput(result.text);
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") return; // user cancelled
    throw err;
  }
}

function handleCancel() {
  controllerRef.current?.abort();
}
```

### Combining multiple signals

```ts
import { anySignal } from "your-utility"; // or hand-roll

const userCancel = new AbortController();
const timeout = AbortSignal.timeout(30_000);
const combined = anySignal([userCancel.signal, timeout]);

await llm.generateText({ taskType: "x", prompt: "...", signal: combined });
```

Node 20+ ships `AbortSignal.any([signal1, signal2])`. On older Node, the standard utility is a small helper that creates a new controller and forwards `abort()` from any source signal.

### `runAgent` cancellation between steps

`runAgent` is the most useful place for cancellation — agent loops can run for many steps and minutes. The adapter re-checks `throwIfAborted` between each step, so cancellation propagates mid-loop:

```ts
const controller = new AbortController();
// User clicks cancel after step 3:
controller.abort();
// Step 4 throws at entry; the in-flight step-3 HTTP request also gets cancelled.

await llm.runAgent({
  taskType: "research",
  instructions: "...",
  messages: [...],
  tools: { search: searchTool },
  maxSteps: 20,
  signal: controller.signal,
});
```

### Streaming + cancellation

```ts
const controller = new AbortController();

try {
  for await (const chunk of llm.streamText({
    taskType: "narrate",
    prompt: "...",
    signal: controller.signal,
  })) {
    if (userPressedEscape()) {
      controller.abort();
      break;
    }
    write(chunk);
  }
} catch (err) {
  if ((err as { name?: string }).name === "AbortError") return;
  throw err;
}
```

## What it does NOT do

- **Refund tokens already billed.** Once the provider has started generating, the request is on the meter. Aborting saves the **remainder** of the call, not what's already produced.
- **Retroactively cancel previous calls.** A single `controller.abort()` only affects calls that received that specific signal.
- **Work on `adapter-ollama` mid-flight.** Until ollama-js exposes a per-call signal, you get the entry check only. See caveat above.

## Reading next

- [Multi-provider routing](/guides/multi-provider) — how cancellation interacts with fallback chains
- [Cost gating](/guides/cost-gating) — the session-scoped budget gate (`Registry.openCostSession`) is the other half of cost-control
- The contract test suite's `signalSupport` flag — every adapter declares its support level so future adapters inherit the test coverage
