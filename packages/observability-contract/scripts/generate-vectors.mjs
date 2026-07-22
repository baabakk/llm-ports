/**
 * Golden vector generator.
 *
 * Reads the input set from `test-vectors/_inputs.ts` (compiled via
 * pnpm build first), computes the expected hashes with the current
 * canonicalization + hash primitives, and writes `test-vectors/vectors.json`.
 *
 * Run manually when the vector inputs or canonicalization rules change:
 *
 *   pnpm --filter @llm-ports/observability-contract build
 *   node packages/observability-contract/scripts/generate-vectors.mjs
 *
 * The resulting `vectors.json` is committed and shipped in the package.
 * Every implementation of the contract MUST reproduce the same hashes
 * from the same inputs.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

// Dynamically import so the compiled dist is loaded, not the source.
// Convert filesystem path → file:// URL for cross-platform ESM import.
const distUrl = pathToFileURL(join(pkgRoot, "dist", "index.mjs")).href;
const { computeRequestFingerprint, NORMALIZATION_VERSION } = await import(distUrl);

// Read the inputs from the compiled TS (tsx via node loader, or just
// read as JSON if the file is pure data). Since _inputs.ts is TS, we
// need to strip the type imports and eval. Simpler: duplicate the
// input set here to keep the script self-contained.

const GOLDEN_HMAC_KEY = "0123456789abcdef0123456789abcdef";

// This mirrors test-vectors/_inputs.ts. Keep them in lockstep when
// adding new vectors.
const GOLDEN_VECTOR_INPUTS = [
  {
    name: "empty-messages",
    description: "Empty messages array; edge case.",
    input: { messages: [] },
  },
  {
    name: "single-user-message",
    description: "One user message; the simplest non-empty case.",
    input: { messages: [{ role: "user", content: "Hello" }] },
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
    input: { messages: [{ role: "user", content: "café résumé" }] },
  },
  {
    name: "unicode-nfc-composed",
    description: "Precomposed characters (single-code-point é); same hash as decomposed variant.",
    input: { messages: [{ role: "user", content: "café résumé" }] },
  },
  {
    name: "line-endings-crlf",
    description: "CRLF line endings normalize to LF.",
    input: { messages: [{ role: "user", content: "line1\r\nline2\r\nline3" }] },
  },
  {
    name: "line-endings-lf",
    description: "LF line endings; same hash as CRLF variant.",
    input: { messages: [{ role: "user", content: "line1\nline2\nline3" }] },
  },
  {
    name: "key-ordering-a-b-c",
    description: "Message keys in one order; canonicalized identically to reverse order.",
    input: { messages: [{ content: "test", role: "user" }] },
  },
  {
    name: "key-ordering-c-b-a",
    description: "Message keys in reverse order; same hash as forward variant.",
    input: { messages: [{ role: "user", content: "test" }] },
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
      metadata: { tenant: "acme", user: "42" },
      providerExtras: { anything: true },
    },
  },
];

const vectors = GOLDEN_VECTOR_INPUTS.map((v) => {
  const sha = computeRequestFingerprint(v.input, { algorithm: "sha256" });
  const hmac = computeRequestFingerprint(v.input, {
    algorithm: "hmac-sha256",
    hmacKey: GOLDEN_HMAC_KEY,
  });
  return {
    name: v.name,
    description: v.description,
    input: v.input,
    expected: {
      normalization_version: sha.normalization_version,
      input_char_count: sha.input_char_count,
      message_hash_sha256: sha.message_hash,
      request_hash_sha256: sha.request_hash,
      message_hash_hmac_sha256: hmac.message_hash,
      request_hash_hmac_sha256: hmac.request_hash,
    },
  };
});

const output = {
  spec: {
    normalization_version: NORMALIZATION_VERSION,
    hmac_key: GOLDEN_HMAC_KEY,
    hmac_key_notes: "The HMAC key here is fixed for cross-implementation reproducibility. Do NOT use it as a production secret.",
    generated_by: "packages/observability-contract/scripts/generate-vectors.mjs",
  },
  vectors,
};

const outPath = join(pkgRoot, "test-vectors", "vectors.json");
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(`Wrote ${vectors.length} golden vectors to ${outPath}`);
