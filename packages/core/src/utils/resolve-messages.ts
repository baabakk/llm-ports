/**
 * Shared adapter helper for resolving the canonical `messages` + `instructions`
 * pair from the alpha.26 dual-shape call options.
 *
 * The Registry normalizes `{ instructions, prompt }` into `messages` before
 * dispatch, so in practice this helper mostly reads `options.messages`.
 * When called directly (bypassing the Registry), the helper also honors
 * the legacy `{ instructions, prompt }` fields.
 *
 * Semantics:
 *   - If `options.messages` is set: extract the LEADING contiguous system-
 *     role messages into a concatenated `instructions` string (Anthropic
 *     + Google adapters use a separate system field; the OpenAI shape keeps
 *     system inline but the helper centralizes the transform for
 *     consistency). Remaining messages become the user-visible message
 *     content.
 *   - Non-contiguous system messages (system in the middle of a
 *     conversation) pass through inline unchanged.
 *   - If `options.messages` is unset, fall back to a single-user-message
 *     shape from `options.prompt` and `options.instructions`.
 *   - When `options.messages` fully consumes into system content (no user
 *     turn), returns an empty messages array — the caller adapter can
 *     decide to error or synthesize a placeholder.
 *
 * Added in `0.1.0-alpha.26`.
 */

import type { LLMMessage } from "../ports/llm-port.js";
import type { MessageContent } from "../content/blocks.js";

/**
 * Return the "user-facing" message content when the caller uses the legacy
 * `{prompt}` shape. Returns `undefined` when `messages` is set — the caller
 * should use `messages` directly in that case.
 */
export function resolveCanonicalMessages(options: {
  messages?: LLMMessage[];
  instructions?: string;
  prompt?: MessageContent;
}): { messages: LLMMessage[]; instructions: string | undefined } {
  if (options.messages !== undefined && options.messages.length > 0) {
    const arr = options.messages;
    const leadingSystem: string[] = [];
    let i = 0;
    while (i < arr.length && arr[i]!.role === "system") {
      const content = arr[i]!.content;
      if (typeof content === "string") {
        leadingSystem.push(content);
      } else {
        // Multimodal system content: flatten text blocks; if any non-text
        // blocks are present, abort concatenation and let the system
        // message pass through inline unchanged.
        const textFragments: string[] = [];
        let hasNonText = false;
        for (const block of content) {
          if ((block as { type: string }).type === "text") {
            textFragments.push((block as { text: string }).text);
          } else {
            hasNonText = true;
          }
        }
        if (hasNonText) break;
        leadingSystem.push(textFragments.join(""));
      }
      i++;
    }
    const instructions =
      leadingSystem.length > 0 ? leadingSystem.join("\n\n") : options.instructions;
    const remaining = arr.slice(i);
    return { messages: remaining, instructions };
  }
  // Legacy shape: synthesize a single user message from prompt.
  if (options.prompt === undefined) {
    return { messages: [], instructions: options.instructions };
  }
  return {
    messages: [{ role: "user", content: options.prompt }],
    instructions: options.instructions,
  };
}
