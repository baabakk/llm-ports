/**
 * @llm-ports/adapter-contract-tests — shared conformance suite.
 *
 * Every adapter package imports `runContractTests()` and invokes it with a
 * setup function that constructs the adapter pointed at controllable mock
 * responses. The suite then asserts the adapter conforms to the LLMPort
 * interface contract.
 *
 * Internal-only package; never published to npm. Distributed only to other
 * packages in this monorepo via workspace dependencies.
 */

export {
  runContractTests,
  type ContractTestContext,
  type ContractTestSetup,
  type MockedGenerateText,
  type MockedGenerateStructured,
  type MockedRunAgent,
  type MockedStreamText,
  type MockedStreamStructured,
} from "./suite.js";

export {
  // Reusable response factories so adapter tests can build canned responses
  // without recomputing token usage or cost from scratch.
  fakeChatUsage,
  fakeStructuredResponse,
  fakeStreamChunks,
} from "./fixtures.js";
