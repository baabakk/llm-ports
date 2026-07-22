/**
 * Canonicalization tests: the v1 rules produce deterministic output for
 * every scenario the spec covers. These tests pin the exact string
 * form the golden vectors depend on.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalize,
  canonicalizeString,
  canonicalMessagesForm,
  canonicalRequestForm,
  NORMALIZATION_VERSION,
  REQUEST_HASH_ALLOWED_KEYS,
} from "../src/canonicalize.js";

describe("Canonicalization v1 (§4.6)", () => {
  describe("NORMALIZATION_VERSION", () => {
    it("is currently '1'", () => {
      expect(NORMALIZATION_VERSION).toBe("1");
    });
  });

  describe("Rule 1: key ordering (lexicographic)", () => {
    it("sorts object keys at the top level", () => {
      expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    });

    it("sorts object keys recursively", () => {
      expect(canonicalize({ z: { y: 1, x: 2 }, a: { c: 3, b: 4 } })).toBe(
        '{"a":{"b":4,"c":3},"z":{"x":2,"y":1}}',
      );
    });

    it("preserves array order (rule 1 sorts keys, not arrays)", () => {
      expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    });

    it("sorts keys inside array elements", () => {
      expect(canonicalize([{ b: 1, a: 2 }, { d: 3, c: 4 }])).toBe(
        '[{"a":2,"b":1},{"c":4,"d":3}]',
      );
    });
  });

  describe("Rule 2: Unicode NFC normalization", () => {
    it("folds decomposed characters to NFC (é as combining marks → single code point)", () => {
      const decomposed = "é"; // "e" + combining acute accent
      const composed = "é"; // single "é" code point
      expect(canonicalizeString(decomposed)).toBe(composed);
    });

    it("applies to object keys, not just values", () => {
      const decomposed = "é";
      const composed = "é";
      const out = canonicalize({ [decomposed]: 1 });
      expect(out).toBe(`{"${composed}":1}`);
    });

    it("is idempotent (NFC on NFC-normalized text is a no-op)", () => {
      const composed = "é";
      expect(canonicalizeString(composed)).toBe(composed);
    });
  });

  describe("Rule 3: line-ending normalization", () => {
    it("normalizes CRLF to LF", () => {
      expect(canonicalizeString("line1\r\nline2")).toBe("line1\nline2");
    });

    it("normalizes lone CR to LF", () => {
      expect(canonicalizeString("line1\rline2")).toBe("line1\nline2");
    });

    it("preserves standalone LF", () => {
      expect(canonicalizeString("line1\nline2")).toBe("line1\nline2");
    });

    it("normalizes mixed line endings", () => {
      expect(canonicalizeString("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    });
  });

  describe("Rule 4: whitespace preservation", () => {
    it("preserves multiple spaces inside string values", () => {
      expect(canonicalizeString("hello    world")).toBe("hello    world");
    });

    it("preserves leading and trailing whitespace", () => {
      expect(canonicalizeString("  padded  ")).toBe("  padded  ");
    });

    it("preserves tabs", () => {
      expect(canonicalizeString("col1\tcol2")).toBe("col1\tcol2");
    });
  });

  describe("Non-JSON values", () => {
    it("converts undefined to null", () => {
      expect(canonicalize({ a: undefined })).toBe('{"a":null}');
    });

    it("converts NaN to null", () => {
      expect(canonicalize({ a: NaN })).toBe('{"a":null}');
    });

    it("converts Infinity to null", () => {
      expect(canonicalize({ a: Infinity, b: -Infinity })).toBe('{"a":null,"b":null}');
    });

    it("converts bigint to its string representation", () => {
      expect(canonicalize({ big: BigInt("9007199254740993") })).toBe(
        '{"big":"9007199254740993"}',
      );
    });

    it("handles nested arrays and objects", () => {
      expect(canonicalize({ arr: [1, [2, 3], { x: 4 }], obj: { y: [5] } })).toBe(
        '{"arr":[1,[2,3],{"x":4}],"obj":{"y":[5]}}',
      );
    });
  });

  describe("Determinism across equivalent inputs", () => {
    it("same input twice produces the same output", () => {
      const input = { b: 1, a: [{ z: 2, y: 3 }] };
      expect(canonicalize(input)).toBe(canonicalize(input));
    });

    it("different key orderings produce the same output", () => {
      expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    });

    it("different Unicode encodings produce the same output", () => {
      const withDecomposed = { name: "café" };
      const withComposed = { name: "café" };
      expect(canonicalize(withDecomposed)).toBe(canonicalize(withComposed));
    });

    it("different line-ending styles produce the same output", () => {
      const crlf = { text: "line1\r\nline2" };
      const lf = { text: "line1\nline2" };
      expect(canonicalize(crlf)).toBe(canonicalize(lf));
    });
  });

  describe("canonicalMessagesForm (excludes non-message content)", () => {
    it("canonicalizes a message array", () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];
      expect(canonicalMessagesForm(messages)).toBe(
        '[{"content":"hello","role":"user"},{"content":"hi","role":"assistant"}]',
      );
    });
  });

  describe("canonicalRequestForm (allowed keys only)", () => {
    it("filters to REQUEST_HASH_ALLOWED_KEYS", () => {
      const request: Record<string, unknown> = {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.5,
        max_tokens: 100,
        metadata: { should: "be excluded" },
        providerExtras: { also: "excluded" },
        signal: null,
      };
      const out = canonicalRequestForm(request);
      expect(out).toContain("messages");
      expect(out).toContain("temperature");
      expect(out).toContain("max_tokens");
      expect(out).not.toContain("metadata");
      expect(out).not.toContain("providerExtras");
      expect(out).not.toContain("signal");
    });

    it("includes all documented allowed keys when present", () => {
      const request: Record<string, unknown> = {};
      for (const key of REQUEST_HASH_ALLOWED_KEYS) {
        request[key] = "test-value";
      }
      const out = canonicalRequestForm(request);
      for (const key of REQUEST_HASH_ALLOWED_KEYS) {
        expect(out).toContain(key);
      }
    });

    it("excludes keys NOT in the allowlist even when they contain relevant-looking content", () => {
      // Consumers may add `system_prompt` or `sampling` keys that look
      // like they belong; only the documented allowlist participates.
      const request = {
        messages: [{ role: "user", content: "x" }],
        system_prompt: "should be excluded — use 'system' or 'instructions' instead",
      };
      const out = canonicalRequestForm(request);
      expect(out).toContain("messages");
      expect(out).not.toContain("system_prompt");
    });
  });

  describe("REQUEST_HASH_ALLOWED_KEYS enumeration", () => {
    it("contains the 16 documented allowed keys", () => {
      expect(REQUEST_HASH_ALLOWED_KEYS).toHaveLength(16);
    });

    it("includes messages, system, instructions, tools, tool_choice", () => {
      expect(REQUEST_HASH_ALLOWED_KEYS).toContain("messages");
      expect(REQUEST_HASH_ALLOWED_KEYS).toContain("system");
      expect(REQUEST_HASH_ALLOWED_KEYS).toContain("instructions");
      expect(REQUEST_HASH_ALLOWED_KEYS).toContain("tools");
      expect(REQUEST_HASH_ALLOWED_KEYS).toContain("tool_choice");
    });

    it("includes response_format, schema (structured-output shape)", () => {
      expect(REQUEST_HASH_ALLOWED_KEYS).toContain("response_format");
      expect(REQUEST_HASH_ALLOWED_KEYS).toContain("schema");
    });

    it("includes all sampling parameters", () => {
      for (const key of ["temperature", "top_p", "top_k", "max_tokens", "frequency_penalty", "presence_penalty", "stop_sequences", "seed", "reasoning_effort"]) {
        expect(REQUEST_HASH_ALLOWED_KEYS).toContain(key);
      }
    });
  });
});
