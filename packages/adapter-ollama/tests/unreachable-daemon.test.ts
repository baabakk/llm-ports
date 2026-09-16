/**
 * A stopped Ollama daemon must surface as an unreachable provider.
 *
 * This file deliberately does not import `./helpers/mock-sdk.js`. It drives
 * the real `ollama` client library against a local port with nothing
 * listening, because the defect it guards against lived in the gap between
 * the error a hand-built test assumed and the error the library really
 * throws: a bare `TypeError: fetch failed`. That was classified as a bug in
 * this adapter, which stops the fallback chain, so a stopped daemon never
 * failed over to the next provider.
 *
 * No network access is needed: the port is on the loopback interface and is
 * closed, so the connection is refused immediately.
 */

import { createServer, type AddressInfo } from "node:net";
import { AdapterInternalError, ProviderUnavailableError } from "@llm-ports/core";
import { describe, expect, it } from "vitest";
import { createOllamaAdapter } from "../src/index.js";

/** A loopback port that was free a moment ago and has nothing listening. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("a stopped Ollama daemon", () => {
  it("is reported as an unreachable provider, not as an adapter bug", async () => {
    const port = await closedPort();
    const adapter = createOllamaAdapter({ baseURL: `http://127.0.0.1:${port}` });
    const llm = adapter.createLLMPort("llama3.3", "local");

    const err = await llm
      .generateText({ messages: [{ role: "user", content: "hi" }] })
      .then(() => undefined, (e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err).not.toBeInstanceOf(AdapterInternalError);
  });
});
