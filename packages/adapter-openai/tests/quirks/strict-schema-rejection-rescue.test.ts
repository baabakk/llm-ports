/**
 * Issue #46 — strict-schema-rejection rescue trigger.
 *
 * Verifies that `isJsonModeRejection` matches OpenAI native's strict-schema-
 * validation rejection (not just the alpha.14/.15-era Cerebras silent-ignore
 * case). The rescue downgrade (drop `response_format`, fall back to prompted
 * JSON) is the same; only the trigger pattern was too narrow.
 *
 * Empirical evidence motivating these tests: 2026-06-17 ADW probe found that
 * `port.generateStructured({ schema: schemaWithZRecord })` against OpenAI
 * native returned a detailed 400 (`"Invalid schema for response_format...
 * Extra required key 'X' supplied"`) but the rescue never fired because the
 * matcher looked for `"unsupported"` / `"not support"` / `"does not"` and
 * didn't recognize `"invalid schema"` / `"extra required"`.
 */

import { describe, expect, it } from "vitest";
import { isJsonModeRejection } from "../../src/capabilities.js";

/** Build an error in the shape the OpenAI SDK throws for a 400 response. */
function buildOpenAIError(opts: {
  status: number;
  message: string;
  code?: string;
  param?: string;
  type?: string;
}): Error {
  const err = new Error(opts.message) as Error & {
    status: number;
    error: { message: string; code?: string; param?: string; type?: string };
  };
  err.status = opts.status;
  err.error = {
    message: opts.message,
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    ...(opts.param !== undefined ? { param: opts.param } : {}),
    ...(opts.type !== undefined ? { type: opts.type } : {}),
  };
  return err;
}

describe("Issue #46 — isJsonModeRejection covers OpenAI strict-schema-rejection", () => {
  describe("OpenAI strict-schema-validation rejection (alpha.21+)", () => {
    it("matches `Invalid schema for response_format... Extra required key` (the empirical case from the 2026-06-17 probe)", () => {
      const err = buildOpenAIError({
        status: 400,
        message:
          "Invalid schema for response_format 'TPMContract': In context=('properties', 'metadata'): Extra required key 'confidenceMap' supplied.",
        code: "invalid_value",
        param: "response_format",
        type: "invalid_request_error",
      });
      expect(isJsonModeRejection(err)).toBe(true);
    });

    it("matches message-only form (no code/param fields)", () => {
      const err = buildOpenAIError({
        status: 400,
        message:
          "Invalid schema for response_format 'X': 'properties' must be specified when type is object.",
      });
      expect(isJsonModeRejection(err)).toBe(true);
    });

    it("matches `Missing required` variant for response_format", () => {
      const err = buildOpenAIError({
        status: 400,
        message:
          "Invalid schema for response_format 'X': missing required key 'description'.",
      });
      expect(isJsonModeRejection(err)).toBe(true);
    });

    it("matches structured `code: invalid_value, param: response_format` shape", () => {
      const err = buildOpenAIError({
        status: 400,
        message: "Some message without the obvious keywords.",
        code: "invalid_value",
        param: "response_format",
      });
      expect(isJsonModeRejection(err)).toBe(true);
    });
  });

  describe("Legacy alpha.14/.15-era patterns still match (regression check)", () => {
    it("structured: code=unsupported_value, param=response_format", () => {
      const err = buildOpenAIError({
        status: 400,
        message: "response_format is not supported by this model.",
        code: "unsupported_value",
        param: "response_format",
      });
      expect(isJsonModeRejection(err)).toBe(true);
    });

    it("message: `response_format ... not supported`", () => {
      const err = buildOpenAIError({
        status: 400,
        message: "The model claude-foo does not support response_format.",
      });
      expect(isJsonModeRejection(err)).toBe(true);
    });

    it("message: `response_format ... unsupported`", () => {
      const err = buildOpenAIError({
        status: 400,
        message: "response_format json_object is unsupported for this model.",
      });
      expect(isJsonModeRejection(err)).toBe(true);
    });
  });

  describe("False-positive guards", () => {
    it("does NOT match `invalid schema` without `response_format` context (tool-use error)", () => {
      const err = buildOpenAIError({
        status: 400,
        message:
          "Invalid schema for tool 'lookup': 'parameters' is required.",
        code: "invalid_value",
        param: "tools",
      });
      expect(isJsonModeRejection(err)).toBe(false);
    });

    it("does NOT match unrelated 400 about temperature", () => {
      const err = buildOpenAIError({
        status: 400,
        message: "temperature is unsupported for this model.",
        code: "unsupported_value",
        param: "temperature",
      });
      expect(isJsonModeRejection(err)).toBe(false);
    });

    it("does NOT match non-Error / non-fields input", () => {
      expect(isJsonModeRejection(undefined)).toBe(false);
      expect(isJsonModeRejection("just a string")).toBe(false);
      expect(isJsonModeRejection({})).toBe(false);
      expect(isJsonModeRejection({ status: 500 })).toBe(false);
    });

    it("does NOT match `extra required` without `response_format` context", () => {
      const err = buildOpenAIError({
        status: 400,
        message: "Extra required key 'something' supplied in the request.",
      });
      expect(isJsonModeRejection(err)).toBe(false);
    });
  });
});
