/**
 * ObservabilitySink interface per Plan 58 v0.4 §4.12.
 *
 * The sole sink interface. Every emitter helper in this contract accepts
 * an `ObservabilitySink` and forwards events to it. Consumers wire their
 * own sinks (in-memory buffer, OTel exporter, ClickHouse writer, custom
 * emitter) by implementing this one-method interface.
 *
 * Deliberately exclusive:
 *
 *   - Node `EventEmitter` is NOT part of the contract. It's
 *     Node-specific (Deno / Bun / browser / Cloudflare Workers differ),
 *     its async error semantics are inconsistent (an unhandled `'error'`
 *     event crashes the Node process by default), and coupling to a
 *     specific implementation means version-lock across the ecosystem.
 *
 *   - The interface deliberately allows both synchronous and Promise-
 *     returning implementations. Sinks that do async I/O (network,
 *     database) return a Promise; sinks that just buffer in memory
 *     return void. Callers await the Promise if they need
 *     back-pressure; fire-and-forget callers ignore it.
 *
 *   - Errors thrown by a sink are the caller's problem. Contract
 *     helpers do NOT catch sink errors, so a broken sink surfaces
 *     immediately rather than silently swallowing observability data.
 *     Consumers who want error isolation wrap their sink in a
 *     try/catch adapter at their layer.
 *
 * Documentation shows a 5-line EventEmitter adapter as a common
 * wire-up pattern; the adapter is one line long in practice but is
 * NOT part of the contract.
 */

import type { AnyObservabilityEvent } from "./envelope.js";

/**
 * The sole sink interface. Implementations may be synchronous or
 * async; callers awaiting back-pressure use the Promise return.
 */
export interface ObservabilitySink {
  emit(event: AnyObservabilityEvent): void | Promise<void>;
}

/**
 * A no-op sink for testing. Ignores all events. Useful when a component
 * requires a sink but the test does not observe events.
 */
export const noopSink: ObservabilitySink = {
  emit(): void {
    // intentionally empty
  },
};

/**
 * A collecting sink for testing. Records every event received in an
 * array; the caller inspects it after the operation completes. Not
 * intended for production (unbounded memory growth).
 */
export function createCollectingSink(): ObservabilitySink & {
  readonly events: readonly AnyObservabilityEvent[];
  clear(): void;
} {
  const events: AnyObservabilityEvent[] = [];
  return {
    emit(event: AnyObservabilityEvent): void {
      events.push(event);
    },
    get events(): readonly AnyObservabilityEvent[] {
      return events;
    },
    clear(): void {
      events.length = 0;
    },
  };
}
