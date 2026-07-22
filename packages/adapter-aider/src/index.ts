/**
 * @llm-ports/adapter-aider — public API.
 *
 * Subprocess-driven adapter for the Aider CLI (aider-chat). Runs
 * `aider --no-stream --yes-always --message "<prompt>" [files...]`,
 * captures stdout, and emits `@llm-ports/observability-contract`
 * lifecycle events. Consumers who wire this into their Registry route
 * agent-shaped task types (code edits, refactors, targeted rewrites)
 * to aider; short chains stay on in-process adapters.
 *
 * Shape A (passthrough governance) for alpha.28. The operator supplies
 * aider with its own provider credentials directly (via env vars,
 * `~/.aider.conf.yml`, or per-invocation flags); `@llm-ports` does NOT
 * route aider's LLM traffic. The port owns lifecycle observability and
 * orchestration; the LLM calls themselves fly directly from aider to
 * the provider. Shape B (aider talking to a local shim) is deferred
 * to alpha.29 per the 2026-07-21 architectural decision.
 */

export { createAiderAdapter } from "./adapter.js";
export type {
  AiderAdapter,
  AiderAdapterOptions,
  AiderRunAgentOptions,
} from "./adapter.js";
