/**
 * A system message that is not adjacent to the others warns and collapses.
 *
 * Gemini takes system content as a separate `systemInstruction`, not as a turn
 * in `contents`, so a system message appearing after a user turn has nowhere
 * to sit in the provider's own shape. Until alpha.35 this adapter threw
 * `NonContiguousSystemError` and the call failed.
 *
 * The behaviour now matches `adapter-anthropic`: fold every system message
 * into the instruction field, in order, and warn once per process. Asked for
 * by SalesCoach as alpha.29 item 20, and a gate item for beta because a throw
 * that stops being thrown cannot change after the surface freezes.
 *
 * **Order matters in this file.** The warn-once state lives for the life of
 * the process, which is the behaviour under test, so the case that must not
 * warn runs before the fold that consumes the single warning.
 */

import { NonContiguousSystemError } from "@llm-ports/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGeminiResponse, mockGenerateContent, resetMocks } from "../helpers/mock-sdk.js";
import { createGoogleAdapter } from "../../src/index.js";

const MODEL = "gemini-2.5-flash";

function port() {
  return createGoogleAdapter({ apiKey: "test" }).createLLMPort(MODEL, "google");
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetMocks();
  mockGenerateContent.mockResolvedValue(
    buildGeminiResponse({ text: "ok", promptTokens: 1, candidateTokens: 1, modelId: MODEL }),
  );
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("what does not change", () => {
  it("leading system messages still merge, with no warning", async () => {
    await port().generateText({
      messages: [
        { role: "system", content: "First." },
        { role: "system", content: "Second." },
        { role: "user", content: "hello" },
      ],
    });
    const sent = mockGenerateContent.mock.calls[0]![0] as { config?: { systemInstruction?: string } };
    expect(sent.config?.systemInstruction).toContain("First.");
    expect(sent.config?.systemInstruction).toContain("Second.");
    expect(warn).not.toHaveBeenCalled();
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

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/system/i);
  });

  it("does not throw, and its text reaches the instruction field", async () => {
    await port().generateText({
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "hello" },
        { role: "system", content: "Answer in French." },
        { role: "user", content: "again" },
      ],
    });

    const sent = mockGenerateContent.mock.calls[0]![0] as {
      config?: { systemInstruction?: string };
      contents: Array<{ role: string }>;
    };
    expect(sent.config?.systemInstruction).toContain("You are terse.");
    expect(sent.config?.systemInstruction).toContain("Answer in French.");
    // Gemini has no system role in `contents`; a late instruction left there
    // would be sent as a user turn, which changes who is speaking.
    expect(sent.contents.every((c) => c.role !== "system")).toBe(true);
    expect(sent.contents).toHaveLength(2);
  });

  it("still refuses a late system message carrying a non-text block", async () => {
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
