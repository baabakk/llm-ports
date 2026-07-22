/**
 * @llm-ports/adapter-codex — public API.
 *
 * Subprocess-driven adapter for OpenAI Codex CLI. Runs `codex exec`
 * with the `--json` flag, parses the JSON event stream, and emits
 * `@llm-ports/observability-contract` events. Consumers who wire
 * this into their Registry route agent-shaped task types (long-horizon
 * tool use, code operations) to codex; short chains stay on
 * in-process adapters.
 *
 * Shape A (passthrough governance) for alpha.28. The operator supplies
 * codex's OpenAI credentials directly (via env vars or a
 * pre-authenticated `~/.codex/auth.toml`); `@llm-ports` does NOT
 * route codex's LLM traffic. Shape B (codex talking to a local
 * Responses gateway) is not on the roadmap per the 2026-07-22
 * architectural decision.
 */

export { createCodexAdapter } from "./adapter.js";
export type { CodexAdapter, CodexAdapterOptions, CodexRunAgentOptions } from "./adapter.js";
