/**
 * Minimal Tracer / Meter surface — the subset of the OpenTelemetry API
 * this sink relies on. Consumers pass their real
 * `@opentelemetry/api` tracer + meter (which satisfy these interfaces
 * structurally), or any object that implements the same shape (test
 * spies, custom bridges, alternate telemetry SDKs).
 *
 * Declaring the interfaces here keeps the package free of a hard
 * dependency on `@opentelemetry/api`. Consumers who don't use OTel
 * still pay zero install cost; consumers who do use OTel wire their
 * tracer + meter with no shim layer.
 *
 * The shape is a strict subset of the OTel v1 API — anything on the
 * real interfaces beyond what's listed here is unused by this sink.
 */

/**
 * Span attribute value. Aligned with OTel's AttributeValue union.
 * Numbers are numeric; booleans are booleans; strings are strings;
 * arrays are homogeneous arrays of the above.
 */
export type AttributeValue =
  | string
  | number
  | boolean
  // Mutable arrays, not ReadonlyArray. `@opentelemetry/api` declares these
  // as mutable `Array<...>`, and TypeScript will not assign a
  // `readonly T[]` to a mutable `T[]`. Declaring them readonly here made a
  // real OTel `Attributes` value fail to unify with this one, forcing every
  // adopter to add an `unknown` cast when passing a real tracer to
  // `createOtelSink`. Fixed in alpha.31.1; see
  // TD-LLMPORTS-TELEMETRY-OTEL-TRACER-VARIANCE.
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>;

/** Attribute bag matching OTel's Attributes. */
export type Attributes = Record<string, AttributeValue | undefined>;

/**
 * Span status code — matches `@opentelemetry/api`'s SpanStatusCode
 * numeric values so a real OTel span accepts these unchanged.
 */
export const SPAN_STATUS_OK = 1 as const;
export const SPAN_STATUS_ERROR = 2 as const;

export type SpanStatusCode = 0 | 1 | 2;

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export interface Span {
  setAttribute(key: string, value: AttributeValue): void;
  setAttributes(attributes: Attributes): void;
  addEvent(name: string, attributes?: Attributes): void;
  recordException(exception: { message: string; name?: string; stack?: string }): void;
  setStatus(status: SpanStatus): void;
  end(): void;
}

export interface SpanOptions {
  attributes?: Attributes;
  startTime?: number | Date;
}

export interface Tracer {
  /**
   * Arity-3 to match `@opentelemetry/api`'s
   * `startSpan(name, options?, context?)`. The third parameter is opaque to
   * this sink, which never passes it, so it is declared `unknown` rather
   * than pulling `@opentelemetry/api` in as a peer dependency.
   *
   * Declaring this arity-2 (alpha.30) meant a real OTel `Tracer` would not
   * unify with this interface, because TypeScript will not widen a
   * two-parameter function type to accept a three-parameter one. Every
   * adopter had to add an `unknown` cast at the `createOtelSink` call site.
   * Fixed in alpha.31.1; see TD-LLMPORTS-TELEMETRY-OTEL-TRACER-VARIANCE.
   */
  startSpan(name: string, options?: SpanOptions, context?: unknown): Span;
}

export interface HistogramOptions {
  unit?: string;
  description?: string;
}

export interface Histogram {
  record(value: number, attributes?: Attributes): void;
}

export interface CounterOptions {
  unit?: string;
  description?: string;
}

export interface Counter {
  add(value: number, attributes?: Attributes): void;
}

export interface Meter {
  createHistogram(name: string, options?: HistogramOptions): Histogram;
  createCounter(name: string, options?: CounterOptions): Counter;
}
