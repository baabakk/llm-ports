/**
 * Typed-error taxonomy (alpha.18, TD-LLMPORTS-TYPED-ERRORS).
 *
 * Verifies:
 *   - All errors extend LLMPortError (and thus Error).
 *   - 400-class errors (ContextWindowExceededError, ContentPolicyViolationError)
 *     extend BadRequestError but NOT ServiceUnavailableError.
 *   - 503-class errors (ProviderUnavailableError, EmptyResponseError) extend
 *     ServiceUnavailableError but NOT BadRequestError.
 *   - errorMatchers semantics: rateLimit / transient / default / all.
 *   - wrapProviderError correctly classifies HTTP-shaped SDK errors.
 *   - Idempotence: typed errors are not re-wrapped.
 *
 * The adversarial check at the end asserts NO class is mis-parented (the
 * exact bug the master plan §4.2 set out to fix: ContextWindowExceededError
 * must NOT match instanceof ProviderUnavailableError).
 */

import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  BadRequestError,
  BudgetExceededError,
  ConfigError,
  ContentBlockUnsupportedError,
  ContentPolicyViolationError,
  ContextWindowExceededError,
  EmptyResponseError,
  errorMatchers,
  ImageTooLargeError,
  InvalidImageUrlError,
  LLMPortError,
  NoProvidersAvailableError,
  ProviderUnavailableError,
  RateLimitError,
  ServiceUnavailableError,
  SessionBudgetExceededError,
  ValidationError,
} from "../src/index.js";
import { wrapProviderError } from "../src/utils/wrap-provider-error.js";

