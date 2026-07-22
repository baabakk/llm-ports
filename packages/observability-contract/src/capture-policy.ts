/**
 * CapturePolicy per Plan 58 v0.4 §4.10.
 *
 * The privacy contract. Every emitter reads a CapturePolicy at construction
 * time and decides how much of each event's payload actually lands on the
 * wire. Sinks may LOWER capture (drop fields the policy allowed) but MUST
 * NOT RAISE it (add content the policy declined). Defense-in-depth: the
 * emit-time policy is the ceiling; per-sink policies are floors.
 *
 * Rationale for a formal contract (from the outsider critique §10):
 *
 *   - Prompt content in observability events is not ordinary debug metadata.
 *     It commonly carries user PII, customer content, credentials, and
 *     internal system information. OTel semconv is explicit: content is
 *     opt-in, off by default.
 *
 *   - Baggage keys propagate across service boundaries in clear. Without
 *     an allowlist, a well-meaning `baggage: { session_secret: "..." }`
 *     leaks the secret to every downstream. Empty-allowlist default is
 *     safest.
 *
 *   - Error bodies frequently include the raw request payload provider
 *     received. Redacted-by-default prevents provider error responses
 *     from smuggling prompt content into an "error" event that consumers
 *     assumed was safe.
 *
 *   - Cardinality: user_id and session_id are appropriate as trace
 *     attributes but explode metric dimensions. Baggage allowlist is
 *     the enforcement point for consumer discipline.
 */

import type { AnyObservabilityEvent } from "./envelope.js";

/**
 * How much of each event's message content lands on the wire.
 *
 * "none": no message content. Fingerprints (hashes) still emit; raw
 *   messages / prompts / completions do NOT. Recommended default.
 * "metadata_only": role + count + length hints; no content bytes.
 * "redacted": content passes through a consumer-supplied redactor
 *   (regex, llm-guard, Presidio) before emission.
 * "full": content emitted verbatim. Only appropriate for local dev
 *   or fully-isolated environments (e.g. air-gapped inference).
 */
export type ContentCapture = "none" | "metadata_only" | "redacted" | "full";

/**
 * Which fingerprint algorithm (if any) the emitter uses. Distinct from
 * ContentCapture because fingerprints are content-derived but do not
 * expose the content (SHA-256 is one-way; HMAC-SHA-256 with a rotated
 * key is even one-way against dictionary attacks).
 *
 * "disabled": no fingerprint at all. Consumers who cannot store
 *   even hashes (e.g. GDPR right-to-be-forgotten with hash-as-PII
 *   interpretation) pick this.
 * "sha256": plain SHA-256. Dictionary-attackable on short predictable
 *   prompts.
 * "hmac_sha256": HMAC-SHA-256 with a consumer-supplied key
 *   (fingerprint_key). Content-preserving against dictionary attack.
 */
export type FingerprintCapture = "disabled" | "sha256" | "hmac_sha256";

/**
 * How much of an error's raw provider body lands on the wire.
 *
 * "none": no body at all; only the structured ErrorInfo fields
 *   (error_type, retryable, fallback_worthy, status code, retry_after).
 * "redacted": body passes through a consumer-supplied redactor.
 *   Recommended default.
 * "full": body verbatim. Only for local dev.
 */
export type ErrorBodyCapture = "none" | "redacted" | "full";

/**
 * How stream chunks emit per-chunk events (per §4.8 default is
 * aggregate; per-chunk is opt-in).
 *
 * "off": no per-chunk events. Aggregate telemetry only.
 * "sampled": consumer-configured sample rate; per-chunk events for a
 *   subset of chunks (e.g. every 8th).
 * "full": every chunk emits an event. Only appropriate for low-volume
 *   diagnostic runs; a 5000-chunk stream fires 5000 hook invocations.
 */
export type StreamChunkCapture = "off" | "sampled" | "full";

/**
 * A consumer-supplied redactor. Given an event, returns a redacted
 * copy suitable for the sink layer. Signature matches the OTel
 * "onEnd" transformer pattern; consumers with existing PII detectors
 * (Presidio, llm-guard, regex libraries) wrap them into this shape.
 */
