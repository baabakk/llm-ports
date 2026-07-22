/**
 * Hash primitive tests: sha256, hmac-sha256, and the combined hash()
 * dispatcher. Deterministic across Node versions.
 */

import { describe, expect, it } from "vitest";
import { hash, hmacSha256Hex, sha256Hex } from "../src/hash.js";

describe("Hash primitives (§4.6)", () => {
  describe("sha256Hex", () => {
    it("returns a 64-character hex string", () => {
      const digest = sha256Hex("hello");
      expect(digest).toHaveLength(64);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces the well-known SHA-256 digest of an empty string", () => {
      // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
      expect(sha256Hex("")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    });

    it("produces the well-known SHA-256 digest of 'hello world'", () => {
      // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
      expect(sha256Hex("hello world")).toBe(
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      );
    });

    it("is deterministic across invocations", () => {
      const input = '{"a":1,"b":[2,3]}';
      expect(sha256Hex(input)).toBe(sha256Hex(input));
    });

    it("differs on any change to input", () => {
      const a = sha256Hex("hello");
      const b = sha256Hex("hellp");
      expect(a).not.toBe(b);
    });

    it("handles Unicode strings correctly (UTF-8 encoded before hashing)", () => {
      const emoji = sha256Hex("Hello 👋");
      expect(emoji).toHaveLength(64);
      expect(sha256Hex("Hello 👋")).toBe(emoji);
    });
  });

  describe("hmacSha256Hex", () => {
    const validKey = "0123456789abcdef"; // 16 UTF-8 bytes; meets the minimum

    it("returns a 64-character hex string", () => {
      const digest = hmacSha256Hex(validKey, "hello");
      expect(digest).toHaveLength(64);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces a different digest than plain sha256", () => {
      const plain = sha256Hex("hello");
      const keyed = hmacSha256Hex(validKey, "hello");
      expect(plain).not.toBe(keyed);
    });

    it("is deterministic (same key + same input = same digest)", () => {
      expect(hmacSha256Hex(validKey, "test")).toBe(hmacSha256Hex(validKey, "test"));
    });

    it("differs when the key changes", () => {
      const k1 = hmacSha256Hex(validKey, "same input");
      const k2 = hmacSha256Hex("fedcba9876543210", "same input");
      expect(k1).not.toBe(k2);
    });

    it("differs when the input changes", () => {
      const i1 = hmacSha256Hex(validKey, "input A");
      const i2 = hmacSha256Hex(validKey, "input B");
      expect(i1).not.toBe(i2);
    });

    it("rejects keys shorter than 16 UTF-8 bytes", () => {
      expect(() => hmacSha256Hex("shortkey", "input")).toThrow(/at least 16/);
      expect(() => hmacSha256Hex("", "input")).toThrow(/at least 16/);
      expect(() => hmacSha256Hex("15-byte-key----", "input")).toThrow(/at least 16/);
    });

    it("accepts exactly 16-byte keys", () => {
      expect(() => hmacSha256Hex("exactly-16-bytes", "input")).not.toThrow();
    });

    it("counts UTF-8 bytes, not characters (emoji-heavy short keys pass minimum)", () => {
      // "🔑🔑🔑🔑" is 4 emoji = 4 * 4 = 16 UTF-8 bytes; but only 4 code-point characters.
      expect(() => hmacSha256Hex("🔑🔑🔑🔑", "input")).not.toThrow();
    });
  });

  describe("hash() dispatcher", () => {
    it("delegates 'sha256' to sha256Hex", () => {
      expect(hash("sha256", "hello")).toBe(sha256Hex("hello"));
    });

    it("delegates 'hmac-sha256' to hmacSha256Hex with the supplied key", () => {
      const key = "0123456789abcdef";
      expect(hash("hmac-sha256", "hello", key)).toBe(hmacSha256Hex(key, "hello"));
    });

    it("throws on 'hmac-sha256' without a key", () => {
      expect(() => hash("hmac-sha256", "hello")).toThrow(/requires an hmacKey/);
    });

    it("ignores the hmacKey when algorithm is sha256 (no-op, not an error)", () => {
      // Passing a key on plain sha256 is harmless; the key is ignored.
      expect(hash("sha256", "hello", "any-key-value-here")).toBe(sha256Hex("hello"));
    });
  });
});
