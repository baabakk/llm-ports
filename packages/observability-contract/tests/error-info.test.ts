/**
 * ErrorInfo tests: shape, rollup categories, error-type → category map.
 */

import { describe, expect, it } from "vitest";
import {
  CAUSE_CATEGORIES,
  ERROR_TYPE_TO_CATEGORY,
  errorTypeToCauseCategory,
  type CauseCategory,
  type ErrorInfo,
} from "../src/index.js";

describe("ErrorInfo (§4.4)", () => {
  describe("CAUSE_CATEGORIES enumeration", () => {
    it("contains the 8 canonical rollup categories", () => {
      expect(CAUSE_CATEGORIES).toHaveLength(8);
      const expected: CauseCategory[] = [
        "client_input",
        "provider_capacity",
        "provider_auth",
        "provider_unavailable",
        "provider_capability",
        "network",
        "port_internal",
        "unknown",
      ];
      for (const c of expected) {
        expect(CAUSE_CATEGORIES).toContain(c);
      }
    });

    it("every value is unique", () => {
      expect(new Set(CAUSE_CATEGORIES).size).toBe(CAUSE_CATEGORIES.length);
    });
  });

  describe("errorTypeToCauseCategory rollup", () => {
    it("client-input errors roll up to client_input", () => {
      expect(errorTypeToCauseCategory("MessagesRequiredError")).toBe("client_input");
      expect(errorTypeToCauseCategory("EmptyMessagesError")).toBe("client_input");
      expect(errorTypeToCauseCategory("BadRequestError")).toBe("client_input");
      expect(errorTypeToCauseCategory("InvalidImageUrlError")).toBe("client_input");
      expect(errorTypeToCauseCategory("ValidationError")).toBe("client_input");
      expect(errorTypeToCauseCategory("ConfigError")).toBe("client_input");
    });

    it("provider-capacity errors roll up correctly", () => {
      expect(errorTypeToCauseCategory("RateLimitError")).toBe("provider_capacity");
      expect(errorTypeToCauseCategory("CreditExhaustionError")).toBe("provider_capacity");
      expect(errorTypeToCauseCategory("BudgetExceededError")).toBe("provider_capacity");
    });

    it("AuthenticationError rolls up to provider_auth", () => {
      expect(errorTypeToCauseCategory("AuthenticationError")).toBe("provider_auth");
    });

    it("service-unavailable errors roll up to provider_unavailable", () => {
      expect(errorTypeToCauseCategory("ServiceUnavailableError")).toBe("provider_unavailable");
      expect(errorTypeToCauseCategory("ProviderUnavailableError")).toBe("provider_unavailable");
      expect(errorTypeToCauseCategory("EmptyResponseError")).toBe("provider_unavailable");
      expect(errorTypeToCauseCategory("NoProvidersAvailableError")).toBe("provider_unavailable");
    });

    it("provider-capability errors roll up correctly", () => {
      expect(errorTypeToCauseCategory("ContextWindowExceededError")).toBe("provider_capability");
      expect(errorTypeToCauseCategory("ContentPolicyViolationError")).toBe("provider_capability");
      expect(errorTypeToCauseCategory("ImageTooLargeError")).toBe("provider_capability");
      expect(errorTypeToCauseCategory("ContentBlockUnsupportedError")).toBe("provider_capability");
      expect(errorTypeToCauseCategory("ProviderMalformed400Error")).toBe("provider_capability");
    });

    it("AdapterInternalError rolls up to port_internal (walking would be waste)", () => {
      expect(errorTypeToCauseCategory("AdapterInternalError")).toBe("port_internal");
    });

    it("unknown error classes fall through to unknown", () => {
      expect(errorTypeToCauseCategory("MyCustomError")).toBe("unknown");
      expect(errorTypeToCauseCategory("")).toBe("unknown");
      expect(errorTypeToCauseCategory("SomeThirdPartyError")).toBe("unknown");
    });
  });

  describe("ErrorInfo shape", () => {
    it("compiles the minimum-required fields", () => {
      const minimal: ErrorInfo = {
        error_type: "RateLimitError",
        retryable: true,
        fallback_worthy: true,
        cause_category: "provider_capacity",
      };
      expect(minimal.error_type).toBe("RateLimitError");
    });

    it("compiles the full payload including transport-layer fields", () => {
      const full: ErrorInfo = {
        error_type: "RateLimitError",
        message: "Rate limit exceeded",
        retryable: true,
        fallback_worthy: true,
        cause_category: "provider_capacity",
        provider_status_code: 429,
        retry_after_ms: 5000,
        provider_error_code: "rate_limit_exceeded",
        details_redacted: false,
      };
      expect(full.retry_after_ms).toBe(5000);
      expect(full.provider_error_code).toBe("rate_limit_exceeded");
    });

    it("compiles a redacted variant (default posture per §4.10)", () => {
      const redacted: ErrorInfo = {
        error_type: "BadRequestError",
        retryable: false,
        fallback_worthy: false,
        cause_category: "client_input",
        provider_status_code: 400,
        details_redacted: true,
        // message omitted deliberately — CapturePolicy.error_body_capture = "redacted"
      };
      expect(redacted.details_redacted).toBe(true);
      expect(redacted.message).toBeUndefined();
    });

    it("supports the retryable=true + fallback_worthy=true combination (transient errors like RateLimit)", () => {
      const err: ErrorInfo = {
        error_type: "RateLimitError",
        retryable: true,
        fallback_worthy: true,
        cause_category: "provider_capacity",
      };
      expect(err.retryable).toBe(true);
      expect(err.fallback_worthy).toBe(true);
    });

    it("supports retryable=false + fallback_worthy=true (walk-only, e.g. CreditExhaustionError)", () => {
      const err: ErrorInfo = {
        error_type: "CreditExhaustionError",
        retryable: false,
        fallback_worthy: true,
        cause_category: "provider_capacity",
      };
      expect(err.retryable).toBe(false);
      expect(err.fallback_worthy).toBe(true);
    });

    it("supports retryable=false + fallback_worthy=false (abort-only, e.g. AuthenticationError)", () => {
      const err: ErrorInfo = {
        error_type: "AuthenticationError",
        retryable: false,
        fallback_worthy: false,
        cause_category: "provider_auth",
      };
      expect(err.retryable).toBe(false);
      expect(err.fallback_worthy).toBe(false);
    });

    it("supports the AdapterInternalError case (port bug; abort-only)", () => {
      const err: ErrorInfo = {
        error_type: "AdapterInternalError",
        message: "TypeError: Cannot convert undefined or null to object",
        retryable: false,
        fallback_worthy: false,
        cause_category: "port_internal",
      };
      // Alignment: port_internal category = fallback_worthy: false
      // (walking would multiply the identical local error at every hop).
      expect(err.fallback_worthy).toBe(false);
      expect(err.cause_category).toBe("port_internal");
    });
  });

  describe("ERROR_TYPE_TO_CATEGORY map completeness", () => {
    it("every rollup category has at least one error type mapped to it (except unknown)", () => {
      const usedCategories = new Set(Object.values(ERROR_TYPE_TO_CATEGORY));
      for (const category of CAUSE_CATEGORIES) {
        if (category === "unknown" || category === "network") continue;
        // Network is intentionally unmapped in the static table: adapter
        // code decides based on error shape (DNS failure, TLS error).
        expect(usedCategories.has(category)).toBe(true);
      }
    });

    it("every mapping is to a valid CauseCategory (no typos)", () => {
      for (const [errorType, category] of Object.entries(ERROR_TYPE_TO_CATEGORY)) {
        expect(CAUSE_CATEGORIES).toContain(category);
        expect(errorType.length).toBeGreaterThan(0);
      }
    });
  });
});
