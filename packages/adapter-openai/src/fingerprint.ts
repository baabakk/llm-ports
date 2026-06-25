/**
 * Behavioral model fingerprinting (alpha.24+).
 *
 * Problem: maintaining a static catalog of (model × provider) → capability
 * mappings is unsustainable. Three CoT field conventions exist across the
 * OpenAI-compat ecosystem (`reasoning`, `reasoning_content`, inline-`<think>`),
 * provider naming drifts, and new reasoning models ship weekly. The empirical
 * survey at docs/research/reasoning-models-survey-2026-06.md catalogues ~30+
 * reasoning models across 5 providers; every regex entry is one more piece of
 * code that goes stale on its own schedule.
 *
 * Solution: behavioral fingerprinting. At first contact with a model, fire
 * one small probe call ("what's 2+2") and inspect the response shape:
 *
 *   - `message.reasoning` populated → Cerebras-style reasoning model
 *   - `message.reasoning_content` populated → vLLM-style reasoning model
 *   - `usage.completion_tokens_details.reasoning_tokens > 0` → OpenAI-native
 *     reasoning model
 *   - inline `<think>...</think>` markers in `message.content` → legacy R1
 *     style
 *
 * Cache the result by (baseURL, modelId). Next process startup reads the
 * cache and skips the probe entirely. The catalog stays as a cheap shortcut
 * for the well-known cases (OpenAI o-series, gpt-5-nano); for everything
 * else, the fingerprint cache is the answer.
 *
 * This file ships the cache backend interface, two default backends
 * (in-memory + file), the `fingerprintModel` standalone helper, and the
 * `inspectResponseForFingerprint` analyzer the adapter uses for free
 * fingerprinting on existing inflight responses (no probe call needed when
 * the model already produced a fingerprint-able response).
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { OpenAI } from "openai";
import { normalizeModelId } from "./capabilities.js";

// ─── Public types ────────────────────────────────────────────────────

/**
 * The fingerprint we cache per (baseURL, modelId) tuple. Captures enough
 * information for the adapter to skip first-call discovery.
 */
export interface ModelFingerprint {
  /** Canonical model id (after normalizeModelId — strip provider prefix). */
  modelId: string;
  /** Provider baseURL (or "openai-native" sentinel for OpenAI native). */
  baseURL: string;
  /** True if the model produces hidden chain-of-thought tokens. */
  reasoningModel: boolean;
  /**
   * Which field exposes the chain-of-thought, when reasoningModel is true.
   * - "reasoning"         → message.reasoning (Cerebras, Groq, SambaNova)
   * - "reasoning_content" → message.reasoning_content (DeepInfra, Parasail)
   * - "reasoning_tokens"  → usage.completion_tokens_details.reasoning_tokens
   *                         (OpenAI native; no separate text field)
   * - "inline-think"      → <think>...</think> embedded in message.content
   *                         (legacy R1 distills on some providers)
   * - undefined           → not a reasoning model OR couldn't determine
   */
  reasoningField?: "reasoning" | "reasoning_content" | "reasoning_tokens" | "inline-think";
  /** ISO timestamp when this fingerprint was captured. */
  fingerprintedAt: string;
  /**
   * Schema version. Bumped when the fingerprint shape changes so old caches
   * are invalidated gracefully instead of crashing the loader.
   */
  schemaVersion: 1;
}

/**
 * Cache backend interface. Implementations are responsible for persistence
 * (file, Redis, S3, etc.). All methods may return synchronously or as a
 * Promise; the adapter awaits regardless.
 */
export interface FingerprintCacheBackend {
  /** Return cached fingerprint for the key, or null when absent. */
  get(key: string): Promise<ModelFingerprint | null> | ModelFingerprint | null;
  /** Persist the fingerprint under the key. */
  set(key: string, value: ModelFingerprint): Promise<void> | void;
  /** Optional: delete a single entry. Used by test helpers and admin tools. */
  delete?(key: string): Promise<void> | void;
}

// ─── Default backends ────────────────────────────────────────────────