export type Redactor = (event: AnyObservabilityEvent) => AnyObservabilityEvent;

/**
 * The full policy. Consumers construct one at Registry setup time
 * (or non-port emitter setup for §4.13 callers) and pass it into
 * the runtime. Runtime enforces it at event-emit time; sinks may
 * further reduce (never expand) capture.
 */
export interface CapturePolicy {
  /** Message-content capture level. Default "none". */
  content: ContentCapture;

  /** Fingerprint algorithm (or disabled). Default "sha256". */
  fingerprint: FingerprintCapture;

  /**
   * Required when `fingerprint` is "hmac_sha256". At least 16 UTF-8
   * bytes; ignored otherwise. Consumers rotate this per their own
   * key-management policy; rotating the key changes every fingerprint
   * produced.
   */
  fingerprint_key?: string;

  /**
   * Allowlist of Baggage keys that may propagate. Empty allowlist
   * blocks all Baggage (safest default). Case-sensitive exact match.
   */
  baggage_allowlist: string[];

  /**
   * Optional allowlist for consumer-defined event attributes
   * (attribute keys attached via ObservabilityContext.attributes).
   * Absent = allow all (consumer-controlled scope already limits
   * blast radius). Present + empty = allow none.
   */
  metadata_allowlist?: string[];

  /** Error-body capture level. Default "redacted". */
  error_body_capture: ErrorBodyCapture;

  /** Stream-chunk capture level. Default "off" (aggregate telemetry). */
  stream_chunk_capture: StreamChunkCapture;

  /**
   * Optional redactor applied to every event AFTER the capture-level
   * filters. When present, sinks receive the redactor's output; when
   * absent, the capture-level filter is the final say.
   */
  redactor?: Redactor;
}

/**
 * The default CapturePolicy. Aligned with OTel semconv's "content off
 * by default" stance. Consumers who need to loosen (e.g. capture
 * content in dev) construct a policy explicitly and pass it in.
 */
export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  content: "none",
  fingerprint: "sha256",
  baggage_allowlist: [],
  error_body_capture: "redacted",
  stream_chunk_capture: "off",
};

/**
 * A permissive policy for local dev / air-gapped inference. Captures
 * everything. NOT appropriate for shared services, hosted deployments,
 * or any environment where events flow to sinks the consumer does
 * not fully control.
 */
export const PERMISSIVE_CAPTURE_POLICY: CapturePolicy = {
  content: "full",
  fingerprint: "sha256",
  baggage_allowlist: [], // still empty; deliberate: baggage travels cross-service
  error_body_capture: "full",
  stream_chunk_capture: "off", // still off; chunk-level is a volume concern, not a privacy one
};

/**
 * True when a policy would allow raw message content to reach a sink.
 * Consumers auditing "did we ever ship prompts to Datadog?" check
 * this against their live policy.
 */
export function contentEverExposed(policy: CapturePolicy): boolean {
  return policy.content === "full" || policy.content === "redacted";
}

/**
 * True when the fingerprint layer is enabled at all. Consumers who
 * disabled fingerprints (e.g. for hash-as-PII interpretation) can
 * check this before assuming they have hashes to query on.
 */
export function fingerprintingEnabled(policy: CapturePolicy): boolean {
  return policy.fingerprint !== "disabled";
}

/**
 * Filter a set of proposed Baggage keys against a policy's allowlist.
 * Returns the subset that may propagate.
 */
export function filterBaggageKeys(policy: CapturePolicy, keys: string[]): string[] {
  if (policy.baggage_allowlist.length === 0) return [];
  const allow = new Set(policy.baggage_allowlist);
  return keys.filter((k) => allow.has(k));
}

/**
 * Filter a set of proposed metadata keys against a policy's allowlist.
 * When the allowlist is absent, every key is allowed. When present
 * (even if empty), only listed keys are allowed.
 */
export function filterMetadataKeys(policy: CapturePolicy, keys: string[]): string[] {
  if (policy.metadata_allowlist === undefined) return keys.slice();
  const allow = new Set(policy.metadata_allowlist);
  return keys.filter((k) => allow.has(k));
}
