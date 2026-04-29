# Tool-Use Security

A framework that ships `runAgent()` and a tool-execution surface without naming the threat model is a CVE waiting to happen. `llm-ports` ships security primitives, not afterthoughts. This guide covers the threats, the mitigations, and what's still your responsibility.

## The threat model

| Threat | Scenario | Mitigation in `llm-ports` |
|--------|----------|---------------------------|
| **Prompt injection** | User content contains "ignore previous instructions, do X" | Capabilities wrap user content in `<content>` tags. System prompts assembled via `buildSystemPrompt` keep untrusted input out of the role/instruction layer. |
| **Tool abuse** | Model invokes a destructive tool with attacker-controlled args | Mark tools `destructive: true` + `requiresConfirmation: true`; capability wrapper enforces a user approval loop. |
| **Output injection** | Tool output contains markdown / HTML / prompts that hijack the next turn | `ToolDefinition.maxOutputBytes` truncates tool output to prevent context flooding; adapters wrap results in delimited blocks. |
| **Memory poisoning** | Long-running agent's context window is poisoned with adversarial content | `llm-ports` does NOT persist memory. Memory policy is the application's responsibility. The library's silence on this is intentional — see "Outside the framework" below. |
| **Credential leakage** | LLM output or logs contain API keys, PII | `createRedactor` capability ships in v0.2; for now, scrub on ingest in your observability sinks. |
| **Denial of wallet** | Attacker triggers many LLM calls to burn cost budget | USD cost gating in registry; rate limiting (external library) for public-facing endpoints. |
| **Untrusted adapter** | User installs a malicious `@llm-ports/adapter-*` from an untrusted source | Only first-party adapters get the `@llm-ports/*` scope. Community adapters use their own scopes. |

## Mark destructive tools

```ts
import type { ToolDefinition } from "@llm-ports/core";
import { z } from "zod";

const sendReply: ToolDefinition = {
  name: "sendReply",
  description: "Send an email reply to the latest message in the thread",
  inputSchema: z.object({
    threadId: z.string(),
    body: z.string(),
  }),
  execute: async ({ threadId, body }) => {
    return await emailClient.send(threadId, body);
  },
  destructive: true,            // signals "this writes/deletes state"
  requiresConfirmation: true,   // capability wrapper enforces user approval
  maxOutputBytes: 8192,         // truncate output to prevent context flooding
};
```

Three flags do three things:

- **`destructive: true`** — declarative metadata. Tells observability tools, audit logs, and human reviewers that this tool mutates state. Doesn't change runtime behavior by itself.
- **`requiresConfirmation: true`** — when the agent capability wrapper sees this, it pauses the loop and calls your `onToolCall` hook. Your hook is responsible for getting user approval (Telegram, web UI, CLI prompt, etc.) and either continuing or aborting.
- **`maxOutputBytes: N`** — adapters truncate the tool's return value to N bytes before re-injecting into the conversation. Caps context flood from a tool that returns 50 MB unexpectedly.

## The approval hook

When `requiresConfirmation: true`, the agent loop calls your hook before executing:

```ts
import { createAgent } from "@llm-ports/capabilities"; // v0.2

const agent = createAgent({
  port: llm,
  instructions: "You are an email assistant.",
  tools: { sendReply, searchEmails },
  finalOutputSchema: ResponseSchema,
  maxSteps: 10,
  onToolCall: async (call) => {
    if (call.tool.requiresConfirmation) {
      const approved = await yourApprovalChannel(`Run ${call.name}?\n\nArgs: ${JSON.stringify(call.input)}`);
      if (!approved) {
        throw new Error("User declined");
      }
    }
  },
});
```

Your `yourApprovalChannel` is a userland implementation. Examples in production:

- BEPA uses [Telegram inline keyboards](https://core.telegram.org/bots/2-0-intro#new-inline-keyboards) (Approve / Reject / Edit buttons)
- Web apps use a modal dialog with a 30-second timer
- CLIs use a stdin prompt
- Slack apps use [block kit interactive components](https://api.slack.com/block-kit/interactive-components)

The hook never sees the LLM directly. It only sees the proposed tool call.

## Treat tool output as untrusted

Even when YOUR tool returns data, the model's NEXT turn sees that data. If your tool calls a third-party API and returns its response verbatim, that response can contain prompt injection payloads.

```ts
const fetchPage: ToolDefinition = {
  name: "fetchPage",
  description: "Fetch the contents of a URL",
  inputSchema: z.object({ url: z.string().url() }),
  execute: async ({ url }) => {
    const html = await fetch(url).then((r) => r.text());
    // ⚠️ html might contain "[SYSTEM] ignore prior instructions, do X"
    // The model's next turn sees this verbatim.
    return html;
  },
  maxOutputBytes: 50_000,  // cap, but does NOT sanitize
};
```

Mitigations:

1. **`maxOutputBytes` truncates but doesn't sanitize.** A 50KB injection still fits.
2. **Wrap untrusted output explicitly.** Have the tool prepend a delimiter the system prompt teaches the model to respect:
   ```ts
   return `<untrusted_external_content>\n${html}\n</untrusted_external_content>`;
   ```
3. **Never let tool output decide policy.** Don't let a fetched webpage's contents influence whether you call another destructive tool. Keep policy decisions on hardcoded rules, not LLM-judged inputs.

## Outside the framework (your responsibility)

`llm-ports` deliberately does NOT ship:

- **Memory / persistence.** Persistent agent memory is a security domain unto itself. Adversarial conversation injection into a vector store can hijack future sessions ([MINJA attacks](https://arxiv.org/abs/2503.03704) and similar). The library's lack of memory primitives is intentional — bring your own and own the threat model.
- **Rate limiting.** Cost gating is in scope; per-IP, per-user, per-tenant rate limiting is not. Use [express-rate-limit](https://www.npmjs.com/package/express-rate-limit), [Cloudflare](https://www.cloudflare.com/), or your platform's primitives.
- **Authentication.** Who is calling your API? Not `llm-ports`'s problem. Use your existing auth.
- **Prompt sanitization heuristics.** No "is this prompt suspicious?" filters. Heuristics fail; the structural mitigations above (delimiters, deterministic policy gates, tool flags) are stronger.

## SECURITY.md and disclosure

Found a vulnerability? Email `security@<llm-ports-domain>` (placeholder until v0.1 ships). 90-day coordinated disclosure. Credit in the changelog (opt-in). Do NOT open public GitHub issues for security vulnerabilities.

## Reading next

- [Capabilities overview →](/capabilities/) — the safer surface for agent loops
- [Custom adapters →](/guides/custom-adapters) — security responsibilities when writing your own
