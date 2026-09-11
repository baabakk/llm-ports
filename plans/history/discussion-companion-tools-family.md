# Ecosystem direction: companion tools packages family (`@llm-ports/tools-*`)

## TL;DR

Every consumer that runs `runAgent` with tools hand-rolls their own tool implementations: file I/O with path sandboxing, HTTP with SSRF protection, subprocess exec with shell-injection guards, web search with rate-limiting. The tool-CALLING protocol is normalized in `runAgent`; the tool IMPLEMENTATIONS are duplicated across the ecosystem. Path-traversal, SSRF, and shell-injection are the three most common classes of AI-agent security vulnerabilities documented in the wild. Every consumer solving them independently is a footgun worth centralizing.

Proposing a family of opt-in companion packages that carry the security-sensitive primitives once, with configurable policy hooks so each consumer can wire in its own policy values without reinventing the parsing / sanitization / rate-limiting logic.

Framing this as an ecosystem-direction discussion (not an issue) to invite consumers into the design.

## The pattern (mirrors `@llm-ports`'s existing architecture)

`@llm-ports` already has a "neutral core, batteries in opt-in companions" pattern for observability (per the alpha.27 discussion + the upcoming taxonomy work). The proposal is to apply the same pattern to tool implementations:

| Existing (observability) | Proposed (tools) |
|---|---|
| `@llm-ports/core` (neutral) | `@llm-ports/core` (unchanged; no tool implementations) |
| `@llm-ports/telemetry-otel` (opt-in) | `@llm-ports/tools-fs` (opt-in) |
| `@llm-ports/telemetry-sqlite` (opt-in) | `@llm-ports/tools-http` (opt-in) |
| `@llm-ports/eval` (opt-in) | `@llm-ports/tools-exec` (opt-in) |
| | `@llm-ports/tools-search` (opt-in) |

Each companion exports `ToolDefinition[]` matching the port's existing tool-definition shape, so consumers hand the array directly to `runAgent`'s `tools` field. Or they import the primitive helpers directly and wrap them in consumer-specific `ToolDefinition`s.

## The proposed packages (initial family)

### `@llm-ports/tools-fs`

Sandboxed file I/O: `writeFile`, `readFile`, `listFiles`, `deleteFile`.

- Configurable root path.
- Optional `ownedPaths?: (relPath: string) => boolean` predicate for per-tool policy.
- Optional `onToolCall?: (event: ToolCallEvent) => void` hook so consumers with audit-trail needs (receipts, workflow-determinism logs) can wire in.
- Path sanitization covers `..` traversal, absolute-path escapes, symlink resolution, Windows drive-letter escapes.

### `@llm-ports/tools-http`

Sandboxed HTTP client: `httpGet`, `httpPost`.

- Configurable URL allowlist + blocklist.
- SSRF protection: reject requests to private IP ranges (RFC 1918, link-local, IPv6 ULA), DNS-rebind protection via connect-time IP re-validation, redirect-target validation (follow only within allowlist).
- Rate-limit hooks per consumer-defined key.

### `@llm-ports/tools-exec`

Sandboxed subprocess exec.

- Command allowlist required.
- PATH stripping.
- `execFile`-shaped API (argument array), no shell interpolation.
- Timeout and output-size caps.
- Signal semantics for cancellation.

### `@llm-ports/tools-search`

Provider-agnostic web search with a canonical result shape.

- Result shape: `{ title, url, snippet, published_at?, source }`.
- Rate-limit hooks.
- Provider-alias mechanism (Serper, Tavily, Brave, etc.) with a default policy for choosing among configured providers.

## What core carries vs what companions carry

**Core (unchanged):**
- The `runAgent` loop (tool-call protocol normalization across providers, `maxSteps`, routing).
- Provider adapters.

**Companions carry:**
- Security-sensitive primitives (path sanitization, URL parsing, argument-array shaping, rate-limiting logic).
- Well-tested defaults for the security-critical bits.
- Hooks so consumers can inject policy and audit.

