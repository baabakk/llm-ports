/**
 * `withObservabilityContext(port, context)` — the scoped-port wrapper
 * for caller-provided observability context, per Plan 58 v0.4 §4.2.
 *
 * The port's public interface (`LLMPort`) stays untouched. Consumers
 * who want to attach correlation, W3C Trace Context, Baggage,
 * attributes, or an HMAC fingerprint key to every call flowing through
 * a port wrap it once at the workflow root:
 *
 *   const scoped = withObservabilityContext(port, {
 *     operation_id: workflowOperationId,
 *     traceparent: incomingHeader,
 *     baggage: [{ key: "tenant_id", value: tenantId }],
 *     attributes: { region: "us-west" },
 *     fingerprint_key: process.env.OBS_HMAC_KEY,
 *   });
 *
 *   await scoped.generateText({...});
 *
 * At alpha.28 the wrapper's runtime behavior is minimal: it stores the
 * context in a WeakMap keyed by the returned port instance and forwards
 * every method call to the underlying port unchanged. `getObservabilityContext(port)`
 * retrieves the context for a wrapped port; the runtime instrumentation
 * that consumes it lands in alpha.29 (runtime instrumentation release).
 *
 * Why a WeakMap: consumers who pass wrapped ports around retain the
 * context association without leaking (once no reference to the wrapped
 * port survives, the context entry is garbage-collected). Alternative
 * of storing the context on the port object itself would mutate the
 * shape and clash with the "no LLMPort interface change" commitment.
 *
 * Why not AsyncLocalStorage (option (b) from the earlier design
 * decision): scoped-port wrapper is cross-runtime (works in every JS
 * runtime including workers where ALS is missing or partial); testable
 * without ambient state; explicit at the call site whether context is
 * scoped; subprocess callers can construct their own scoped emitter
 * from @llm-ports/observability-contract without needing a port.
 * ALS can be layered on top later as an opt-in propagator for Node-
 * only consumers who prefer ambient magic.
 */

import type { ObservabilityContext } from "@llm-ports/observability-contract";

import type { LLMPort } from "./ports/llm-port.js";

/**
 * The WeakMap that associates each wrapped port with its context.
 * Keyed by the wrapped port instance (the return value of
 * withObservabilityContext); collected when no reference survives.
 */
const contextByPort = new WeakMap<LLMPort, ObservabilityContext>();

/**
 * Wrap a port so that all calls through the returned port carry the
 * caller-provided `ObservabilityContext`. The returned port is
 * indistinguishable from the input at the public LLMPort interface;
 * consumers who need the context call `getObservabilityContext(port)`.
 *
 * Wrapping is composable: `withObservabilityContext(scoped, moreContext)`
 * merges `moreContext` over the previous scope. Fields present on
 * `moreContext` override; fields absent inherit. Baggage arrays are
 * concatenated (later entries win on duplicate keys).
 */
export function withObservabilityContext<T extends LLMPort>(
  port: T,
  context: ObservabilityContext,
): T {
  // Merge with any prior context on the input port (composition).
  const prior = contextByPort.get(port);
  const merged: ObservabilityContext = prior ? mergeContext(prior, context) : { ...context };

  // Build a fresh proxy that forwards every method call to the
  // underlying port. Using a Proxy (rather than a fresh object with
  // explicit methods) preserves any optional or future methods on
  // LLMPort without needing to enumerate them here.
  const wrapped = new Proxy(port, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // Bind methods to the underlying port so `this` remains correct
      // when the caller destructures methods off the wrapped port.
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as T;

  contextByPort.set(wrapped, merged);
  return wrapped;
}

/**
 * Retrieve the ObservabilityContext associated with a wrapped port.
 * Returns undefined for ports that were not wrapped via
 * `withObservabilityContext`.
 *
 * Alpha.28 exposes this as the low-level reader that alpha.29's runtime
 * instrumentation calls to stamp context onto emitted events.
 * Consumers writing their own emit paths (per §4.13 non-port callers)
 * also use this to read a context they scoped at a higher layer.
 */
export function getObservabilityContext(port: LLMPort): ObservabilityContext | undefined {
  return contextByPort.get(port);
}

/**
 * Merge two ObservabilityContext values. `right` overrides `left` for
 * scalar fields; baggage arrays are concatenated (later entries win on
 * duplicate keys); attributes are merged (right overrides left per key).
 */
function mergeContext(
  left: ObservabilityContext,
  right: ObservabilityContext,
): ObservabilityContext {
  const merged: ObservabilityContext = { ...left };

  if (right.operation_id !== undefined) merged.operation_id = right.operation_id;
  if (right.parent_operation_id !== undefined) {
    merged.parent_operation_id = right.parent_operation_id;
  }
  if (right.traceparent !== undefined) merged.traceparent = right.traceparent;
  if (right.tracestate !== undefined) merged.tracestate = right.tracestate;
  if (right.fingerprint_key !== undefined) merged.fingerprint_key = right.fingerprint_key;
  if (right.conversation_id !== undefined) merged.conversation_id = right.conversation_id;

  if (right.baggage !== undefined) {
    if (left.baggage === undefined) {
      merged.baggage = [...right.baggage];
    } else {
      // Concatenate; dedupe on key with right winning.
      const rightKeys = new Set(right.baggage.map((e) => e.key));
      const leftFiltered = left.baggage.filter((e) => !rightKeys.has(e.key));
      merged.baggage = [...leftFiltered, ...right.baggage];
    }
  }

  if (right.attributes !== undefined) {
    merged.attributes = { ...(left.attributes ?? {}), ...right.attributes };
  }

  return merged;
}
