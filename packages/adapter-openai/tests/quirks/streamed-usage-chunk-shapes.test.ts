/**
 * Streamed usage arrives in two shapes, and only one of them was read.
 *
 * OpenAI ends a stream with a **usage-only chunk**: `choices: []` plus `usage`.
 * Together AI and Cerebras send no such chunk; they attach `usage` to the
 * chunk that carries `finish_reason`, which has choices. Every streaming path
 * in this adapter captured usage only when `choices` was empty, so for those
 * providers the tokens were discarded. The text arrived, the call succeeded,
 * and the spend went uncounted.
 *
 * **Adopted from the consumer who found it.** The RLM gateway carried
 * `patches/@llm-ports__adapter-openai@0.1.0-alpha.30.patch` against this
 * defect, plus a guard test that failed if a reinstall dropped the patch. This
 * is that test, extended to assert the OpenAI shape too, so the fix cannot be
 * made by moving the bug from one shape to the other.
 *
 * The server is a real local HTTP server speaking server-sent events, because
 * the shape under test is a wire shape: a hand-built mock of the SDK's parsed
 * output could not have caught this and did not.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRegistryFromEnv, type TokenUsageEvent } from "@llm-ports/core";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAIAdapter } from "../../src/index.js";

const USAGE = { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 };

const textDeltas = [
  { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
  { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "lo" } }] },
];

/** Together AI and Cerebras: usage rides the chunk that finishes the stream. */
const USAGE_ON_FINISH = [
  ...textDeltas,
  { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: USAGE },
];

/** OpenAI: a trailing chunk with no choices carries the usage. */
const USAGE_ONLY_TRAILER = [
  ...textDeltas,
  { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: USAGE },
];

let server: Server | undefined;

/** Serve one fixed chunk sequence as server-sent events. */
async function serve(chunks: readonly unknown[]): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

afterEach(async () => {
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

function registryFor(baseURL: string, seen: TokenUsageEvent[]) {
  return createRegistryFromEnv({
    env: { LLM_PROVIDER_FAKE: "fake|m|unlimited", LLM_TASK_ROUTE_T: "fake" },
    adapters: { fake: createOpenAIAdapter({ apiKey: "test", baseURL }) },
    pricingOverrides: { m: { inputPer1M: 1, outputPer1M: 1 } },
    observability: { onTokenUsage: (e) => void seen.push(e) },
  });
}

const shapes: Array<[string, readonly unknown[]]> = [
  ["usage on the finishing chunk, as Together AI and Cerebras send it", USAGE_ON_FINISH],
  ["usage in a trailing chunk with no choices, as OpenAI sends it", USAGE_ONLY_TRAILER],
];

for (const [label, chunks] of shapes) {
  describe(`streamText with ${label}`, () => {
    it("yields the text and reports the tokens", async () => {
      const seen: TokenUsageEvent[] = [];
      const baseURL = await serve(chunks);

      let text = "";
      for await (const piece of registryFor(baseURL, seen).getPort().streamText({
        taskType: "t",
        messages: [{ role: "user", content: "hi" }],
      })) {
        text += piece;
      }

      expect(text).toBe("Hello");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ inputTokens: 9, outputTokens: 2, totalTokens: 11 });
    });
  });
}

describe("the other streaming paths read the same shapes", () => {
  it("streamChat reports tokens when usage rides the finishing chunk", async () => {
    // The same one-line condition appears in three places. A fix applied to
    // streamText alone would leave this failing, which is the point of the test.
    const seen: TokenUsageEvent[] = [];
    const baseURL = await serve(USAGE_ON_FINISH);

    const port = registryFor(baseURL, seen).getPort();
    if (typeof port.streamChat !== "function") return; // optional method

    let text = "";
    for await (const event of port.streamChat({
      taskType: "t",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (event.type === "text-delta") text += event.text;
    }

    expect(text).toBe("Hello");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ totalTokens: 11 });
  });
});