**Companions do NOT carry:**
- Per-consumer policy values (which paths to allow, which URLs to allow, which commands to allow, which providers to route to).
- Audit trail integration. `onToolCall` is a hook; the sink is the consumer's.
- Multi-tenant isolation semantics. Consumers wire tenant-specific configurations at consumer level; the companion enforces whatever config it's handed.
- Consumer-specific write guards, ownership predicates, or file-store integrations. Consumers who have these keep their own implementations; the companion is a reference implementation, not a drop-in replacement.

## Why this belongs in `@llm-ports`'s orbit (not somewhere else)

- **`runAgent` is where the tools are consumed.** Any tool primitives ship in the ecosystem that produces the tool consumer. Packaging them under `@llm-ports/tools-*` puts them next to the code that calls them.
- **Security posture centralization.** Getting path traversal / SSRF / shell injection right ONCE and having a well-tested reference implementation is genuine ecosystem value. Every consumer that adopts the companions inherits the security posture without auditing their own hand-rolled equivalents.
- **Same architecture family as observability companions.** `@llm-ports/tools-*` and `@llm-ports/telemetry-*` are shaped identically: opt-in, policy-configurable, cross-consumer neutral. Consistent architecture across the family is a maintenance win.
- **`runAgent`'s tool-definition shape is already the natural interface.** No new abstraction; companions export existing types.

## Explicit non-goals

- **Not replacing consumer-side policy-bearing tools.** For example, one downstream consumer (ADW / agentic-dev-orchestrator) has a hand-rolled `fs.ts` that encodes multi-team ownership policy, receipts, and integration with a scoped file-store. That stays. The companion package is a reference implementation for the primitive security-sensitive bits; it does not (and cannot) carry the consumer's policy.
- **Not a new abstraction over provider tool APIs.** The `ToolDefinition` shape is already normalized in `@llm-ports/core`. Companions export values of that existing shape.
- **Not a subprocess-based agent runtime.** That's a different substrate (a proposed `@llm-ports/adapter-claude-code` / `@llm-ports/adapter-codex` family running an agent CLI as an alternate runtime). See the alternate-agent-adapter proposal (filed separately) for that direction.

## Questions for the ecosystem

1. **Which packages should ship first?** File I/O is the most common; HTTP is second; exec and search are lower priority. Interested in hearing what each consumer's actual tool-use surface looks like.
2. **What should the security-primitive set for each package cover?** For `tools-fs`: is symlink resolution required, or is refusing all symlinks acceptable? For `tools-http`: what's the right SSRF policy default (reject-all-private vs allow-with-explicit-allowlist)? For `tools-exec`: is `stdin` support in scope?
3. **What's the right shape for the audit-trail hook?** `onToolCall(event)` receiving a typed `ToolCallEvent` is the natural mirror of the observability plan's `OnEvaluation` hook. Is that shape sufficient, or do consumers need pre-call + post-call + on-error separately?
4. **Should the companions ship default `ToolDefinition` arrays that a consumer can hand straight to `runAgent`, or only the primitive helpers?** Both are viable; both is probably the answer, but the ergonomics matter.
5. **Are there consumers who want THIS but with different tool sets (e.g., `@llm-ports/tools-git` for git operations, `@llm-ports/tools-db` for SQL execution)?** If yes, the same architecture generalizes; naming the family shape up front helps.

## What this discussion is NOT

Not a commitment to ship. Not an approved plan. An ecosystem-direction discussion to gauge interest, converge on the primitive set, and let consumers whose policy shapes are known contribute the "what's the right security default here" answers. Implementation TDs land per package once the discussion converges.

## Related architectural direction (separate)

A companion family in a different direction: alternate agent adapters (`@llm-ports/adapter-claude-code`, `@llm-ports/adapter-codex`) as subprocess-driven agent runtimes that implement the port's `runAgent` interface. Different substrate, different design surface. Will file separately if there's interest.

## Provenance

Cross-consumer review pass 2026-07-21 (BEPA + ADW consumers reporting). Both consumers reported hand-rolling variants of the tools listed above, and one consumer's review pass specifically flagged the "each consumer gets path-traversal guards subtly wrong" concern as an ecosystem-level footgun worth centralizing.
