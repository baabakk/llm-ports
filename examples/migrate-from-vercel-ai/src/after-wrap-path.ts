/**
 * AFTER — Path A: WRAP your existing Vercel SDK code.
 *
 * Lowest-friction migration. Keep your existing model factories
 * (`anthropic("claude-haiku-4-5")`, `openai("gpt-4o-mini")`, etc.).
 * Hand them to `createVercelAdapter`. Now they flow through the
 * registry → fallback chains, USD cost gating, and quality tracking
 * are added automatically.
 *
 * Total code change: add the registry setup at app boot. Each call
 * site becomes a one-line search-and-replace from `generateText({
 * model, prompt, ... })` to `llm.generateText({ taskType, prompt, ... })`.
 *
 * Run: pnpm --filter @llm-ports/example-migrate-from-vercel-ai after-wrap
 */

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createRegistryFromEnv } from "@llm-ports/core";
import { createVercelAdapter } from "@llm-ports/adapter-vercel";

// One file in your app: create the adapter ONCE, wire it to all the
// Vercel-SDK model objects you currently use.
const vercelAdapter = createVercelAdapter({
  models: {
    "claude-haiku-4-5": anthropic("claude-haiku-4-5"),
    "gpt-4o-mini": openai("gpt-4o-mini"),
  },
  pricing: {
    "claude-haiku-4-5": { inputPer1M: 0.8, outputPer1M: 4.0 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  },
});

const registry = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_PRIMARY: "vercel|claude-haiku-4-5|cost:5/day",
    LLM_PROVIDER_BACKUP: "vercel|gpt-4o-mini|cost:10/day",
    LLM_TASK_ROUTE_CLASSIFY: "primary,backup",
    LLM_TASK_ROUTE_SUMMARIZE: "primary,backup",
  },
  adapters: { vercel: vercelAdapter },
});

const llm = registry.getPort();

// ─── Call sites — minimal change ───────────────────────────────

// BEFORE: const result = await generateText({ model, messages: [{ role: "user" as const, content: "..." }], maxOutputTokens: 50 });
// AFTER:  const result = await llm.generateText({ taskType: "classify", messages: [{ role: "user" as const, content: "..." }], maxOutputTokens: 50 });
async function classifyEmail(body: string) {
  const result = await llm.generateText({
    taskType: "classify", // routes via LLM_TASK_ROUTE_CLASSIFY
    messages: [{ role: "user" as const, content: `Classify this email's intent. Respond with one word: question | request | complaint | feedback.\n\n${body}` }],
    maxOutputTokens: 50,
  });
  return result.text.trim().toLowerCase();
}

async function summarizeArticle(text: string) {
  const result = await llm.generateText({
    taskType: "summarize",
    messages: [{ role: "user" as const, content: `Summarize this in 2 sentences:\n\n${text}` }],
    maxOutputTokens: 200,
  });
  return result.text;
}

const email = "Hi, I was double-charged on my subscription. Can you help?";
const article =
  "TypeScript was created by Anders Hejlsberg at Microsoft in 2012. It compiles to JavaScript and adds static typing for large codebases.";

console.log("classify:", await classifyEmail(email));
console.log("summarize:", await summarizeArticle(article));

// What you got for free with this path:
//
//   ✓ Fallback chain. If `claude-haiku-4-5` is unavailable or its $5/day
//     cap exhausts, calls fall through to `gpt-4o-mini` automatically.
//   ✓ USD cost gating. Per-provider hourly/daily/monthly caps enforced
//     before the API call.
//   ✓ Per-task routing. Each task type can have its own chain;
//     `classify` and `summarize` happen to share one here, but they
//     don't have to.
//   ✓ Cost / latency / usage on every call (see result.cost.totalUSD,
//     result.latencyMs, result.providerAlias).
//
// What you DIDN'T have to change:
//
//   ✗ Your `anthropic("...")` and `openai("...")` model factories.
//   ✗ Your dependency on `ai` and `@ai-sdk/*`.
//   ✗ Your call sites' shape — same prompt, same maxOutputTokens.
//
// The wrap path is the lowest-friction migration. You can stop here.
// Or read the migrate path next, where the call sites stop importing
// the Vercel SDK at all.
