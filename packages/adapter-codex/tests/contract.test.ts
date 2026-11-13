/**
 * Adapter conformance: codex must satisfy the shared LLMPort contract for the
 * one method it serves, and must refuse the rest rather than degrade.
 *
 * This adapter drives a real subprocess, so there is no SDK to mock. A fake
 * binary stands in for `codex` and records what the adapter actually sent,
 * which is argv plus stdin. That recording is what the suite's
 * honoured-or-refused assertions read.
 *
 * Why this file exists: `adapter-codex` and `adapter-aider` were the only two
 * publishable adapters outside the shared suite, and they were the only two
 * that accepted required contract inputs and dropped them without error. The
 * absence of this file is the reason nothing noticed for five releases. See
 * `TD-LLMPORTS-CLI-ADAPTERS-DISCARD-REQUIRED-INPUTS-AND-SIT-OUTSIDE-THE-CONTRACT-SUITE`.
 */

import { runContractTests, type RunAgentTransmission } from "@llm-ports/adapter-contract-tests";
import { tmpdir } from "node:os";
import { createCodexAdapter } from "../src/index.js";
import { makeFakeCli, type FakeCli } from "./helpers/fake-cli.js";

const MODEL_ID = "fake-codex-model";
// The adapter hardcodes its alias; createLLMPort takes no alias argument.
const ALIAS = "codex";

/**
 * Read the three contract inputs back out of what the fake binary received.
 *
 * The adapter's wire format is a single prompt argument, so this reads that
 * argument. It reports what is observably present rather than what the adapter
 * intended: if the adapter never put the instructions into the prompt, there is
 * nothing here to find, which is exactly the failure the suite should catch.
 */
function transmissionFrom(fake: FakeCli): RunAgentTransmission {
  const { argv, stdin } = fake.lastInvocation();
  // The prompt is the final positional argument; flags all precede it.
  const prompt = `${argv[argv.length - 1] ?? ""}\n${stdin}`;

  // Role markers only exist if the adapter labels turns. An adapter that
  // concatenates user text and discards the rest produces none, and the
  // suite's assertion then fails, correctly.
  const roles: string[] = [];
  for (const match of prompt.matchAll(/^\s*(user|assistant|system)\s*:/gim)) {
    roles.push(match[1]!.toLowerCase());
  }

  // Tools have no channel in this adapter's argv today. Reporting the names
  // found in the prompt rather than an empty list keeps this honest: if a
  // later change passes tools through by naming them, this sees it.
  const toolNames: string[] = [];
  for (const match of prompt.matchAll(/\blookup_invoice\b/g)) {
    void match;
    toolNames.push("lookup_invoice");
  }

  return { instructions: prompt, toolNames, messageRoles: roles };
}

let fake: FakeCli;

runContractTests("codex", () => {
  fake = makeFakeCli();
  const adapter = createCodexAdapter({
    cliPath: fake.cliPath,
    cliArgsPrefix: fake.cliArgsPrefix,
    defaultWorkingDirectory: tmpdir(),
    defaultModel: MODEL_ID,
    defaultSandbox: "read-only",
  });
  const port = adapter.createLLMPort();

  return {
    port,
    expectedAlias: ALIAS,
    expectedModelId: MODEL_ID,

    // This adapter serves runAgent only. Declaring the rest makes the suite
    // both skip their conformance tests and assert each one throws, so the
    // refusal is verified rather than described in a comment.
    // A subscription CLI reports no per-call dollar figure, by design.
    billing: "flat_rate" as const,

    unsupportedMethods: ["generateText", "generateStructured", "streamText", "streamStructured"],

    inspectLastRunAgentRequest: () => transmissionFrom(fake),

    // The fake binary always answers the same way, so the mock setters have
    // nothing to configure. They are required by the context shape.
    setupGenerateText() {},
    setupGenerateStructured() {},
    setupStreamText() {},
    setupStreamStructured() {},
    setupRunAgent(response) {
      fake.setResponse({
        text: response.text,
        model: MODEL_ID,
        usage: {
          input_tokens: response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
          total_tokens: response.usage.totalTokens,
        },
      });
    },
    setupNetworkError() {},
  };
});
