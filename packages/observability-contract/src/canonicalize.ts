/**
 * Canonicalization spec v1 for RequestFingerprint per Plan 58 v0.4 §4.6.
 *
 * The spec is normative: implementations MUST produce the same canonical
 * form for the same input, across Node versions and runtimes. Golden
 * vectors in `test-vectors/vectors.json` pin the exact byte output.
 *
 * Rules (all v1):
 *
 *   1. Key ordering: JSON object keys sorted lexicographically at every
 *      nesting level. Array order is preserved.
 *   2. Unicode normalization: NFC applied to every string value AND
 *      every object key. NFC folds combined characters to their canonical
 *      composition (e.g. `"é"` as a single code point vs. `"e" + U+0301`
 *      combining acute → the single-code-point form wins).
 *   3. Line endings: `\r\n` and lone `\r` → `\n` in every string value.
 *   4. Whitespace: preserved within string values, NOT compressed.
 *   5. Multimodal refs: image URIs and other resource references are
 *      hashed as their URI string. The referenced binary content is NOT
 *      fetched or hashed; that would be non-portable and slow.
 *   6. Tool definitions: sorted by tool name; within each tool, parameter
 *      keys are sorted lexicographically (rule 1 applies transitively).
 *   7. Sampling params (temperature, top_p, top_k, max_tokens,
 *      frequency_penalty, presence_penalty, stop_sequences, seed):
 *      included in the RequestFingerprint's `request_hash` input;
 *      excluded from `message_hash` input.
 *   8. Metadata / provider-extras / trace context / baggage / capture
 *      policy: excluded from BOTH hashes. These are transport-layer
 *      concerns, not semantic content.
 *
 * Extensibility: when the canonicalization rules change (which will
 * happen), bump `NORMALIZATION_VERSION`. Consumers with stored
 * fingerprints from an earlier version can migrate at their own pace.
 */

/** Current canonicalization version. Increment on any rule change. */
export const NORMALIZATION_VERSION = "1";

/**
 * Produce a canonical JSON string from an arbitrary input. Applies all
 * v1 rules. Same input always produces the same output byte sequence.
 *
 * Not intended for consumer use directly; used internally by the
 * fingerprint helpers. Exported for golden-vector verification and for
 * consumers who want to compute a hash themselves against the same
 * canonical form.
 */
export function canonicalize(input: unknown): string {
  return JSON.stringify(canonicalizeValue(input));
}

/**
 * Recursively canonicalize a JSON value. String values are Unicode-
 * normalized (NFC) and line-endings-normalized; object keys are
 * sorted lexicographically and their string form is Unicode-normalized;
 * arrays preserve order but recurse into their elements.
 *
 * Non-JSON values (functions, symbols, undefined) are converted to null
 * — the same behavior JSON.stringify has for these positions in an
 * object's value slot; different only in that JSON.stringify drops
 * these entirely at the object-key level while we preserve them as
 * null to make the presence of the key visible in the canonical form.
 */
function canonicalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return canonicalizeString(v);
  if (typeof v === "number") {
    // NaN and Infinity are not representable in JSON; drop to null.
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(canonicalizeValue);
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    // Sort keys lexicographically (rule 1) and normalize each key (rule 2).
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const rawKey of keys) {
      const canonKey = canonicalizeString(rawKey);
      out[canonKey] = canonicalizeValue(obj[rawKey]);
    }
    return out;
  }
  // Functions, symbols, other exotic types → null.
  return null;
}

/**
 * Apply the string-normalization rules to a raw string value.
 *
 * - Rule 2: Unicode NFC
 * - Rule 3: line endings → \n
 */
export function canonicalizeString(s: string): string {
  // Line endings first, so NFC gets a clean stream to work with.
  const lineEndingsNormalized = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return lineEndingsNormalized.normalize("NFC");
}

/**
 * Prepare a message array for `message_hash` computation. Applies the
 * v1 rules to the entire array. Returns a canonical JSON string.
 *
 * Excludes sampling params, system-outside-messages, tools, schema,
 * and all metadata — those live in the broader `request_hash`.
 */
export function canonicalMessagesForm(messages: unknown[]): string {
  return canonicalize(messages);
}

/**
 * The keys allowed to participate in `request_hash` computation. Any
 * other keys in the request object are ignored (rule 8: metadata
 * excluded from both hashes).
 */
export const REQUEST_HASH_ALLOWED_KEYS: readonly string[] = [
  "messages",
  "system",
  "instructions",
  "tools",
  "tool_choice",
  "response_format",
  "schema",
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "frequency_penalty",
  "presence_penalty",
  "stop_sequences",
  "seed",
  "reasoning_effort",
] as const;

/**
 * Prepare a full request object for `request_hash` computation. Filters
 * to the allowed key set (excluding metadata / provider-extras / trace
 * context / baggage), then applies the v1 rules. Returns a canonical
 * JSON string.
 */
export function canonicalRequestForm(request: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const key of REQUEST_HASH_ALLOWED_KEYS) {
    if (key in request) {
      filtered[key] = request[key];
    }
  }
  return canonicalize(filtered);
}
