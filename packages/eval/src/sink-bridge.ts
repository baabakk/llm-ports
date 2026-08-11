/**
 * Bridge: adapt an `EvaluationStore` to the observability contract's
 * `ObservabilitySink`.
 *
 * The Registry emits `evaluation.recorded` events through the same
 * `ObservabilitySink` used for lifecycle events. Consumers plumbing
 * evaluations into durable storage wrap their store with this bridge
 * and pass the resulting sink to `Registry({ instrumentation: { sink } })`.
 *
 * The bridge is a one-way write path: events whose `event_type` is
 * `evaluation.recorded` are forwarded to `store.write`. Every other
 * event type is silently ignored — the intended shape for a "sink
 * that only cares about evaluations."
 *
 * Consumers who want BOTH lifecycle-event capture AND evaluation
 * capture pass a fan-out sink instead: `{ emit(e) { logSink.emit(e);
 * bridgeSink.emit(e); } }`. The bridge does not attempt to do that
 * fan-out itself, since callers may want different failure semantics
 * for the two sides.
 */

import {
  EVALUATION_EVENT_TYPE,
  type EvaluationRef,
  type ObservabilityEvent,
  type ObservabilitySink,
} from "@llm-ports/observability-contract";
import type { EvaluationStore } from "./types.js";

/**
 * Options for constructing a `toObservabilitySink` bridge.
 */
export interface ToObservabilitySinkOptions {
  /**
   * Optional hook fired when `store.write` throws. Consumers can log,
   * increment a metric, or trigger an alert. When omitted, the error
   * is silently swallowed — the observability path must never break
   * the primary LLM call.
   */
  onError?: (err: unknown, event: ObservabilityEvent<string, unknown>) => void;
}

/**
 * Wrap an `EvaluationStore` as an `ObservabilitySink`. The returned
 * sink accepts every `ObservabilityEvent<...>`, forwards
 * `evaluation.recorded` events to the store, and ignores everything
 * else.
 */
export function toObservabilitySink(
  store: EvaluationStore,
  options: ToObservabilitySinkOptions = {},
): ObservabilitySink {
  return {
    emit(event: ObservabilityEvent<string, unknown>): void | Promise<void> {
      if (event.event_type !== EVALUATION_EVENT_TYPE) return;
      const ref = event.data as EvaluationRef;
      try {
        const result = store.write(ref);
        if (result && typeof (result as Promise<boolean>).catch === "function") {
          return (result as Promise<boolean>).catch((err) => {
            if (options.onError) options.onError(err, event);
          }) as unknown as Promise<void>;
        }
      } catch (err) {
        if (options.onError) options.onError(err, event);
      }
    },
  };
}
