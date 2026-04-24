/**
 * Reusable response fixtures shared by adapter contract tests.
 */

import type { TokenUsage } from "@llm-ports/core";

/** Build a TokenUsage object with optional cache fields. */
export function fakeChatUsage(
  inputTokens: number,
  outputTokens: number,
  cache?: { read?: number; write?: number },
): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cache?.read !== undefined ? { cacheReadTokens: cache.read } : {}),
    ...(cache?.write !== undefined ? { cacheWriteTokens: cache.write } : {}),
  };
}

/** Stringified JSON for a structured-output mock response. */
export function fakeStructuredResponse<T>(data: T): string {
  return JSON.stringify(data);
}

/** Build an array of mock streaming chunks from a string. */
export function fakeStreamChunks(text: string, chunkSize = 4): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    out.push(text.slice(i, i + chunkSize));
  }
  return out;
}
