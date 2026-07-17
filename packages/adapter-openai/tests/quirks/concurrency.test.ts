/**
 * Group I — concurrency / shared-state tests.
 *
 * The adapter has shared mutable state (process-wide learnedConstraints,
 * per-context hasSucceeded). These tests pin the concurrent behavior:
 *   - 100 parallel calls all complete without state corruption
 *   - Mid-flight learning: parallel calls converge correctly
 *   - hasSucceeded race: parallel first calls (one success, one 401) → second's
 *     transient-401 path correctly sees hasSucceeded after the winner
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildOpenAIChatResponse,
  buildOpenAIError,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { createOpenAIAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("Group I: concurrency / shared-state", () => {
  it("100 parallel generateText calls all complete; no state corruption", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // Stub returns a fresh response object for every invocation
    mockChatCompletionsCreate.mockImplementation(async () =>
      buildOpenAIChatResponse({
        text: "ok",
        promptTokens: 5,
        completionTokens: 5,
      }),
    );

    const N = 100;
    const promises = Array.from({ length: N }, (_, i) =>
      port.generateText({
        taskType: "t",
        messages: [{ role: "user" as const, content: `req-${i}` }],
        maxOutputTokens: 10,
      }),
    );
    const results = await Promise.all(promises);

    expect(results).toHaveLength(N);
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(N);
    for (const r of results) {
      expect(r.text).toBe("ok");
      expect(r.usage.totalTokens).toBe(10);
    }
  });

  it("parallel discovery converges: many calls discovering the same constraint don't corrupt state", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-5-nano", "live");

    // For each parallel call: first attempt = temperature rejection,
    // second attempt = success. Use mockImplementation to handle any number
    // of calls deterministically.
    let callIdx = 0;
    mockChatCompletionsCreate.mockImplementation(async () => {
      const idx = callIdx++;
      // Odd-indexed calls (0, 2, 4...) are first-attempts → reject.
      // Even-indexed calls (1, 3, 5...) are retries → succeed.
      // But we want EVERY parallel call to first reject then succeed,
      // so simpler: first half (0..N-1) all reject, second half (N..2N-1) all succeed.
      if (idx < 5) {
        throw buildOpenAIError({
          status: 400,
          code: "unsupported_value",
          param: "temperature",
          message: "no temperature support",
        });
      }
      return buildOpenAIChatResponse({
        text: `r${idx}`,
        promptTokens: 5,
        completionTokens: 5,
      });
    });

    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        port.generateText({
          taskType: "t",
          messages: [{ role: "user" as const, content: `req-${i}` }],
          temperature: 0,
          maxOutputTokens: 10,
        }),
      ),
    );

    // All 5 succeed; total SDK calls = 10 (5 rejections + 5 successes).
    expect(results).toHaveLength(N);
    for (const r of results) {
      expect(r.text).toMatch(/^r\d+$/);
    }
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(2 * N);
  });

  it("hasSucceeded race: parallel first calls (one success, one 401) — second's retry sees hasSucceeded after winner", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: "test",
      transientAuthBackoffMs: () => 50, // small delay so the success has time to flip the flag
    });
    const port = adapter.createLLMPort("gpt-4o", "live");

    // Two parallel calls. Order of resolution: success resolves first,
    // setting hasSucceeded=true. The 401 catches that flag and retries.
    let callIdx = 0;
    mockChatCompletionsCreate.mockImplementation(async () => {
      const i = callIdx++;
      if (i === 0) {
        // First SDK call: success (winner)
        return buildOpenAIChatResponse({
          text: "winner",
          promptTokens: 5,
          completionTokens: 5,
        });
      }
      if (i === 1) {
        // Second SDK call: 401. By the time this resolves the first call's
        // success has already set hasSucceeded=true (sync resolution path).
        // → adapter should retry.
        throw buildOpenAIError({
          status: 401,
          code: "invalid_api_key",
          message: "Incorrect API key",
        });
      }
      // Retry of the loser succeeds
      return buildOpenAIChatResponse({
        text: "loser-recovered",
        promptTokens: 5,
        completionTokens: 5,
      });
    });

    const [winner, loser] = await Promise.all([
      port.generateText({ taskType: "t", messages: [{ role: "user" as const, content: "1" }], maxOutputTokens: 10 }),
      port.generateText({ taskType: "t", messages: [{ role: "user" as const, content: "2" }], maxOutputTokens: 10 }),
    ]);
    expect(winner.text).toBe("winner");
    expect(loser.text).toBe("loser-recovered");
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(3); // success + 401 + retry
  });
});
