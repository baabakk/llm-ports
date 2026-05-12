# `with-onretry` example

Wire the `onRetry` observability hook from `@llm-ports/adapter-openai` (and `@llm-ports/adapter-vercel`) to a console logger and a Prometheus-shaped counter sink.

## What the hook reports

`onRetry` fires whenever an adapter decides to retry an in-flight request for a known transient reason. The `RetryEvent.reason` discriminator is one of:

| Reason | What just happened | Adapter |
|---|---|---|
| `transient-auth` | OpenAI project-key burst-protection 401 (`sk-proj-*`). The key is valid; retry. | OpenAI |
| `capability-fallback` | Model rejected `temperature` / `json_object` / system message. Drop the offending parameter and retry. | OpenAI |
| `reasoning-starvation` | Model used the whole output budget on hidden reasoning. Retry with a 4× budget. | OpenAI, Vercel |
| `validation-feedback` | Structured output failed schema. Retry with the Zod issues injected back into the prompt. | OpenAI, Vercel |

The hook is fire-and-forget: throwing from it does NOT cancel the retry, and async hooks do NOT block it.

## Run

```bash
OPENAI_API_KEY=sk-... pnpm --filter @llm-ports/example-with-onretry start
```

## What you'll see

- Console lines like `[onRetry] validation-feedback attempt=0 provider=primary model=gpt-4o delayMs=0 (Validation failed after 1 attempt(s): ...)` when the model's first structured output didn't match the schema.
- A Prometheus exposition snapshot at the end:
  ```
  # HELP llm_ports_retry_total Total adapter retries by reason and provider.
  # TYPE llm_ports_retry_total counter
  llm_ports_retry_total{reason="validation-feedback",provider="primary",model="gpt-4o"} 1
  ```

## How to wire your own sink

```ts
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const adapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  onRetry: (event) => {
    // Log to pino / winston / datadog / OpenTelemetry / etc.
    log.warn({ event }, "llm_retry");
  },
});
```

Same option exists on `createVercelAdapter({ onRetry })`. `@llm-ports/adapter-anthropic` and `@llm-ports/adapter-ollama` do not currently surface retry events because they do not retry; the hook will land there in a future minor when retry behavior is added.
