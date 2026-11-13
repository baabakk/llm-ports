---
"@llm-ports/core": patch
"@llm-ports/capabilities": patch
"@llm-ports/observability-contract": patch
"@llm-ports/telemetry-otel": patch
"@llm-ports/eval": patch
"@llm-ports/migrate": patch
"@llm-ports/integration-livekit": patch
"@llm-ports/adapter-openai": patch
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-google": patch
"@llm-ports/adapter-ollama": patch
"@llm-ports/adapter-vercel": patch
"@llm-ports/adapter-codex": patch
"@llm-ports/adapter-aider": patch
---

The release candidate for `1.0.0`. The surface is frozen here: only defect fixes
and documentation follow during the bake, and anything that changes a shape
arrives afterwards as a major version a dependency range can refuse.

All fourteen publishable packages move together, which is the last time they do.
The shared version number retires at `1.0.0`, after which each package moves on
its own so a fix to one adapter stops being a version bump for thirteen packages
that did not change.

The freeze claim was checked rather than asserted: core's public type surface
went from 218 exports to 220, with **none removed**, and the two additions are
`resolveToolSchema` and its result type. One field became optional,
`ToolDefinition.inputSchema`, which is a compile-time break at the read site and
is covered in the migration page. One field was removed from the OpenAI
adapter's options, `transientAuthBackoffMs`, which existed only to serve this
project's own tests.
