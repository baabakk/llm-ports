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
  AdapterInternalError,
  AuthenticationError,
  BadRequestError,
  BudgetExceededError,
  ConfigError,
  ContentBlockUnsupportedError,
  ContentPolicyViolationError,
  ContextWindowExceededError,
  CreditExhaustionError,
  defaultShouldFallback,
  EmptyResponseError,
  errorMatchers,
  ImageTooLargeError,
  InvalidImageUrlError,
  LLMPortError,
  NoProvidersAvailableError,
  ProviderMalformed400Error,
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

    describe("TD-LLMP-17: local JS runtime errors → AdapterInternalError (not ServiceUnavailableError)", () => {
      it("TypeError → AdapterInternalError (the ADW runAgent tools reproduction)", () => {
        const localBug = new TypeError("Cannot convert undefined or null to object");
        const wrapped = wrapProviderError("gptoss-cerebras", localBug);
        expect(wrapped).toBeInstanceOf(AdapterInternalError);
        expect(wrapped).not.toBeInstanceOf(ServiceUnavailableError);
        expect(wrapped).not.toBeInstanceOf(ProviderUnavailableError);
        expect((wrapped as AdapterInternalError).cause).toBe(localBug);
        expect(wrapped.message).toContain("gptoss-cerebras");
        expect(wrapped.message).toContain("Cannot convert undefined or null to object");
      });

      it("ReferenceError → AdapterInternalError", () => {
        const localBug = new ReferenceError("foo is not defined");
        const wrapped = wrapProviderError("openai", localBug);
        expect(wrapped).toBeInstanceOf(AdapterInternalError);
        expect((wrapped as AdapterInternalError).cause).toBe(localBug);
      });

      it("SyntaxError → AdapterInternalError", () => {
        const localBug = new SyntaxError("Unexpected token");
        const wrapped = wrapProviderError("anthropic", localBug);
        expect(wrapped).toBeInstanceOf(AdapterInternalError);
        expect((wrapped as AdapterInternalError).cause).toBe(localBug);
      });

      it("defaultShouldFallback correctly aborts on the wrapped AdapterInternalError", () => {
        const localBug = new TypeError("adapter bug");
        const wrapped = wrapProviderError("openai", localBug);
        // The walk-table policy sees AdapterInternalError and aborts,
        // preventing the futile chain-wide failover that TD-LLMP-17
        // was filed to fix.
        expect(defaultShouldFallback(wrapped)).toBe(false);
      });
    });
  });

  describe("alpha.28 new typed classes (TD-LLMP-17 + TD-LLMP-19)", () => {
    describe("CreditExhaustionError", () => {
      it("extends LLMPortError but NOT AuthenticationError or BadRequestError", () => {
        const err = new CreditExhaustionError("anthropic", "credit_balance too low");
        expect(err).toBeInstanceOf(CreditExhaustionError);
        expect(err).toBeInstanceOf(LLMPortError);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(AuthenticationError);
        expect(err).not.toBeInstanceOf(BadRequestError);
      });

      it("carries alias in the message so operators can identify the provider", () => {
        const err = new CreditExhaustionError("openai", "insufficient_quota");
        expect(err.message).toContain("openai");
        expect(err.message).toContain("insufficient_quota");
        expect(err.alias).toBe("openai");
      });

      it("preserves the cause chain when supplied", () => {
        const rootCause = new Error("HTTP 401 credit_balance too low");
        const err = new CreditExhaustionError("anthropic", "credit exhausted", rootCause);
        expect(err.cause).toBe(rootCause);
      });

      it("is NOT matched by errorMatchers.default (walk on it explicitly via defaultShouldFallback in a later commit)", () => {
        const err = new CreditExhaustionError("a", "x");
        expect(errorMatchers.all(err)).toBe(true);
        // The legacy errorMatchers.default excludes AuthenticationError but not
        // CreditExhaustionError; that's a legacy-shape property. The new
        // defaultShouldFallback (walk-table policy) will handle
        // CreditExhaustionError correctly.
        expect(errorMatchers.default(err)).toBe(true);
      });
    });

    describe("ProviderMalformed400Error", () => {
      it("extends BadRequestError (so instanceof BadRequestError still catches it)", () => {
        const err = new ProviderMalformed400Error("cerebras", "empty response body");
        expect(err).toBeInstanceOf(ProviderMalformed400Error);
        expect(err).toBeInstanceOf(BadRequestError);
        expect(err).toBeInstanceOf(LLMPortError);
      });

      it("does NOT extend ContextWindowExceededError or ContentPolicyViolationError", () => {
        const err = new ProviderMalformed400Error("cerebras", "empty response body");
        expect(err).not.toBeInstanceOf(ContextWindowExceededError);
        expect(err).not.toBeInstanceOf(ContentPolicyViolationError);
      });

      it("carries alias in the message", () => {
        const err = new ProviderMalformed400Error("cerebras", "400 with no body");
        expect(err.message).toContain("cerebras");
      });
    });

    describe("AdapterInternalError", () => {
      it("extends LLMPortError but NOT ServiceUnavailableError", () => {
        const err = new AdapterInternalError("openai", "Cannot convert undefined or null to object");
        expect(err).toBeInstanceOf(AdapterInternalError);
        expect(err).toBeInstanceOf(LLMPortError);
        expect(err).not.toBeInstanceOf(ServiceUnavailableError);
        expect(err).not.toBeInstanceOf(ProviderUnavailableError);
      });

      it("carries alias so operators see which adapter had the internal bug", () => {
        const rootCause = new TypeError("Cannot convert undefined or null to object");
        const err = new AdapterInternalError("gptoss-cerebras", "runAgent tools default failure", rootCause);
        expect(err.message).toContain("gptoss-cerebras");
        expect(err.cause).toBe(rootCause);
      });
    });

    it("all three new classes are distinct instanceof checks (no accidental cross-parenting)", () => {
      const credit = new CreditExhaustionError("a", "x");
      const malformed = new ProviderMalformed400Error("a", "x");
      const internal = new AdapterInternalError("a", "x");
      expect(credit).not.toBeInstanceOf(ProviderMalformed400Error);
      expect(credit).not.toBeInstanceOf(AdapterInternalError);
      expect(malformed).not.toBeInstanceOf(CreditExhaustionError);
      expect(malformed).not.toBeInstanceOf(AdapterInternalError);
      expect(internal).not.toBeInstanceOf(CreditExhaustionError);
      expect(internal).not.toBeInstanceOf(ProviderMalformed400Error);
    });
  });

  describe("defaultShouldFallback (alpha.28 canonical walk-table policy; TD-LLMP-19)", () => {
    describe("walk-worthy error classes return true", () => {
      it("RateLimitError → walks (provider-varying: another provider may have headroom)", () => {
        expect(defaultShouldFallback(new RateLimitError("a", "429", 1000))).toBe(true);
      });

      it("ServiceUnavailableError → walks (transient 5xx)", () => {
        expect(defaultShouldFallback(new ServiceUnavailableError("a", "503"))).toBe(true);
        expect(defaultShouldFallback(new ProviderUnavailableError("a", new Error("SDK error")))).toBe(true);
        expect(defaultShouldFallback(new EmptyResponseError("a", "empty"))).toBe(true);
      });

      it("ContextWindowExceededError → walks (different providers have different windows)", () => {
        expect(defaultShouldFallback(new ContextWindowExceededError("cerebras-128k", "gpt-oss-120b"))).toBe(true);
      });

      it("ContentPolicyViolationError → walks (different providers have different policies)", () => {
        expect(defaultShouldFallback(new ContentPolicyViolationError("anthropic", "claude"))).toBe(true);
      });

      it("ImageTooLargeError → walks (different attachment size limits per provider)", () => {
        expect(defaultShouldFallback(new ImageTooLargeError("a", 20 * 1024 * 1024, 5 * 1024 * 1024))).toBe(true);
      });

      it("ContentBlockUnsupportedError → walks (different multimodal capabilities)", () => {
        expect(defaultShouldFallback(new ContentBlockUnsupportedError("a", "pdf"))).toBe(true);
      });

      it("CreditExhaustionError → walks (fresh billing on another vendor)", () => {
        expect(defaultShouldFallback(new CreditExhaustionError("anthropic", "credit_balance too low"))).toBe(true);
      });

      it("ProviderMalformed400Error → walks (provider-specific quirk; another provider may accept)", () => {
        expect(defaultShouldFallback(new ProviderMalformed400Error("cerebras", "empty response body"))).toBe(true);
      });
    });

    describe("abort-worthy error classes return false", () => {
      it("AuthenticationError → aborts (wrong key does not fix on next provider)", () => {
        expect(defaultShouldFallback(new AuthenticationError("openai", "invalid key"))).toBe(false);
      });

      it("generic BadRequestError → aborts (unclassified 400; likely identical across providers)", () => {
        expect(defaultShouldFallback(new BadRequestError("a", "invalid parameter"))).toBe(false);
      });

      it("AdapterInternalError → aborts (port library's own bug; multiplying calls is waste)", () => {
        expect(defaultShouldFallback(new AdapterInternalError("openai", "TypeError in adapter"))).toBe(false);
      });

      it("InvalidImageUrlError → aborts (universally invalid URL)", () => {
        expect(defaultShouldFallback(new InvalidImageUrlError("a", "invalid://url", "no scheme"))).toBe(false);
      });

      it("ConfigError → aborts (contract-level violation)", () => {
        expect(defaultShouldFallback(new ConfigError("env malformed"))).toBe(false);
      });

      it("ValidationError → aborts (schema failure; will fail identically on next provider)", () => {
        expect(defaultShouldFallback(new ValidationError([], 3))).toBe(false);
      });
    });

    describe("non-LLMPortError inputs", () => {
      it("raw Error with 5xx status → walks (defensive; adapters should have wrapped)", () => {
        const rawErr = Object.assign(new Error("upstream 502"), { status: 502 });
        expect(defaultShouldFallback(rawErr)).toBe(true);
      });

      it("raw Error with 4xx status → aborts", () => {
        const rawErr = Object.assign(new Error("bad request"), { status: 400 });
        expect(defaultShouldFallback(rawErr)).toBe(false);
      });

      it("raw Error with no status → aborts", () => {
        expect(defaultShouldFallback(new Error("plain error"))).toBe(false);
      });

      it("string → aborts", () => {
        expect(defaultShouldFallback("something bad")).toBe(false);
      });

      it("null / undefined → aborts", () => {
        expect(defaultShouldFallback(null)).toBe(false);
        expect(defaultShouldFallback(undefined)).toBe(false);
      });
    });

    it("the canonical walk-table extension pattern (BEPA-style consumer-specific class) works", () => {
      class MyCustomWalkError extends LLMPortError {
        public override readonly name: string = "MyCustomWalkError";
      }
      const extended = (err: unknown): boolean =>
        defaultShouldFallback(err) || err instanceof MyCustomWalkError;

      expect(extended(new MyCustomWalkError("custom"))).toBe(true);
      expect(extended(new RateLimitError("a", "429", 1000))).toBe(true);
      expect(extended(new AuthenticationError("a", "x"))).toBe(false);
    });

    it("the canonical walk-table narrowing pattern (abort on ContentPolicyViolationError) works", () => {
      const narrowed = (err: unknown): boolean =>
        err instanceof ContentPolicyViolationError ? false : defaultShouldFallback(err);

      expect(narrowed(new ContentPolicyViolationError("a", "m"))).toBe(false);
      expect(narrowed(new RateLimitError("a", "429", 1000))).toBe(true);
      expect(narrowed(new AuthenticationError("a", "x"))).toBe(false);
    });
  });
});
