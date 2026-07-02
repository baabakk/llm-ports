/**
 * `toMessages`, `sys`, `usr` — migration + construction helpers for the
 * canonical `messages: LLMMessage[]` input introduced in alpha.26.
 *
 * `toMessages(instructions, prompt)` is the one-line migration shim from the
 * legacy `{instructions, prompt}` shape. `sys()` and `usr()` are idiomatic
 * message-array constructors for hand-written call sites.
 *
 * None of these helpers do runtime validation beyond what's needed for
 * shape correctness — they're primitives, not gate-keepers. Empty strings,
 * empty content blocks, and other edge cases pass through and let the
 * provider throw its native error.
 *
 * Added in `0.1.0-alpha.26` (issue #TBD).
 */

import { PromptRequiredError } from "../errors.js";
import type { LLMMessage } from "../ports/llm-port.js";
import type { MessageContent } from "../content/blocks.js";

/**
 * Convert the legacy `{instructions, prompt}` shape into the canonical
 * `messages: LLMMessage[]` shape. The one-line migration shim for
 * consumers upgrading from alpha.25 or earlier.
 *
 * Semantics:
 *   - If `instructions` is a non-empty string, emits a system-role message
 *     with that content first.
 *   - Emits a user-role message with `prompt` as the content.
 *   - Throws `PromptRequiredError` if `prompt` is missing — the shim is
 *     designed for the migrate-single-turn-call use case, and a missing
 *     prompt is a caller bug.
 *
 * @example
 *   port.generateText({
 *     taskType: "triage",
 *     messages: toMessages(SYSTEM_PROMPT, userInput),
 *   });
 */
export function toMessages(
  instructions: string | undefined,
  prompt: MessageContent,
): LLMMessage[] {
  if (prompt === undefined || prompt === null) throw new PromptRequiredError();
  const out: LLMMessage[] = [];
  if (typeof instructions === "string" && instructions.length > 0) {
    out.push({ role: "system", content: instructions });
  }
  out.push({ role: "user", content: prompt });
  return out;
}

/**
 * Idiomatic system-role message constructor.
 *
 * Accepts a plain string only. System prompts are almost always text; the
 * rare multimodal-system case constructs via object literal
 * (`{ role: "system", content: [...] }`).
 *
 * @example
 *   port.generateText({
 *     taskType: "triage",
 *     messages: [sys("Classify the message urgency."), usr(rawEmailBody)],
 *   });
 */
export function sys(content: string): LLMMessage {
  return { role: "system", content };
}

/**
 * Idiomatic user-role message constructor.
 *
 * Accepts either a plain string or a structured `MessageContent` array
 * (text + image + audio content blocks).
 *
 * @example
 *   port.generateText({
 *     taskType: "describe",
 *     messages: [
 *       sys("Describe the image concisely."),
 *       usr([{ type: "text", text: "What's in this?" }, imageBlock]),
 *     ],
 *   });
 */
export function usr(content: MessageContent): LLMMessage {
  return { role: "user", content };
}