describe("alpha.18 typed-error taxonomy", () => {
  describe("class hierarchy", () => {
    it("every library error extends LLMPortError + Error", () => {
      const samples: Array<LLMPortError> = [
        new BadRequestError("a", "x"),
        new ContextWindowExceededError("a", "m"),
        new ContentPolicyViolationError("a", "m"),
        new AuthenticationError("a", "x"),
        new RateLimitError("a", "x"),
        new BudgetExceededError("a", 1, 2, "cost"),
        new SessionBudgetExceededError("s", 1, 2),
        new ServiceUnavailableError("a", "x"),
        new ProviderUnavailableError("a", new Error("boom")),
        new EmptyResponseError("a", "m"),
        new NoProvidersAvailableError("t", ["a"], { a: "r" }),
        new ContentBlockUnsupportedError("a", "x"),
        new ConfigError("x"),
        new ImageTooLargeError("a", 0, 100, 50),
        new InvalidImageUrlError("a", "file://x", "scheme"),
      ];
      for (const e of samples) {
        expect(e).toBeInstanceOf(LLMPortError);
        expect(e).toBeInstanceOf(Error);
      }
    });

    it("BadRequest subclasses extend BadRequestError + LLMPortError but NOT ServiceUnavailableError", () => {
      const ctx = new ContextWindowExceededError("a", "m");
      const policy = new ContentPolicyViolationError("a", "m");

      expect(ctx).toBeInstanceOf(BadRequestError);
      expect(ctx).toBeInstanceOf(LLMPortError);
      expect(ctx).not.toBeInstanceOf(ServiceUnavailableError);
      expect(ctx).not.toBeInstanceOf(ProviderUnavailableError);

      expect(policy).toBeInstanceOf(BadRequestError);
      expect(policy).toBeInstanceOf(LLMPortError);
      expect(policy).not.toBeInstanceOf(ServiceUnavailableError);
      expect(policy).not.toBeInstanceOf(ProviderUnavailableError);
    });

    it("ServiceUnavailable subclasses extend ServiceUnavailableError but NOT BadRequestError", () => {
      const pu = new ProviderUnavailableError("a", new Error("boom"));
      const er = new EmptyResponseError("a", "m");

      expect(pu).toBeInstanceOf(ServiceUnavailableError);
      expect(pu).toBeInstanceOf(LLMPortError);
      expect(pu).not.toBeInstanceOf(BadRequestError);

      expect(er).toBeInstanceOf(ServiceUnavailableError);
      expect(er).toBeInstanceOf(LLMPortError);
      expect(er).not.toBeInstanceOf(BadRequestError);
    });

    it("AuthenticationError extends LLMPortError but NOT ServiceUnavailableError or BadRequestError", () => {
      const e = new AuthenticationError("a", "x");
      expect(e).toBeInstanceOf(LLMPortError);
      expect(e).not.toBeInstanceOf(ServiceUnavailableError);
      expect(e).not.toBeInstanceOf(BadRequestError);
    });

    it("RateLimitError extends LLMPortError but NOT ServiceUnavailableError", () => {
      const e = new RateLimitError("a", "x", 5000);
      expect(e).toBeInstanceOf(LLMPortError);
      expect(e).not.toBeInstanceOf(ServiceUnavailableError);
      expect(e.retryAfterMs).toBe(5000);
    });
  });

  describe("adversarial: no mis-parenting", () => {
    // The exact bug the alpha.18 reparenting fixes: a context-window overflow
    // is a CLIENT-fixable request error, not a transient provider failure.
    // Routing it to another provider with the same window will fail the same
    // way. The instanceof check below pins the fix.
    it("ContextWindowExceededError does NOT match instanceof ProviderUnavailableError", () => {
      const e = new ContextWindowExceededError("a", "m", 100, 200);
      expect(e).not.toBeInstanceOf(ProviderUnavailableError);
      expect(e).not.toBeInstanceOf(ServiceUnavailableError);
      expect(e).toBeInstanceOf(BadRequestError);
    });

    it("ContentPolicyViolationError does NOT match instanceof ProviderUnavailableError", () => {
      const e = new ContentPolicyViolationError("a", "m", "policy-x");
      expect(e).not.toBeInstanceOf(ProviderUnavailableError);
      expect(e).toBeInstanceOf(BadRequestError);
    });

    it("AuthenticationError does NOT match instanceof ProviderUnavailableError", () => {
      const e = new AuthenticationError("a", "401");
      expect(e).not.toBeInstanceOf(ProviderUnavailableError);
      expect(e).not.toBeInstanceOf(ServiceUnavailableError);
    });

    it("RateLimitError does NOT match instanceof ProviderUnavailableError", () => {
      const e = new RateLimitError("a", "429");
      expect(e).not.toBeInstanceOf(ProviderUnavailableError);
      expect(e).not.toBeInstanceOf(ServiceUnavailableError);
    });
  });

  describe("errorMatchers semantics", () => {
    const rateLimit = new RateLimitError("a", "429", 5000);
    const serviceUnavail = new ServiceUnavailableError("a", "503");
    const providerUnavail = new ProviderUnavailableError("a", new Error("boom"));
    const emptyResponse = new EmptyResponseError("a", "m");
    const badRequest = new BadRequestError("a", "400");
    const ctxWindow = new ContextWindowExceededError("a", "m");
    const policy = new ContentPolicyViolationError("a", "m");
    const auth = new AuthenticationError("a", "401");
    const validation = new ValidationError([], 1);
    const budget = new BudgetExceededError("a", 100, 200, "cost");
    const sessionBudget = new SessionBudgetExceededError("s", 1, 2);
    const noProv = new NoProvidersAvailableError("t", ["a"], {});
    const raw = new Error("not a library error");

    describe("rateLimit", () => {
      it("matches RateLimitError only", () => {
        expect(errorMatchers.rateLimit(rateLimit)).toBe(true);
        expect(errorMatchers.rateLimit(serviceUnavail)).toBe(false);
        expect(errorMatchers.rateLimit(providerUnavail)).toBe(false);
        expect(errorMatchers.rateLimit(badRequest)).toBe(false);
        expect(errorMatchers.rateLimit(auth)).toBe(false);
        expect(errorMatchers.rateLimit(raw)).toBe(false);
      });
    });

    describe("transient", () => {
      it("matches RateLimitError + all ServiceUnavailableError subclasses", () => {
        expect(errorMatchers.transient(rateLimit)).toBe(true);
        expect(errorMatchers.transient(serviceUnavail)).toBe(true);
        expect(errorMatchers.transient(providerUnavail)).toBe(true);
        expect(errorMatchers.transient(emptyResponse)).toBe(true);
      });

      it("does NOT match BadRequest / Auth / Validation / Budget / NoProviders", () => {
        expect(errorMatchers.transient(badRequest)).toBe(false);
        expect(errorMatchers.transient(ctxWindow)).toBe(false);
        expect(errorMatchers.transient(policy)).toBe(false);
        expect(errorMatchers.transient(auth)).toBe(false);
        expect(errorMatchers.transient(validation)).toBe(false);
        expect(errorMatchers.transient(budget)).toBe(false);
        expect(errorMatchers.transient(noProv)).toBe(false);
      });
    });

    describe("default (recommended fallback predicate)", () => {
      it("matches everything except BadRequest subclasses and AuthenticationError", () => {
        expect(errorMatchers.default(rateLimit)).toBe(true);
        expect(errorMatchers.default(serviceUnavail)).toBe(true);
        expect(errorMatchers.default(providerUnavail)).toBe(true);
        expect(errorMatchers.default(emptyResponse)).toBe(true);
        expect(errorMatchers.default(validation)).toBe(true);
        expect(errorMatchers.default(budget)).toBe(true);
        expect(errorMatchers.default(sessionBudget)).toBe(true);
        expect(errorMatchers.default(noProv)).toBe(true);
      });

      it("does NOT match BadRequest / ContextWindow / ContentPolicy / Authentication", () => {
        expect(errorMatchers.default(badRequest)).toBe(false);
        expect(errorMatchers.default(ctxWindow)).toBe(false);
        expect(errorMatchers.default(policy)).toBe(false);
        expect(errorMatchers.default(auth)).toBe(false);
      });

      it("does NOT match raw Error or non-error values", () => {
        expect(errorMatchers.default(raw)).toBe(false);
        expect(errorMatchers.default("string")).toBe(false);
        expect(errorMatchers.default(null)).toBe(false);
        expect(errorMatchers.default(undefined)).toBe(false);
      });
    });

    describe("all", () => {
      it("matches every LLMPortError subclass", () => {
        expect(errorMatchers.all(rateLimit)).toBe(true);
        expect(errorMatchers.all(badRequest)).toBe(true);
        expect(errorMatchers.all(auth)).toBe(true);
        expect(errorMatchers.all(validation)).toBe(true);
      });

      it("does NOT match raw Error or non-library values", () => {
        expect(errorMatchers.all(raw)).toBe(false);
        expect(errorMatchers.all("string")).toBe(false);
      });
    });
  });

  describe("wrapProviderError HTTP classification", () => {
    it("passes through typed LLMPortError unchanged (idempotent)", () => {
      const original = new RateLimitError("a", "429", 5000);
      const wrapped = wrapProviderError("a", original);
      expect(wrapped).toBe(original);
    });

    it("classifies status=400 with context-window message as ContextWindowExceededError", () => {
      const sdkErr = Object.assign(new Error("This model's maximum context length is 8192 tokens"), {
        status: 400,
      });
      const wrapped = wrapProviderError("a", sdkErr);
      expect(wrapped).toBeInstanceOf(ContextWindowExceededError);
      expect(wrapped).toBeInstanceOf(BadRequestError);
    });

    it("TD-LLMP-16: propagates modelId into ContextWindowExceededError when adapter passes it", () => {
      const sdkErr = Object.assign(new Error("prompt is too long"), { status: 400 });
      const wrapped = wrapProviderError("deepseek-4flash-deepinfra", sdkErr, "deepseek-ai/DeepSeek-V4-Flash");
      expect(wrapped).toBeInstanceOf(ContextWindowExceededError);
      const cwe = wrapped as ContextWindowExceededError;
      expect(cwe.modelId).toBe("deepseek-ai/DeepSeek-V4-Flash");
      expect(cwe.message).toContain('for model "deepseek-ai/DeepSeek-V4-Flash"');
      expect(cwe.message).not.toContain('"(unknown)"');
    });

    it("TD-LLMP-16: falls back to (unknown) when modelId is omitted (backwards compat)", () => {
      const sdkErr = Object.assign(new Error("prompt is too long"), { status: 400 });
      const wrapped = wrapProviderError("a", sdkErr);
      expect(wrapped).toBeInstanceOf(ContextWindowExceededError);
      const cwe = wrapped as ContextWindowExceededError;
      expect(cwe.modelId).toBe("(unknown)");
    });

    it("TD-LLMP-16: propagates modelId into ContentPolicyViolationError when adapter passes it", () => {
      const sdkErr = Object.assign(new Error("Content policy violation"), { status: 400 });
      const wrapped = wrapProviderError("openai", sdkErr, "gpt-5");
      expect(wrapped).toBeInstanceOf(ContentPolicyViolationError);
      const cpv = wrapped as ContentPolicyViolationError;
      expect(cpv.message).toContain('gpt-5');
    });

    it("classifies status=400 with content-policy message as ContentPolicyViolationError", () => {
      const sdkErr = Object.assign(new Error("This content was flagged by our safety classifier."), {
        status: 400,
      });
      const wrapped = wrapProviderError("a", sdkErr);
      expect(wrapped).toBeInstanceOf(ContentPolicyViolationError);
      expect(wrapped).toBeInstanceOf(BadRequestError);
    });

    it("classifies generic 400 as BadRequestError (not specific subclass)", () => {
      const sdkErr = Object.assign(new Error("invalid parameter"), { status: 400 });
      const wrapped = wrapProviderError("a", sdkErr);
      expect(wrapped).toBeInstanceOf(BadRequestError);
      expect(wrapped).not.toBeInstanceOf(ContextWindowExceededError);
      expect(wrapped).not.toBeInstanceOf(ContentPolicyViolationError);
    });

    it("classifies status=401 as AuthenticationError", () => {
      const sdkErr = Object.assign(new Error("Incorrect API key"), { status: 401 });
      const wrapped = wrapProviderError("a", sdkErr);
      expect(wrapped).toBeInstanceOf(AuthenticationError);
      expect(wrapped).not.toBeInstanceOf(ServiceUnavailableError);
    });

    it("classifies status=403 as AuthenticationError", () => {
      const sdkErr = Object.assign(new Error("forbidden"), { status: 403 });
      const wrapped = wrapProviderError("a", sdkErr);
      expect(wrapped).toBeInstanceOf(AuthenticationError);
    });

    it("classifies status=429 as RateLimitError with parsed retry-after-ms header", () => {
      const sdkErr = Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { "retry-after-ms": "3500" },
      });
      const wrapped = wrapProviderError("a", sdkErr);
      expect(wrapped).toBeInstanceOf(RateLimitError);
      expect((wrapped as RateLimitError).retryAfterMs).toBe(3500);
    });

    it("classifies status=429 with retry-after seconds header", () => {
      const sdkErr = Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { "retry-after": "5" },
      });
      const wrapped = wrapProviderError("a", sdkErr);
      expect(wrapped).toBeInstanceOf(RateLimitError);
      expect((wrapped as RateLimitError).retryAfterMs).toBe(5000);
    });

    it("classifies status=429 without retry-after header (retryAfterMs undefined)", () => {
      const sdkErr = Object.assign(new Error("rate limited"), { status: 429 });
      const wrapped = wrapProviderError("a", sdkErr);
      expect(wrapped).toBeInstanceOf(RateLimitError);
      expect((wrapped as RateLimitError).retryAfterMs).toBeUndefined();
    });

    it("classifies status=500/502/503/504 as ServiceUnavailableError (NOT ProviderUnavailableError specifically)", () => {
      for (const status of [500, 502, 503, 504]) {
        const sdkErr = Object.assign(new Error(`server error ${status}`), { status });
        const wrapped = wrapProviderError("a", sdkErr);
        expect(wrapped).toBeInstanceOf(ServiceUnavailableError);
        // It's the base ServiceUnavailableError, not the narrower
        // ProviderUnavailableError which is reserved for unknown-status errors.
        expect(wrapped).not.toBeInstanceOf(ProviderUnavailableError);
      }
    });

    it("classifies error without status as ProviderUnavailableError (fallback)", () => {
      const sdkErr = new Error("network reset");
      const wrapped = wrapProviderError("a", sdkErr);
      expect(wrapped).toBeInstanceOf(ProviderUnavailableError);
      expect(wrapped).toBeInstanceOf(ServiceUnavailableError);
    });

    it("stringifies non-Error values before wrapping", () => {
      const wrapped = wrapProviderError("a", "raw string");
      expect(wrapped).toBeInstanceOf(ProviderUnavailableError);
      expect((wrapped as ProviderUnavailableError).cause?.message).toBe("raw string");
    });
  });
});
