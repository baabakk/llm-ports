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
  | ReadonlyArray<null | undefined | string>
  | ReadonlyArray<null | undefined | number>
  | ReadonlyArray<null | undefined | boolean>;

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
  startSpan(name: string, options?: SpanOptions): Span;
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