/**
 * Simple in-memory cache. Lifetime is the current process. Useful for
 * development, tests, and short-lived workers where re-fingerprinting on
 * restart is cheap.
 */
export class InMemoryFingerprintCache implements FingerprintCacheBackend {
  private readonly store = new Map<string, ModelFingerprint>();

  get(key: string): ModelFingerprint | null {
    return this.store.get(key) ?? null;
  }

  set(key: string, value: ModelFingerprint): void {
    this.store.set(key, value);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Test-only: clear all entries. */
  _clear(): void {
    this.store.clear();
  }

  /** Test-only: snapshot for inspection. */
  _snapshot(): ReadonlyMap<string, ModelFingerprint> {
    return this.store;
  }
}

/**
 * File-backed cache. Stores fingerprints as JSON at the configured path.
 * Loads lazily on first `get` and writes back on every `set` (atomic via
 * temp + rename). Suitable for long-running workers and CI warm-starts.
 *
 * NOT suitable for concurrent multi-process writers; if you need that,
 * supply your own backend (Redis, S3, etc.) that handles the locking.
 */
export class FileFingerprintCache implements FingerprintCacheBackend {
  private cache: Map<string, ModelFingerprint> | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(public readonly path: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.cache) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }
    this.loadPromise = (async (): Promise<void> => {
      try {
        const text = await fs.readFile(this.path, "utf8");
        const parsed = JSON.parse(text) as Record<string, ModelFingerprint>;
        this.cache = new Map(Object.entries(parsed));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // First-time use: no file yet. Initialize empty cache.
        if (code === "ENOENT") {
          this.cache = new Map();
          return;
        }
        // Malformed JSON: treat as empty and let the next write overwrite.
        // Don't crash the adapter on a corrupt cache file.
        if (err instanceof SyntaxError) {
          this.cache = new Map();
          return;
        }
        throw err;
      }
    })();
    await this.loadPromise;
  }

  async get(key: string): Promise<ModelFingerprint | null> {
    await this.ensureLoaded();
    const cached = this.cache!.get(key) ?? null;
    if (cached && cached.schemaVersion !== 1) return null;
    return cached;
  }

  async set(key: string, value: ModelFingerprint): Promise<void> {
    await this.ensureLoaded();
    this.cache!.set(key, value);
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    await this.ensureLoaded();
    if (this.cache!.delete(key)) await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.cache) return;
    const serialized = JSON.stringify(Object.fromEntries(this.cache), null, 2);
    // Atomic write via temp + rename. Avoids leaving a partial file if the
    // process is killed mid-write.
    const tmpPath = `${this.path}.tmp`;
    await fs.mkdir(dirname(this.path), { recursive: true });
    await fs.writeFile(tmpPath, serialized, "utf8");
    await fs.rename(tmpPath, this.path);
  }
}

// ─── Key builder ─────────────────────────────────────────────────────

/**
 * Build the cache key for a (baseURL, modelId) tuple. Normalizes the
 * baseURL by stripping trailing slashes and the modelId by stripping the
 * provider namespace prefix (alpha.22 normalization).
 *
 * Examples:
 *   buildFingerprintKey(undefined, "gpt-5")
 *     → "openai-native::gpt-5"
 *   buildFingerprintKey("https://api.deepinfra.com/v1/openai", "openai/gpt-oss-120b")
 *     → "https://api.deepinfra.com/v1/openai::gpt-oss-120b"
 *   buildFingerprintKey("https://api.cerebras.ai/v1/", "gpt-oss-120b")
 *     → "https://api.cerebras.ai/v1::gpt-oss-120b"
 */
export function buildFingerprintKey(
  baseURL: string | undefined,
  modelId: string,
): string {
  const normalizedBase = baseURL ? baseURL.replace(/\/+$/, "") : "openai-native";
  return `${normalizedBase}::${normalizeModelId(modelId)}`;
}

// ─── Response shape analyzer ─────────────────────────────────────────

