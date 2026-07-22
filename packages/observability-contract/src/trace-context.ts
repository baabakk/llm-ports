/**
 * W3C Trace Context + Baggage per Plan 58 v0.4 §4.11.
 *
 * The contract uses the W3C standard string-header form (`traceparent` /
 * `tracestate`), not the raw `trace_id` + `span_id` fields. Consumers who
 * need the parsed IDs derive them from the string form via a validator.
 *
 * Baggage handling rules (per W3C spec):
 *
 *   - Grammar: list of entries; each `key OWS "=" OWS value *( OWS ";" OWS property )`.
 *   - Values are `baggage-octet` chars; percent-encoded outside that range.
 *   - Guaranteed propagation thresholds: ≤64 members AND ≤8192 bytes total.
 *     Platforms may support higher; the contract propagates all entries
 *     within these thresholds and may drop when either is exceeded.
 *   - Allowlist required (via CapturePolicy.baggage_allowlist). Empty
 *     by default.
 *
 * Security norm: never put secrets, authentication tokens, or PII in
 * Baggage. Use opaque identifiers that resolve via backend lookup.
 * Baggage travels in clear.
 *
 * Cardinality warning: `user_id` and `session_id` are appropriate as
 * trace attributes but NOT as metric dimensions (they explode
 * cardinality in TSDBs).
 */

/**
 * W3C Trace Context in its standard string-header form. The port carries
 * these strings verbatim so downstream (OTel exporters, header
 * propagators) can consume them without re-serialization.
 *
 * Consumers who need parsed IDs (e.g. for direct SQL indexing) validate
 * the strings via a W3C-compliant parser at their sink boundary.
 */
export interface TraceContext {
  /**
   * W3C `traceparent` header value. Format:
   *   `<version>-<trace-id>-<parent-id>-<trace-flags>`
   * Example:
   *   `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
   */
  traceparent?: string;

  /**
   * W3C `tracestate` header value. Optional vendor-specific context.
   * Comma-separated key=value list per RFC 7230 tokens.
   */
  tracestate?: string;
}

/**
 * A single W3C Baggage entry. Baggage is a list of these plus optional
 * per-entry properties.
 */
export interface BaggageEntry {
  /**
   * RFC 7230 token. Consumers should treat this as opaque; the port
   * does not restrict names beyond the RFC (though the receiving
   * CapturePolicy.baggage_allowlist decides which keys propagate).
   */
  key: string;

  /**
   * baggage-octet chars per W3C spec. Values outside that range MUST
   * be percent-encoded by the emitter before wire transmission.
   */
  value: string;

  /**
   * Optional per-entry properties (rarely used in practice). Format
   * follows W3C Baggage.
   */
  properties?: Array<{ key: string; value?: string }>;
}

/**
 * The maximum number of Baggage members compliant platforms must
 * propagate together (W3C spec). Consumers who want to propagate more
 * should split into multiple contexts.
 */
export const BAGGAGE_MAX_MEMBERS = 64;

/**
 * The maximum total bytes compliant platforms must propagate (W3C spec).
 * Beyond this, entries may be dropped by intermediaries.
 */
export const BAGGAGE_MAX_BYTES = 8192;
