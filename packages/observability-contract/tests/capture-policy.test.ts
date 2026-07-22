/**
 * CapturePolicy tests: defaults, permissive preset, capture-level enums,
 * baggage + metadata allowlist filters, convenience predicates.
 */

import { describe, expect, it } from "vitest";
import {
  contentEverExposed,
  DEFAULT_CAPTURE_POLICY,
  filterBaggageKeys,
  filterMetadataKeys,
  fingerprintingEnabled,
  newEventId,
  newOperationId,
  PERMISSIVE_CAPTURE_POLICY,
  SPEC_VERSION,
  type AnyObservabilityEvent,
  type CapturePolicy,
  type ContentCapture,
  type ErrorBodyCapture,
  type FingerprintCapture,
  type Redactor,
  type StreamChunkCapture,
} from "../src/index.js";

describe("CapturePolicy (§4.10)", () => {
  describe("DEFAULT_CAPTURE_POLICY", () => {
    it("content is 'none' (OTel semconv alignment)", () => {
      expect(DEFAULT_CAPTURE_POLICY.content).toBe("none");
    });

    it("fingerprint is 'sha256'", () => {
      expect(DEFAULT_CAPTURE_POLICY.fingerprint).toBe("sha256");
    });

    it("baggage_allowlist is empty (safest default)", () => {
      expect(DEFAULT_CAPTURE_POLICY.baggage_allowlist).toEqual([]);
    });

    it("error_body_capture is 'redacted'", () => {
      expect(DEFAULT_CAPTURE_POLICY.error_body_capture).toBe("redacted");
    });

    it("stream_chunk_capture is 'off' (aggregate telemetry per §4.8)", () => {
      expect(DEFAULT_CAPTURE_POLICY.stream_chunk_capture).toBe("off");
    });

    it("has no redactor by default", () => {
      expect(DEFAULT_CAPTURE_POLICY.redactor).toBeUndefined();
    });

    it("has no fingerprint_key by default (sha256 does not need one)", () => {
      expect(DEFAULT_CAPTURE_POLICY.fingerprint_key).toBeUndefined();
    });

    it("has no metadata_allowlist (all attributes allowed by default)", () => {
      expect(DEFAULT_CAPTURE_POLICY.metadata_allowlist).toBeUndefined();
    });
  });

  describe("PERMISSIVE_CAPTURE_POLICY", () => {
    it("captures content in full (for local dev)", () => {
      expect(PERMISSIVE_CAPTURE_POLICY.content).toBe("full");
    });

    it("captures error body in full", () => {
      expect(PERMISSIVE_CAPTURE_POLICY.error_body_capture).toBe("full");
    });

    it("keeps baggage_allowlist EMPTY even in permissive mode (baggage crosses services)", () => {
      // Permissive is intentional about NOT loosening the baggage
      // allowlist: baggage keys propagate to downstream services in
      // clear, and "permissive for local dev" does not want to leak
      // cross-service.
      expect(PERMISSIVE_CAPTURE_POLICY.baggage_allowlist).toEqual([]);
    });

    it("keeps stream_chunk_capture OFF (volume concern, not privacy)", () => {
      // The permissive preset is about content/error visibility for
      // local dev; per-chunk streaming is a volume decision, not a
      // privacy decision, so it stays off.
      expect(PERMISSIVE_CAPTURE_POLICY.stream_chunk_capture).toBe("off");
    });
  });

  describe("Capture-level enum values", () => {
    it("ContentCapture has 4 documented levels", () => {
      const levels: ContentCapture[] = ["none", "metadata_only", "redacted", "full"];
      expect(levels).toHaveLength(4);
    });

    it("FingerprintCapture has 3 documented levels", () => {
      const levels: FingerprintCapture[] = ["disabled", "sha256", "hmac_sha256"];
      expect(levels).toHaveLength(3);
    });

    it("ErrorBodyCapture has 3 documented levels", () => {
      const levels: ErrorBodyCapture[] = ["none", "redacted", "full"];
      expect(levels).toHaveLength(3);
    });

    it("StreamChunkCapture has 3 documented levels", () => {
      const levels: StreamChunkCapture[] = ["off", "sampled", "full"];
      expect(levels).toHaveLength(3);
    });
  });

  describe("contentEverExposed predicate", () => {
    it("returns false for content=none", () => {
      expect(contentEverExposed({ ...DEFAULT_CAPTURE_POLICY, content: "none" })).toBe(false);
    });

    it("returns false for content=metadata_only", () => {
      expect(contentEverExposed({ ...DEFAULT_CAPTURE_POLICY, content: "metadata_only" })).toBe(false);
    });

    it("returns true for content=redacted", () => {
      expect(contentEverExposed({ ...DEFAULT_CAPTURE_POLICY, content: "redacted" })).toBe(true);
    });

    it("returns true for content=full", () => {
      expect(contentEverExposed({ ...DEFAULT_CAPTURE_POLICY, content: "full" })).toBe(true);
    });
  });

  describe("fingerprintingEnabled predicate", () => {
    it("returns false for fingerprint=disabled", () => {
      expect(fingerprintingEnabled({ ...DEFAULT_CAPTURE_POLICY, fingerprint: "disabled" })).toBe(false);
    });

    it("returns true for fingerprint=sha256", () => {
      expect(fingerprintingEnabled(DEFAULT_CAPTURE_POLICY)).toBe(true);
    });

    it("returns true for fingerprint=hmac_sha256", () => {
      const p: CapturePolicy = {
        ...DEFAULT_CAPTURE_POLICY,
        fingerprint: "hmac_sha256",
        fingerprint_key: "0123456789abcdef0123456789abcdef",
      };
      expect(fingerprintingEnabled(p)).toBe(true);
    });
  });

  describe("filterBaggageKeys", () => {
    it("returns [] when allowlist is empty", () => {
      expect(filterBaggageKeys(DEFAULT_CAPTURE_POLICY, ["tenant_id", "user_id"])).toEqual([]);
    });

    it("returns only allowlisted keys", () => {
      const p: CapturePolicy = { ...DEFAULT_CAPTURE_POLICY, baggage_allowlist: ["tenant_id"] };
      expect(filterBaggageKeys(p, ["tenant_id", "user_id", "secret"])).toEqual(["tenant_id"]);
    });

    it("returns all input keys when all are allowlisted", () => {
      const p: CapturePolicy = {
        ...DEFAULT_CAPTURE_POLICY,
        baggage_allowlist: ["tenant_id", "feature_flag"],
      };
      expect(filterBaggageKeys(p, ["tenant_id", "feature_flag"])).toEqual([
        "tenant_id",
        "feature_flag",
      ]);
    });

    it("is case-sensitive", () => {
      const p: CapturePolicy = { ...DEFAULT_CAPTURE_POLICY, baggage_allowlist: ["Tenant_ID"] };
      expect(filterBaggageKeys(p, ["tenant_id", "Tenant_ID"])).toEqual(["Tenant_ID"]);
    });
  });

  describe("filterMetadataKeys", () => {
    it("allows all keys when metadata_allowlist is undefined", () => {
      expect(filterMetadataKeys(DEFAULT_CAPTURE_POLICY, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    });

    it("allows no keys when metadata_allowlist is empty array (explicit disable)", () => {
      const p: CapturePolicy = { ...DEFAULT_CAPTURE_POLICY, metadata_allowlist: [] };
      expect(filterMetadataKeys(p, ["a", "b"])).toEqual([]);
    });

    it("allows only listed keys", () => {
      const p: CapturePolicy = {
        ...DEFAULT_CAPTURE_POLICY,
        metadata_allowlist: ["tier", "region"],
      };
      expect(filterMetadataKeys(p, ["tier", "region", "secret"])).toEqual(["tier", "region"]);
    });
  });

  describe("Redactor shape", () => {
    it("consumer-supplied redactor transforms events", () => {
      const redactor: Redactor = (event) => ({
        ...event,
        data: typeof event.data === "object" && event.data !== null
          ? { ...event.data, redacted: true }
          : event.data,
      });

      const p: CapturePolicy = { ...DEFAULT_CAPTURE_POLICY, redactor };
      expect(p.redactor).toBeDefined();

      const event: AnyObservabilityEvent = {
        spec_version: SPEC_VERSION,
        event_id: newEventId(),
        event_type: "test",
        occurred_at: "2026-08-05T00:00:00Z",
        emitted_at: "2026-08-05T00:00:00Z",
        source: { library: "test", library_version: "0.0.0" },
        operation_id: newOperationId(),
        data: { message: "some content" },
      };
      const redacted = p.redactor!(event);
      expect((redacted.data as { redacted: boolean }).redacted).toBe(true);
    });
  });

  describe("Full policy compilation examples", () => {
    it("compiles a regulated-environment policy (HMAC fingerprint + tight baggage)", () => {
      const p: CapturePolicy = {
        content: "none",
        fingerprint: "hmac_sha256",
        fingerprint_key: "0123456789abcdef0123456789abcdef", // rotated per key-management policy
        baggage_allowlist: ["tenant_id", "feature_flag"],
        metadata_allowlist: ["region", "tier"],
        error_body_capture: "none", // regulated envs strip error bodies entirely
        stream_chunk_capture: "off",
      };
      expect(p.fingerprint).toBe("hmac_sha256");
      expect(p.error_body_capture).toBe("none");
    });

    it("compiles a debugging policy (aggressive capture in a controlled dev env)", () => {
      const p: CapturePolicy = {
        ...PERMISSIVE_CAPTURE_POLICY,
        stream_chunk_capture: "sampled", // per-chunk for latency investigation
      };
      expect(p.content).toBe("full");
      expect(p.stream_chunk_capture).toBe("sampled");
    });
  });
});
