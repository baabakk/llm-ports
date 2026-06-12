/**
 * Apply `CacheControl` to a Google Gemini `generateContent` config in place.
 *
 * Google's prompt cache uses the `cachedContents.create()` API to register
 * content + return a resource handle. Subsequent `generateContent` calls
 * pass that handle in `config.cachedContent` to serve the cached content.
 *
 * Per-mode behavior on this adapter:
 *   - `mode: "preCreated"` with `cachedContentHandle` → set `config.cachedContent`.
 *   - `mode: "preCreated"` without a handle → no-op (caller bug; not our job to
 *     create the cached content for them — that's a separate API surface that
 *     ships in `@llm-ports/capabilities` in beta.2).
 *   - `mode: "auto" | "manual" | "off"` → no-op. Gemini has no caller-controllable
 *     equivalent. `mode: "auto"` on Gemini intentionally does nothing rather than
 *     silently using a different mechanism behind the user's back.
 *
 * `ttlSeconds` and `namespace` are forwarded to the cached-content creation
 * step (when `@llm-ports/capabilities` handles it), not to `generateContent`.
 *
 * Shipped in 0.1.0-alpha.19.1. Tests live at
 * `packages/adapter-google/tests/quirks/cache-control.test.ts`.
 */

import type { CacheControl } from "@llm-ports/core";

/**
 * Apply `CacheControl` to a Google `generateContent` config object in place,
 * returning the same reference so call sites can chain. Pass `undefined` to
 * make this a no-op.
 *
 * Generic `T` preserves the caller's SDK type; we cast to a structural
 * Record internally for the single field write.
 */
export function applyGoogleCacheControl<T>(config: T, cacheControl: CacheControl | undefined): T {
  if (!cacheControl) return config;
  if (cacheControl.mode !== "preCreated") return config;
  if (typeof cacheControl.cachedContentHandle !== "string" || cacheControl.cachedContentHandle.length === 0) {
    return config;
  }
  const cfg = config as unknown as Record<string, unknown>;
  cfg.cachedContent = cacheControl.cachedContentHandle;
  return config;
}
