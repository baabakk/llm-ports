/**
 * BEFORE — direct Vercel AI SDK usage.
 *
 * This is what a typical Vercel AI SDK consumer's code looks like
 * before adopting llm-ports. The model object is bound to the call
 * site; switching providers means editing every file.
 *
 * Run: pnpm --filter @llm-ports/example-migrate-from-vercel-ai before
 */

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const model = anthropic("claude-haiku-4-5");

// Imagine 10+ files like this scattered across the codebase. Each one
// imports the SDK + a model factory + binds the model to a call. To
// switch from Anthropic to OpenAI you edit every file. To add cost
// gating you wrap each file. To add fallback chains you reinvent it.
async function classifyEmail(body: string) {
  const result = await generateText({
    model,
    messages: [{ role: "user" as const, content: `Classify this email's intent. Respond with one word: question | request | complaint | feedback.\n\n${body}` }],
    maxTokens: 50,
  });
  return result.text.trim().toLowerCase();
}

async function summarizeArticle(text: string) {
  const result = await generateText({
    model, // ← same model bound here
    messages: [{ role: "user" as const, content: `Summarize this in 2 sentences:\n\n${text}` }],
    maxTokens: 200,
  });
  return result.text;
}

// Demo
const email = "Hi, I was double-charged on my subscription. Can you help?";
const article =
  "TypeScript was created by Anders Hejlsberg at Microsoft in 2012. It compiles to JavaScript and adds static typing for large codebases.";

console.log("classify:", await classifyEmail(email));
console.log("summarize:", await summarizeArticle(article));

// What's missing here that production needs:
//
//   1. Fallback. If Anthropic returns 503, this throws. No automatic
//      walk to OpenAI as a backup.
//   2. Cost gating. There's no per-day USD cap. The bill is what it is.
//   3. Capability reuse. If you have 10 classify-style call sites,
//      you have 10 places that say "Classify this email's intent.
//      Respond with one word: question | request | complaint | feedback."
//      Improving the rubric means editing 10 files.
//   4. Provider switching. Adding `openai("gpt-4o-mini")` means editing
//      every file (or building your own provider-resolution layer).
//
// The next two files show how to add all four without rewriting most
// of your code.
