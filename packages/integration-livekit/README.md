# @llm-ports/integration-livekit

Route a [LiveKit Agents](https://docs.livekit.io/agents/) voice agent through an `@llm-ports` `LLMPort`.

## What this adds, and what it does not

LiveKit already abstracts LLM providers. Its plugin layer covers many of them behind one `LLM` class, so **provider abstraction is not what this package gives you**, and claiming otherwise would be offering something the framework already has.

What LiveKit's LLM layer does not carry is **governance**:

- no fallback chain when a provider goes down
- no USD cost ceiling
- no per-provider budget or rate limit
- no task routing

Under `@llm-ports` all four are configuration. A revoked key stops being a silent total failure and becomes a walk to the next provider in the chain. Swapping provider to work around one that mishandles tool calls stops being a code change and a redeploy, and becomes an environment edit.

## Install

```bash
npm i @llm-ports/integration-livekit @llm-ports/core @livekit/agents
```

## Use

One constructor. Speech recognition, synthesis, turn detection, and the agent's own tools are untouched.

```ts
import { voice } from "@livekit/agents";
import { LlmPortsLLM } from "@llm-ports/integration-livekit";

const session = new voice.AgentSession({
  vad, stt, tts, turnDetection,
  llm: new LlmPortsLLM({
    port: registry.getPort(),
    taskType: "voice_coach",
    // Set this. See below.
    perAttemptTimeoutMs: 2000,
  }),
});
```

## Set `perAttemptTimeoutMs`

The library's default per-attempt timeout is tuned for batch work and is far longer than a conversation can absorb. Production voice pipelines run around 680 ms median end to end including speech recognition and synthesis, so an attempt allowed to run for tens of seconds is indistinguishable from a hang.

This is the one setting that actually governs realtime behaviour. Measured overhead of the library itself is negligible by comparison: routing through the Registry costs about **0.036 ms**, and each fallback hop about **0.33 ms**, against a 680 ms budget. See [`STREAM-CHAT-RESULTS.md`](../core/bench/STREAM-CHAT-RESULTS.md). What can break a conversation is a slow provider failing slowly, and the per-attempt timeout is what bounds that.

## The tool-use loop stays with LiveKit

This calls `LLMPort.streamChat`, which **surfaces** tool calls without executing them. LiveKit's `AgentSession` owns the loop and runs each tool's handler itself, exactly as its `chat()` contract expects. Nothing here ever invokes a tool; the definitions passed through carry a throwing `execute` so a loop that wandered into the wrong layer fails loudly rather than double-running your handler.

Tool schemas are converted **per provider attempt**, so a fallback provider is never handed a dialect prepared for the provider that just failed.

## Why "integration" and not "adapter"

Every `@llm-ports/adapter-*` package points **outward**, from the port to a provider. This points **inward**, from a framework into the port. Reusing "adapter" would invert its established meaning, so inbound packages take the `integration-` prefix.

## Requirements

`@livekit/agents` >= 1.6, and a `@llm-ports/core` >= 0.1.0-alpha.32 registry whose task chain uses an adapter implementing the optional `streamChat` method. `@llm-ports/adapter-openai` does, which also covers OpenAI-compatible endpoints via `baseURL`.

## License

MIT.
