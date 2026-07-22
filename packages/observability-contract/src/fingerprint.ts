/**
 * RequestFingerprint per Plan 58 v0.4 §4.6.
 *
 * Two hashes per request:
 *
 *   - `message_hash`: SHA-256 (or HMAC-SHA-256) of the canonical form
 *     of the conversation content only. Two requests with the same
 *     messages but different temperature values will have the same
 *     message_hash and different request_hash values.
 *
 *   - `request_hash`: SHA-256 (or HMAC-SHA-256) of the canonical form
 *     of the full behaviorally-relevant request (messages + system +
 *     instructions + tools + tool_choice + schema + sampling params).
 *     A request-drift signal: any behaviorally-relevant change in the
 *     request produces a different request_hash.
 *
 * The canonicalization spec (canonicalize.ts) is the same for both;
 * they differ only in which fields participate.
 *
 * Golden vectors in `test-vectors/vectors.json` pin the exact byte
 * output for cross-implementation validation.
 */

import {
  canonicalMessagesForm,
  canonicalRequestForm,
  NORMALIZATION_VERSION,
} from "./canonicalize.js";
import { hash, type HashAlgorithm } from "./hash.js";

/**
 * The RequestFingerprint shape. Emitted on `llm.attempt.completed` and
 * on the terminal result objects.
 */
export interface RequestFingerprint {
  /**
   * Hash of the normalized message content only. Two requests with
   * the same messages but different sampling parameters share this
   * hash. Useful for identifying "same conversation, different
   * settings" over time.
   */
  message_hash: string;

  /**
   * Hash of the full behaviorally-relevant request (messages + system +
   * instructions + tools + tool_choice + schema + sampling params).
   * Any behaviorally-relevant change produces a different hash.
   */
  request_hash: string;

  /** Currently "1" per NORMALIZATION_VERSION. */
  normalization_version: string;

  /** Which algorithm produced the hashes. */
  hash_algorithm: HashAlgorithm;

  /**
   * Character count of the canonical form used for message_hash.
   * Cheap, tokenizer-free approximation of message length. Not
   * comparable to provider-reported token counts.
   */
  input_char_count?: number;

  /**
   * Consumer-supplied identifier for the version of the prompt template
   * or agent config that produced the request. Free-form; consumers
   * pick a scheme (e.g. `"triage-classifier@v3.2"`).
   */
  prompt_id?: string;

  /**
   * Consumer-supplied version qualifier. Freestyle; consumers pick a
   * scheme (semver, git sha, timestamp, whatever). Distinct from
   * prompt_id to keep the two fields independently orderable.
   */
  prompt_version?: string;
}

/**
 * The shape a request must have to be fingerprintable. Aligns with the
 * LLMPort generation-method options interface but is defined here as a
 * standalone shape so non-port callers (per §4.13) can compute
 * fingerprints for their own request objects.
 */
export interface FingerprintableRequest {
  messages?: unknown;
  system?: unknown;
  instructions?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
  schema?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  max_tokens?: unknown;
  frequency_penalty?: unknown;
  presence_penalty?: unknown;
  stop_sequences?: unknown;
  seed?: unknown;
  reasoning_effort?: unknown;
}

/**
 * Options for `computeRequestFingerprint`.
 */
export interface ComputeRequestFingerprintOptions {
  /** Hash algorithm to use. Default "sha256". */
  algorithm?: HashAlgorithm;

  /**
   * HMAC key. Required when `algorithm` is "hmac-sha256"; ignored
   * otherwise. Must be at least 16 UTF-8 bytes.
   */
  hmacKey?: string;

  /**
   * Consumer-supplied prompt version identifier. Threaded verbatim into
   * the resulting fingerprint's `prompt_id`.
   */
  promptId?: string;

  /**
   * Consumer-supplied prompt version qualifier. Threaded verbatim into
   * the resulting fingerprint's `prompt_version`.
   */
  promptVersion?: string;
}

/**
 * Compute a RequestFingerprint from a request object. Deterministic:
 * the same input produces the same output across Node versions and
 * runtimes.
 *
 * Consumer-side call pattern:
 *
 * ```ts
 * const fp = computeRequestFingerprint(
 *   { messages, system, temperature: 0.7 },
 *   { algorithm: "sha256" }
 * );
 * ```
 *
 * HMAC variant (regulated environments):
 *
 * ```ts
 * const fp = computeRequestFingerprint(
 *   { messages, system },
 *   { algorithm: "hmac-sha256", hmacKey: process.env.OBS_HMAC_KEY! }
 * );
 * ```
 */
export function computeRequestFingerprint(
  request: FingerprintableRequest,
  options: ComputeRequestFingerprintOptions = {},
): RequestFingerprint {
  const algorithm = options.algorithm ?? "sha256";
  const hmacKey = options.hmacKey;

  const messagesArr = Array.isArray(request.messages) ? request.messages : [];
  const canonicalMessages = canonicalMessagesForm(messagesArr);
  const canonicalRequest = canonicalRequestForm(request as Record<string, unknown>);

  const messageHash = hash(algorithm, canonicalMessages, hmacKey);
  const requestHash = hash(algorithm, canonicalRequest, hmacKey);

  const fingerprint: RequestFingerprint = {
    message_hash: messageHash,
    request_hash: requestHash,
    normalization_version: NORMALIZATION_VERSION,
    hash_algorithm: algorithm,
    input_char_count: canonicalMessages.length,
  };

  if (options.promptId !== undefined) fingerprint.prompt_id = options.promptId;
  if (options.promptVersion !== undefined) fingerprint.prompt_version = options.promptVersion;

  return fingerprint;
}
