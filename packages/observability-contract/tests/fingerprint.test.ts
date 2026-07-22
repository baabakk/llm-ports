/**
 * RequestFingerprint tests.
 *
 * Loads test-vectors/vectors.json and asserts computeRequestFingerprint
 * reproduces every expected hash exactly. This is the golden-vector
 * contract: any implementation of §4.6 canonicalization + hashing MUST
 * produce these same byte outputs.
 *
 * Also verifies structural properties (equivalent inputs produce
 * identical hashes, sampling params change request_hash but not
 * message_hash, metadata is excluded from both, etc.).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeRequestFingerprint,
  NORMALIZATION_VERSION,
  sha256Hex,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorsPath = join(__dirname, "..", "test-vectors", "vectors.json");
const vectorsRaw = readFileSync(vectorsPath, "utf8");
const golden: {
  spec: {
    normalization_version: string;
    hmac_key: string;
    hmac_key_notes: string;
    generated_by: string;
  };
  vectors: Array<{
    name: string;
    description: string;
    input: Record<string, unknown>;
    expected: {
      normalization_version: string;
      input_char_count: number;
      message_hash_sha256: string;
      request_hash_sha256: string;
      message_hash_hmac_sha256: string;
      request_hash_hmac_sha256: string;
    };
  }>;
} = JSON.parse(vectorsRaw);

describe("RequestFingerprint (§4.6)", () => {
  describe("Golden vector conformance", () => {
    it("vectors.json spec matches the source NORMALIZATION_VERSION", () => {
      expect(golden.spec.normalization_version).toBe(NORMALIZATION_VERSION);
    });

    it("HMAC key is documented", () => {
      expect(golden.spec.hmac_key).toBe("0123456789abcdef0123456789abcdef");
      expect(golden.spec.hmac_key_notes).toContain("Do NOT use it as a production secret");
    });

    it("has at least 15 vectors covering the rule set", () => {
      expect(golden.vectors.length).toBeGreaterThanOrEqual(15);
    });

    it.each(golden.vectors)("$name → hashes match the golden vector", (vector) => {
      const sha = computeRequestFingerprint(vector.input, { algorithm: "sha256" });
      expect(sha.message_hash).toBe(vector.expected.message_hash_sha256);
      expect(sha.request_hash).toBe(vector.expected.request_hash_sha256);
      expect(sha.hash_algorithm).toBe("sha256");
      expect(sha.normalization_version).toBe(vector.expected.normalization_version);
      expect(sha.input_char_count).toBe(vector.expected.input_char_count);

      const hmac = computeRequestFingerprint(vector.input, {
        algorithm: "hmac-sha256",
        hmacKey: golden.spec.hmac_key,
      });
      expect(hmac.message_hash).toBe(vector.expected.message_hash_hmac_sha256);
      expect(hmac.request_hash).toBe(vector.expected.request_hash_hmac_sha256);
      expect(hmac.hash_algorithm).toBe("hmac-sha256");
    });
  });

  describe("Structural properties", () => {
    it("Unicode NFC: decomposed and composed forms produce identical hashes", () => {
      const decomposed = golden.vectors.find((v) => v.name === "unicode-nfc-decomposed");
      const composed = golden.vectors.find((v) => v.name === "unicode-nfc-composed");
      expect(decomposed).toBeDefined();
      expect(composed).toBeDefined();
      expect(decomposed!.expected.message_hash_sha256).toBe(composed!.expected.message_hash_sha256);
      expect(decomposed!.expected.request_hash_sha256).toBe(composed!.expected.request_hash_sha256);
    });

    it("line endings: CRLF and LF produce identical hashes", () => {
      const crlf = golden.vectors.find((v) => v.name === "line-endings-crlf");
      const lf = golden.vectors.find((v) => v.name === "line-endings-lf");
      expect(crlf!.expected.message_hash_sha256).toBe(lf!.expected.message_hash_sha256);
      expect(crlf!.expected.request_hash_sha256).toBe(lf!.expected.request_hash_sha256);
    });

    it("key ordering: forward and reverse key order produce identical hashes", () => {
      const a = golden.vectors.find((v) => v.name === "key-ordering-a-b-c");
      const b = golden.vectors.find((v) => v.name === "key-ordering-c-b-a");
      expect(a!.expected.message_hash_sha256).toBe(b!.expected.message_hash_sha256);
      expect(a!.expected.request_hash_sha256).toBe(b!.expected.request_hash_sha256);
    });

    it("metadata excluded: adding metadata does not change either hash", () => {
      const simple = golden.vectors.find((v) => v.name === "single-user-message");
      const withMeta = golden.vectors.find((v) => v.name === "metadata-excluded");
      expect(simple!.expected.message_hash_sha256).toBe(withMeta!.expected.message_hash_sha256);
      expect(simple!.expected.request_hash_sha256).toBe(withMeta!.expected.request_hash_sha256);
    });

    it("sampling params change request_hash but NOT message_hash", () => {
      const base = computeRequestFingerprint({
        messages: [{ role: "user", content: "hello" }],
      });
      const withTemp = computeRequestFingerprint({
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.5,
      });
      // Same messages → same message_hash.
      expect(base.message_hash).toBe(withTemp.message_hash);
      // Different sampling → different request_hash.
      expect(base.request_hash).not.toBe(withTemp.request_hash);
    });

    it("system message changes request_hash but NOT message_hash", () => {
      const base = computeRequestFingerprint({
        messages: [{ role: "user", content: "hello" }],
      });
      const withSystem = computeRequestFingerprint({
        messages: [{ role: "user", content: "hello" }],
        system: "You are helpful.",
      });
      expect(base.message_hash).toBe(withSystem.message_hash);
      expect(base.request_hash).not.toBe(withSystem.request_hash);
    });

    it("tools change request_hash but NOT message_hash", () => {
      const base = computeRequestFingerprint({
        messages: [{ role: "user", content: "hello" }],
      });
      const withTools = computeRequestFingerprint({
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "foo" }],
      });
      expect(base.message_hash).toBe(withTools.message_hash);
      expect(base.request_hash).not.toBe(withTools.request_hash);
    });
  });

  describe("computeRequestFingerprint options", () => {
    it("threads promptId + promptVersion into the output", () => {
      const fp = computeRequestFingerprint(
        { messages: [{ role: "user", content: "hi" }] },
        { promptId: "triage@v3.2", promptVersion: "2026-08-01" },
      );
      expect(fp.prompt_id).toBe("triage@v3.2");
      expect(fp.prompt_version).toBe("2026-08-01");
    });

    it("omits promptId when not supplied", () => {
      const fp = computeRequestFingerprint({ messages: [{ role: "user", content: "hi" }] });
      expect(fp.prompt_id).toBeUndefined();
      expect(fp.prompt_version).toBeUndefined();
    });

    it("input_char_count matches the canonical message form length", () => {
      const fp = computeRequestFingerprint({ messages: [{ role: "user", content: "Hello" }] });
      // Canonical: [{"content":"Hello","role":"user"}] = 35 chars
      expect(fp.input_char_count).toBe(35);
    });

    it("HMAC requires a key; throws otherwise", () => {
      expect(() =>
        computeRequestFingerprint(
          { messages: [{ role: "user", content: "hi" }] },
          { algorithm: "hmac-sha256" },
        ),
      ).toThrow(/requires an hmacKey/);
    });

    it("HMAC key is validated (must be at least 16 UTF-8 bytes)", () => {
      expect(() =>
        computeRequestFingerprint(
          { messages: [{ role: "user", content: "hi" }] },
          { algorithm: "hmac-sha256", hmacKey: "short" },
        ),
      ).toThrow(/at least 16/);
    });

    it("SHA-256 and HMAC produce different hashes for the same input", () => {
      const request = { messages: [{ role: "user", content: "hi" }] };
      const sha = computeRequestFingerprint(request, { algorithm: "sha256" });
      const hmac = computeRequestFingerprint(request, {
        algorithm: "hmac-sha256",
        hmacKey: "0123456789abcdef0123456789abcdef",
      });
      expect(sha.message_hash).not.toBe(hmac.message_hash);
      expect(sha.request_hash).not.toBe(hmac.request_hash);
      expect(sha.hash_algorithm).toBe("sha256");
      expect(hmac.hash_algorithm).toBe("hmac-sha256");
    });
  });

  describe("Determinism", () => {
    it("same input twice produces the same fingerprint", () => {
      const request = {
        messages: [{ role: "user", content: "test" }],
        temperature: 0.7,
        max_tokens: 100,
      };
      const fp1 = computeRequestFingerprint(request);
      const fp2 = computeRequestFingerprint(request);
      expect(fp1).toEqual(fp2);
    });

    it("hash matches sha256Hex of the canonical form (direct verification)", () => {
      // Verifies the fingerprint is exactly what a consumer would produce
      // manually: canonicalize → sha256.
      const messages = [{ role: "user", content: "hi" }];
      const fp = computeRequestFingerprint({ messages });
      const manual = sha256Hex('[{"content":"hi","role":"user"}]');
      expect(fp.message_hash).toBe(manual);
    });
  });
});
