/**
 * Apply `CacheControl` to an Anthropic Messages.MessageCreateParams request.
 *
 * Anthropic's prompt cache uses explicit `cache_control: { type: "ephemeral", ttl? }`
 * markers placed on:
 *   - the `system` block (when system is sent as the structured array form)
 *   - the last tool in the `tools` array
 *   - the last content block of a `messages[i]` entry
 *
 * Per-mode behavior:
 *   - `mode: "auto"`     → place marker on the system block when `system` is present.
 *   - `mode: "manual"`   → place markers at each supplied breakpoint.
 *   - `mode: "off"`      → no-op (this adapter never emits cache_control without
 *                          being told to, so "off" matches the natural default).
 *   - `mode: "preCreated"` → no-op (Anthropic has no createCachedContent handle).
 *
 * `ttlSeconds === 3600` → emit `ttl: "1h"` on the marker.
 * Anything else (including 300 or undefined) leaves `ttl` unset, which uses
 * Anthropic's 5-minute default. Anthropic rejects other ttl values.
 *
 * Shipped in 0.1.0-alpha.19.1. Tests live at
 * `packages/adapter-anthropic/tests/quirks/cache-control.test.ts`.
 */

import type { CacheControl } from "@llm-ports/core";

interface CacheControlMarker {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

interface TextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControlMarker;
}

interface ToolEntry {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControlMarker;
}

// The helper composes with the existing `applyCapabilityFilter` cast pattern in
// adapter.ts. The structural fields we care about (system, messages, tools) are
// accessed defensively through an internal Record cast so this helper can take
// any SDK-typed input without fighting the Anthropic SDK's discriminated unions.

function buildMarker(cacheControl: CacheControl): CacheControlMarker {
  const ttl: "5m" | "1h" | undefined = cacheControl.ttlSeconds === 3600 ? "1h" : undefined;
  return ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" };
}

function placeOnSystem(req: Record<string, unknown>, marker: CacheControlMarker): void {
  const sys = req.system;
  if (sys === undefined || sys === null) return;
  if (typeof sys === "string") {
    const block: TextBlock = { type: "text", text: sys, cache_control: marker };
    req.system = [block];
    return;
  }
  if (Array.isArray(sys) && sys.length > 0) {
    const last = sys[sys.length - 1] as TextBlock;
    last.cache_control = marker;
  }
}

function placeOnTools(req: Record<string, unknown>, marker: CacheControlMarker): void {
  const tools = req.tools;
  if (!Array.isArray(tools) || tools.length === 0) return;
  const last = tools[tools.length - 1] as ToolEntry;
  last.cache_control = marker;
}

function placeOnMessage(req: Record<string, unknown>, index: number, marker: CacheControlMarker): void {
  const messages = req.messages;
  if (!Array.isArray(messages)) return;
  const msg = messages[index];
  if (!msg || typeof msg !== "object") return;
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") {
    // Promote to structured array so we can attach cache_control.
    (msg as { content: unknown }).content = [
      { type: "text", text: content, cache_control: marker } as TextBlock,
    ];
    return;
  }
  if (Array.isArray(content) && content.length > 0) {
    const last = content[content.length - 1] as TextBlock;
    last.cache_control = marker;
  }
}

/**
 * Apply `CacheControl` to an Anthropic request in place, returning the same
 * object so call sites can chain. Pass `undefined` to make this a no-op.
 *
 * Generic `T` preserves the caller's SDK type. Internally we cast to a
 * structural `Record<string, unknown>` for mutation, then return the same
 * reference so the caller's type flows through unchanged.
 */
export function applyAnthropicCacheControl<T>(request: T, cacheControl: CacheControl | undefined): T {
  if (!cacheControl) return request;
  if (cacheControl.mode === "off" || cacheControl.mode === "preCreated") return request;

  const marker = buildMarker(cacheControl);
  const req = request as unknown as Record<string, unknown>;

  if (cacheControl.mode === "auto") {
    placeOnSystem(req, marker);
    return request;
  }

  // mode: "manual"
  const breakpoints = cacheControl.breakpoints ?? [];
  if (breakpoints.length === 0) {
    // Manual with no breakpoints behaves like auto for friendliness.
    placeOnSystem(req, marker);
    return request;
  }
  for (const bp of breakpoints) {
    if (bp.at === "system") placeOnSystem(req, marker);
    else if (bp.at === "tools") placeOnTools(req, marker);
    else if (bp.at === "message-index" && typeof bp.index === "number") {
      placeOnMessage(req, bp.index, marker);
    }
  }
  return request;
}
