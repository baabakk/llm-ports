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

/**
 * One sink that forwards every event to several, isolating failures.
 *
 * `Instrumentation` accepts a single sink, so a consumer wanting two, such as
 * an incident logger beside the OpenTelemetry bridge, has to write the fan-out
 * themselves. BEPA did, and wrote it correctly: **a sink that throws must not
 * stop the sinks after it.** The obvious version, a `for` loop calling `emit`,
 * does exactly that, and the failure is invisible because the events simply
 * stop arriving at the later sinks.
 *
 * This library already promises that observability never breaks inference, so
 * a swallowed sink failure is consistent with the rest of the contract rather
 * than an exception to it.
 *
 * Errors are swallowed per sink, including a rejected promise from an
 * asynchronous `emit`. Nothing is retried: a sink that cannot take an event is
 * not made more likely to take it by being asked twice.
 *
 * Added in `0.1.0-alpha.35` from `TD-LLMPORTS-NO-SINK-COMPOSITION`.
 *
 * @example
 * const sink = combineSinks(otelSink, incidentLoggerSink);
 */
export function combineSinks(...sinks: readonly ObservabilitySink[]): ObservabilitySink {
  const members = sinks.filter((sink): sink is ObservabilitySink => sink !== undefined);
  if (members.length === 1) return members[0]!;
  return {
    emit(event: AnyObservabilityEvent): void {
      for (const sink of members) {
        try {
          const result = sink.emit(event);
          if (result instanceof Promise) {
            // A rejected promise from one sink must not surface as an unhandled
            // rejection, which would take down a process that is only trying
            // to record what happened.
            void result.catch(() => undefined);
          }
        } catch {
          // Deliberately silent: the next sink still gets the event, and
          // observability is not allowed to break the call it observes.
        }
      }
    },
  };
}
