/**
 * AFTER — Path B: MIGRATE off Vercel SDK to native llm-ports adapters.
 *
 * Slightly more work than the wrap path; in return, you remove the
 * `ai` + `@ai-sdk/*` dependencies entirely. Use this path if you don't
 * already have a strong reason to stay on Vercel's SDK (e.g. you're not
 * also using `streamUI` or other Vercel-specific React features).
 *
 * The setup file changes once. Call sites stay identical to the wrap
 * path — same `llm.generateText({ taskType, ... })` shape.
 *
 * Run: pnpm --filter @llm-ports/example-migrate-from-vercel-ai after-migrate
 */

import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

// Direct native adapters. No `ai` or `@ai-sdk/*` imports anywhere.
const anthropicKey = process.env["ANTHROPIC_API_KEY"];
const openaiKey = process.env["OPENAI_API_KEY"];

if (!anthropicKey && !openaiKey) {
  console.error("Set at least one of ANTHROPIC_API_KEY / OPENAI_API_KEY before running.");
  process.exit(1);
}

const registry = createRegistryFromEnv({
  env: {
    // Note: now we use the adapter NAME directly (anthropic / openai),
    // not the wrapping `vercel` adapter. The model id in the env value
    // is the provider's model id, same as before.
    LLM_PROVIDER_PRIMARY: "anthropic|claude-haiku-4-5|cost:5/day",
    LLM_PROVIDER_BACKUP: "openai|gpt-4o-mini|cost:10/day",
    LLM_TASK_ROUTE_CLASSIFY: "primary,backup",
    LLM_TASK_ROUTE_SUMMARIZE: "primary,backup",
  },
  adapters: {
    ...(anthropicKey
      ? { anthropic: createAnthropicAdapter({ apiKey: anthropicKey }) }
      : {}),
    ...(openaiKey ? { openai: createOpenAIAdapter({ apiKey: openaiKey }) } : {}),
  },
});

const llm = registry.getPort();

// ─── Call sites — IDENTICAL to the wrap path ────────────────────
//
// The benefit of the migrate path is invisible at the call site. You
// drop the Vercel SDK dep, gain provider-native features (Anthropic
// prompt caching, OpenAI's reasoning-model auto-recovery, etc.), and
// the `llm.generateText(...)` shape stays the same.

async function classifyEmail(body: string) {
  const result = await llm.generateText({
    taskType: "classify",
    prompt: `Classify this email's intent. Respond with one word: question | request | complaint | feedback.\n\n${body}`,
    maxOutputTokens: 50,
  });
  return result.text.trim().toLowerCase();
}

async function summarizeArticle(text: string) {
  const result = await llm.generateText({
    taskType: "summarize",
    prompt: `Summarize this in 2 sentences:\n\n${text}`,
    maxOutputTokens: 200,
  });
  return result.text;
}

const email = "Hi, I was double-charged on my subscription. Can you help?";
const article =
  "TypeScript was created by Anders Hejlsberg at Microsoft in 2012. It compiles to JavaScript and adds static typing for large codebases.";

console.log("classify:", await classifyEmail(email));
console.log("summarize:", await summarizeArticle(article));

// Path B vs Path A — when to use which:
//
//   Use the WRAP path (Path A) if:
//     - You're already deeply invested in Vercel AI SDK (e.g. using
//       `streamUI`, RSC integration, or the `useChat` React hook in a
//       Next.js app)
//     - You want the lowest-friction migration and don't need provider-
//       native features
//
//   Use the MIGRATE path (Path B) if:
//     - You're using `ai` only for the `generateText` / `streamText`
//       primitives — not the React/Next.js integrations
//     - You want Anthropic prompt caching, OpenAI reasoning-model
//       handling, or other provider-native features that the Vercel
//       SDK abstracts over
//     - You want to drop two npm dependencies (`ai`, `@ai-sdk/*`)
//
// Both paths give you the same call-site shape. You can also do a
// hybrid: wrap path for the React/RSC bits, migrate path for the
// backend services.