/**
 * Inspect a chat-completion response and derive a fingerprint. Used by the
 * adapter to fingerprint for free on every inflight response — no separate
 * probe call needed when the model already produced something we can read.
 *
 * Returns a partial fingerprint (the shape-derivable fields). The caller is
 * responsible for adding modelId, baseURL, fingerprintedAt, schemaVersion.
 *
 * Detection priority (first match wins):
 *   1. `usage.completion_tokens_details.reasoning_tokens > 0` →
 *      reasoningModel=true, reasoningField="reasoning_tokens"
 *      (OpenAI native; the reasoning tokens are billed but not text-exposed)
 *   2. `message.reasoning_content` populated string →
 *      reasoningModel=true, reasoningField="reasoning_content"
 *      (vLLM-style: DeepInfra, Parasail)
 *   3. `message.reasoning` populated string →
 *      reasoningModel=true, reasoningField="reasoning"
 *      (Cerebras-style: Cerebras, Groq, SambaNova)
 *   4. `message.content` contains `<think>...</think>` markers →
 *      reasoningModel=true, reasoningField="inline-think"
 *      (legacy R1 distills emitted raw)
 *   5. Otherwise: reasoningModel=false (no signal observed)
 *
 * A "no signal" verdict is NOT cached — it could be a non-reasoning prompt
 * to a reasoning model. The caller decides whether to cache negatives.
 */
export function inspectResponseForFingerprint(
  response: unknown,
): Pick<ModelFingerprint, "reasoningModel" | "reasoningField"> {
  if (!response || typeof response !== "object") {
    return { reasoningModel: false };
  }
  const r = response as {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning?: string | null;
        reasoning_content?: string | null;
      };
    }>;
    usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
  };
  const reasoningTokens = r.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (reasoningTokens > 0) {
    return { reasoningModel: true, reasoningField: "reasoning_tokens" };
  }
  const msg = r.choices?.[0]?.message;
  if (typeof msg?.reasoning_content === "string" && msg.reasoning_content.length > 0) {
    return { reasoningModel: true, reasoningField: "reasoning_content" };
  }
  if (typeof msg?.reasoning === "string" && msg.reasoning.length > 0) {
    return { reasoningModel: true, reasoningField: "reasoning" };
  }
  if (typeof msg?.content === "string" && /<think>[\s\S]*?<\/think>/.test(msg.content)) {
    return { reasoningModel: true, reasoningField: "inline-think" };
  }
  return { reasoningModel: false };
}

// ─── Standalone fingerprint helper ───────────────────────────────────

/**
 * Fire one small probe call against the given client + modelId and produce
 * a fingerprint. Useful for CI warm-start scripts that want to populate the
 * cache before production traffic starts.
 *
 * @param client  An initialized OpenAI client.
 * @param modelId Provider-native model id (raw; will be normalized internally).
 * @param opts    Optional baseURL override (recorded in the key). If
 *                undefined, the client's own baseURL is read; if both are
 *                absent, the "openai-native" sentinel is used.
 */
export async function fingerprintModel(
  client: OpenAI,
  modelId: string,
  opts?: { baseURL?: string },
): Promise<ModelFingerprint> {
  const baseURL = opts?.baseURL ?? (client as unknown as { baseURL?: string }).baseURL;
  // Small probe: ask the model for a one-word response, low max_tokens so
  // the call resolves quickly. We're inspecting response shape, not content.
  // The reasoning_effort hint helps reasoning models surface their CoT.
  const response = await client.chat.completions.create({
    model: modelId,
    messages: [
      { role: "user", content: "What is 2+2? Reply with just the number." },
    ],
    max_tokens: 200, // generous enough for reasoning models to surface CoT
    temperature: 0,
  } as never);

  const shape = inspectResponseForFingerprint(response);
  return {
    modelId: normalizeModelId(modelId),
    baseURL: baseURL ?? "openai-native",
    reasoningModel: shape.reasoningModel,
    ...(shape.reasoningField ? { reasoningField: shape.reasoningField } : {}),
    fingerprintedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}
