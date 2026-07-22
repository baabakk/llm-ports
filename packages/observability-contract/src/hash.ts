/**
 * Hash computation primitives for RequestFingerprint per Plan 58 v0.4 §4.6.
 *
 * Uses Node's `crypto` module (sync, well-tested, ubiquitous). Non-Node
 * runtimes (browser, Cloudflare Workers, Deno, Bun) can substitute a
 * WebCrypto-based async variant in a later contract release; the sync
 * API here is documented as Node-first.
 *
 * Two hash algorithms per §4.6:
 *
 *   - "sha256": plain SHA-256 hex digest of the canonical form.
 *     Default; simplest; content-attackable by dictionary attacks
 *     against predictable prompts.
 *   - "hmac-sha256": HMAC-SHA-256 keyed with a consumer-supplied secret.
 *     Content-preserving against dictionary attacks; required for
 *     regulated environments (healthcare, finance) that treat prompt
 *     fingerprints as sensitive or pseudonymous data.
 */

import { createHash, createHmac } from "node:crypto";

/**
 * Which hash algorithm was used to produce a fingerprint. Consumers
 * comparing fingerprints across environments MUST check that the
 * algorithm matches; sha256 and hmac-sha256 are not comparable.
 */
export type HashAlgorithm = "sha256" | "hmac-sha256";

/**
 * Compute a SHA-256 hex digest of a canonical string. Returns the
 * 64-character hex string.
 */
export function sha256Hex(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Compute an HMAC-SHA-256 hex digest of a canonical string using the
 * supplied secret key. Returns the 64-character hex string.
 *
 * The key MUST be at least 16 bytes for security; shorter keys throw.
 * Consumers should treat the key as a secret and rotate it per their
 * own policy; changing the key changes every fingerprint the consumer
 * has ever produced.
 */
export function hmacSha256Hex(key: string, canonical: string): string {
  if (Buffer.byteLength(key, "utf8") < 16) {
    throw new Error(
      "HMAC key must be at least 16 UTF-8 bytes; got " +
        Buffer.byteLength(key, "utf8") +
        ". Use a proper secret (e.g. `openssl rand -hex 32`).",
    );
  }
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

/**
 * Compute a hash of a canonical string using the specified algorithm.
 * `hmac-sha256` requires a key (throws if absent).
 */
export function hash(
  algorithm: HashAlgorithm,
  canonical: string,
  hmacKey?: string,
): string {
  if (algorithm === "sha256") return sha256Hex(canonical);
  if (algorithm === "hmac-sha256") {
    if (!hmacKey) {
      throw new Error(
        "hmac-sha256 requires an hmacKey; got undefined. Supply via " +
          "ObservabilityContext.fingerprint_key or the fingerprint helper.",
      );
    }
    return hmacSha256Hex(hmacKey, canonical);
  }
  // Exhaustiveness guard: TypeScript should already catch this at compile time.
  throw new Error(`Unknown hash algorithm: ${String(algorithm)}`);
}
