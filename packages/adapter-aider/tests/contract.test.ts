/**
 * Adapter conformance: aider must satisfy the shared LLMPort contract for the
 * one method it serves, and must refuse the rest rather than degrade.
 *
 * Same shape as the Codex adapter's conformance test, for the same reason:
 * these two were the only publishable adapters outside the shared suite, and
 * the only two that accepted required contract inputs and dropped them without
 * error. They carried the identical defect under the identically named test.
 */

import {
  runContractTests,
  makeFakeCli,
  transmissionFromArgv,
  type FakeCli,
  type RunAgentTransmission,
} from "@llm-ports/adapter-contract-tests";
import { tmpdir } from "node:os";
import { createAiderAdapter } from "../src/index.js";

const MODEL_ID = "fake-aider-model";
// The adapter hardcodes its alias; createLLMPort takes no alias argument.
const ALIAS = "aider";

/** Report what the adapter sent, via the shared helper. */
function transmissionFrom(f: FakeCli): RunAgentTransmission {
  return transmissionFromArgv(f.lastInvocation(), ["run_tests"]);
}

let fake: FakeCli;

runContractTests("aider", () => {
  // Plain stdout rather than JSON lines: this CLI has no `--json` mode, and
  // the adapter takes its whole stdout as the final text.
  fake = makeFakeCli("text");

  const adapter = createAiderAdapter({
    cliPath: fake.cliPath,
    cliArgsPrefix: fake.cliArgsPrefix,
    defaultWorkingDirectory: tmpdir(),
    defaultModel: MODEL_ID,
  });
  const port = adapter.createLLMPort();

  return {
    port,
    expectedAlias: ALIAS,
    expectedModelId: MODEL_ID,

    // A price exists at whichever provider the operator configured, and this
    // CLI does not report what a run cost, so the cost is unknown rather than
    // absent. The distinction matters to an operator configuring a cost gate:
    // against a subscription such a gate is meaningless, and here it is merely
    // unenforceable.
    billing: "unknown" as const,

    // The CLI emits plain text with no token counts, so there is no usage to
    // pass through. The adapter reports zeros because TokenUsage requires
    // numbers; undefined would be the truthful answer and the contract cannot
    // express it yet.
    usageReporting: "unavailable" as const,

    // This adapter serves runAgent only. Declaring the rest makes the suite
    // skip their conformance tests and assert each one throws, so the refusal
    // is verified rather than described in a comment.
    unsupportedMethods: ["generateText", "generateStructured", "streamText", "streamStructured"],

    inspectLastRunAgentRequest: () => transmissionFrom(fake),

    setupRunAgent(response) {
      fake.setResponse({ text: response.text });
    },

    // The fake answers from a file the setter above writes, so the remaining
    // mock setters have nothing to configure. They are required by the shape.
    setupGenerateText() {},
    setupGenerateStructured() {},
    setupStreamText() {},
    setupStreamStructured() {},
    setupNetworkError() {},
  };
});
