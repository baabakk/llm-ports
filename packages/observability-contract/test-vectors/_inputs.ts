/**
 * Golden vector INPUTS. Deliberately versioned in TypeScript (not JSON)
 * so tests type-check against the same shape they hash. The vector
 * generator script (`scripts/generate-vectors.ts`) consumes this and
 * writes `vectors.json` with the computed expected hashes.
 *
 * Do NOT include real user content or PII. Vectors are shipped in the
 * npm package.
 */

import type { FingerprintableRequest } from "../src/fingerprint.js";

export interface GoldenVectorInput {
  /** Short slug; matches the vector name in the JSON. */
  name: string;

  /** Human-readable description of what this vector exercises. */
  description: string;

  /** The request object to fingerprint. */
  input: FingerprintableRequest;
}

/**
 * The 32-UTF-8-byte HMAC key used to compute the `_hmac` variants.
 * Shipped in the JSON so third-party implementations can reproduce.
 */
export const GOLDEN_HMAC_KEY = "0123456789abcdef0123456789abcdef";

/**
 * The full set of golden vector inputs. Adding a vector here plus
 * re-running the generator script produces new `_expected_*` fields in
 * the JSON.
 */
export const GOLDEN_VECTOR_INPUTS: readonly GoldenVectorInput[] = [
  {
    name: "empty-messages",
    description: "Empty messages array; edge case.",
    input: { messages: [] },
  },
  {
    name: "single-user-message",
    description: "One user message; the simplest non-empty case.",
    input: {
      messages: [{ role: "user", content: "Hello" }],
    },
  },
  {
    name: "multi-turn-conversation",
    description: "Alternating user + assistant turns.",
    input: {
      messages: [
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "4" },
        { role: "user", content: "And 3+3?" },
      ],
    },
  },
  {
    name: "with-system-message",
    description: "System message included in request_hash but not message_hash.",
    input: {
      messages: [{ role: "user", content: "Say hi" }],
      system: "You are a laconic assistant.",
    },
  },
  {
    name: "with-sampling-params",
    description: "Sampling params change request_hash, not message_hash.",
    input: {
      messages: [{ role: "user", content: "Roll a die" }],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 100,
      seed: 42,
    },
  },
  {
    name: "with-tools",
    description: "Tool definitions participate in request_hash.",
    input: {
      messages: [{ role: "user", content: "Read a file for me" }],
      tools: [
        { name: "readFile", description: "Read a file", parameters: { path: "string" } },
        { name: "writeFile", description: "Write a file", parameters: { path: "string", content: "string" } },
      ],
    },
  },
  {
    name: "with-schema",
    description: "Structured-output schema participates in request_hash.",
    input: {
      messages: [{ role: "user", content: "Give me a JSON summary" }],
      schema: { type: "object", properties: { summary: { type: "string" } } },
    },
  },
  {
    name: "unicode-nfc-decomposed",
    description: "Decomposed characters (e + combining acute) normalize to NFC.",
    input: {
      messages: [{ role: "user", content: "café résumé" }],
    },
  },
  {
    name: "unicode-nfc-composed",
    description: "Precomposed characters (single-code-point é); same hash as decomposed variant.",
    input: {
      messages: [{ role: "user", content: "café résumé" }],
    },
  },
  {
    name: "line-endings-crlf",
    description: "CRLF line endings normalize to LF.",
    input: {
      messages: [{ role: "user", content: "line1\r\nline2\r\nline3" }],
    },
  },
  {
    name: "line-endings-lf",
    description: "LF line endings; same hash as CRLF variant.",
    input: {
      messages: [{ role: "user", content: "line1\nline2\nline3" }],
    },
  },
  {
    name: "key-ordering-a-b-c",
    description: "Message keys in one order; canonicalized identically to reverse order.",
    input: {
      messages: [{ content: "test", role: "user" }],
    },
  },
  {
    name: "key-ordering-c-b-a",
    description: "Message keys in reverse order; same hash as forward variant.",
    input: {
      messages: [{ role: "user", content: "test" }],
    },
  },
  {
    name: "instructions-vs-system",
    description: "Instructions field distinct from system; both participate in request_hash.",
    input: {
      messages: [{ role: "user", content: "Do the thing" }],
      instructions: "Be brief.",
    },
  },
  {
    name: "response-format-json",
    description: "response_format participates in request_hash.",
    input: {
      messages: [{ role: "user", content: "Output JSON" }],
      response_format: { type: "json_object" },
    },
  },
  {
    name: "reasoning-effort-high",
    description: "reasoning_effort participates in request_hash.",
    input: {
      messages: [{ role: "user", content: "Think hard about this" }],
      reasoning_effort: "high",
    },
  },
  {
    name: "metadata-excluded",
    description:
      "metadata + providerExtras + signal excluded from BOTH hashes. Same hash as single-user-message.",
    input: {
      messages: [{ role: "user", content: "Hello" }],
      // These fields are NOT in REQUEST_HASH_ALLOWED_KEYS and must not
      // affect either hash.
      ...({ metadata: { tenant: "acme", user: "42" }, providerExtras: { anything: true } } as Record<string, unknown>),
    },
  },
] as const;
