---
"@llm-ports/observability-contract": minor
---

**`combineSinks`: one sink that forwards to several, with failures isolated per sink.**

`Instrumentation` accepts a single sink, so a consumer wanting two, such as an incident logger beside the OpenTelemetry bridge, had to write the fan-out themselves.

The reason to ship ours is that the obvious version is wrong. A loop calling `emit` on each sink stops at the first one that throws, and the symptom is events quietly missing from the later sinks rather than an error anyone sees. `combineSinks` isolates each sink, including a rejected promise from an asynchronous `emit`, which would otherwise surface as an unhandled rejection in a process that is only trying to record what happened. That matches the promise the rest of this contract already makes: observability never breaks the call it observes.

```ts
instrumentation: { sink: combineSinks(otelSink, incidentLoggerSink) }
```

Given one sink it returns that sink unchanged, and given none it is a no-op. From `TD-LLMPORTS-NO-SINK-COMPOSITION`; BEPA's own implementation was the reference, including the failure isolation.
