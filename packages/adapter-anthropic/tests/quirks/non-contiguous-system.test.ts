/**
 * A system message that is not adjacent to the others warns and collapses.
 *
 * Anthropic takes system content as a top-level parameter, not as a message,
 * so a system message appearing after a user turn has nowhere to sit in the
 * provider's own shape. Until alpha.35 this adapter threw
 * `NonContiguousSystemError` and the call failed.
 *
 * **Throwing was the wrong trade.** The caller's intent is never ambiguous:
 * a later system message is an additional instruction. Refusing the call
 * protects nothing, and it punishes the common case of a consumer appending
 * an instruction to a transcript it assembled elsewhere. The behaviour is now
 * to fold every system message into the system parameter, in order, and warn
 * once per process so the caller can fix the shape if it was accidental.
 *
 * Asked for by SalesCoach as alpha.29 item 20, and a gate item for beta
 * because it changes a behaviour that exists today: a hard throw stops being
 * thrown, which cannot happen after the surface freezes.
 */

import { NonContiguousSystemError } from "@llm-ports/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicResponse, mockCreate, resetMocks } from "../helpers/mock-sdk.js";
import { createAnthropicAdapter } from "../../src/index.js";

const MODEL = "claude-sonnet-4-6";

function port() {
  return createAnthropicAdapter({ apiKey: "test" }).createLLMPort(MODEL, "anthropic");
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetMocks();
  mockCreate.mockResolvedValue(
    buildAnthropicResponse({ text: "ok", inputTokens: 1, outputTokens: 1, modelId: MODEL }),
  );
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

// Order matters in this file. The warn-once state lives for the life of the
// process, which is the behaviour being asserted, so the case that must NOT
// warn runs first, and the fold that consumes the single warning runs after it.

describe("what does not change", () => {
  it("leading system messages still merge, with no warning", async () => {
    await port().generateText({
      messages: [
        { role: "system", content: "First." },
        { role: "system", content: "Second." },
        { role: "user", content: "hello" },
      ],
    });
    const sent = mockCreate.mock.calls[0]![0] as { system?: string };
    expect(sent.system).toBe("First.\n\nSecond.");
    expect(warn).not.toHaveBeenCalled();
  });

  it("the error class is still exported, so a consumer catching it still compiles", () => {
    expect(typeof NonContiguousSystemError).toBe("function");
    expect(new NonContiguousSystemError("anthropic", "generateText", 2)).toBeInstanceOf(Error);
  });
});

describe("a system message after a user turn", () => {
  it("warns once per process, however many calls make the same mistake", async () => {
    const p = port();
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "system" as const, content: "Answer in French." },
    ];
    await p.generateText({ messages });
    await p.generateText({ messages });
    await p.generateText({ messages });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/system/i);
  });

  it("does not throw, and its text reaches the system parameter", async () => {
    await port().generateText({
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "hello" },
        { role: "system", content: "Answer in French." },
        { role: "user", content: "again" },
      ],
    });

    const sent = mockCreate.mock.calls[0]![0] as { system?: string; messages: Array<{ role: string }> };
    expect(sent.system).toContain("You are terse.");
    expect(sent.system).toContain("Answer in French.");
    // The late instruction must not survive as a message: Anthropic has no
    // system role in its message array, so leaving it there would send it as
    // a user turn, which changes who is speaking.
    expect(sent.messages.every((m) => m.role !== "system")).toBe(true);
    expect(sent.messages).toHaveLength(2);
  });

  it("still refuses a late system message carrying a non-text block", async () => {
    // It cannot be folded: the system field holds text, and silently dropping
    // an image would be worse than refusing the call.
    await expect(
      port().generateText({
        messages: [
          { role: "user", content: "hello" },
          { role: "system", content: [{ type: "image", source: { kind: "base64", data: "AAAA", mediaType: "image/png" } }] },
        ],
      }),
    ).rejects.toBeInstanceOf(NonContiguousSystemError);
  });
});
