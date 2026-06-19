/**
 * Model-ID normalization (alpha.22+).
 *
 * OpenAI-compat providers expose models under HuggingFace-style namespaced
 * IDs: DeepInfra `openai/gpt-oss-120b`, `deepseek-ai/DeepSeek-V4-Flash`,
 * `google/gemma-4-31B-it`; Parasail `XiaomiMiMo/MiMo-V2.5`; Groq
 * `openai/gpt-oss-120b`. Pre-alpha.22, the catalog patterns anchored at `^`
 * could not match the namespaced form — DeepInfra's `openai/gpt-oss-120b`
 * was treated as a non-reasoning model, the budget multiplier never
 * applied, and the model silently starved on hidden chain-of-thought.
 *
 * Architecturally: rather than maintain a per-(model × provider) regex
 * matrix, every model ID is normalized to its canonical name (the part
 * after the last `/`) before any catalog or learner lookup. The catalog
 * stays a small list of anchored patterns against canonical names; new
 * providers hosting an already-known model require zero catalog edits.
 *
 * Empirical motivation: ADW + Dramma findings, 2026-06-19. See
 * llm-ports#46 / discussion #49 for the architectural critique.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  normalizeModelId,
  seedKnownConstraints,
  getEffectiveCapabilities,
  _resetLearnedConstraints,
} from "../../src/capabilities.js";

beforeEach(() => {
  _resetLearnedConstraints();
});

describe("normalizeModelId (alpha.22+)", () => {
  it("passes OpenAI-native IDs through unchanged", () => {
    expect(normalizeModelId("gpt-5")).toBe("gpt-5");
    expect(normalizeModelId("gpt-5-nano")).toBe("gpt-5-nano");
    expect(normalizeModelId("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(normalizeModelId("o3-mini")).toBe("o3-mini");
    expect(normalizeModelId("gpt-oss-120b")).toBe("gpt-oss-120b");
  });

  it("strips DeepInfra-style namespace prefix", () => {
    expect(normalizeModelId("openai/gpt-oss-120b")).toBe("gpt-oss-120b");
    expect(normalizeModelId("deepseek-ai/DeepSeek-V4-Flash")).toBe("DeepSeek-V4-Flash");
    expect(normalizeModelId("google/gemma-4-31B-it")).toBe("gemma-4-31B-it");
  });

  it("strips Parasail-style namespace prefix", () => {
    expect(normalizeModelId("XiaomiMiMo/MiMo-V2.5")).toBe("MiMo-V2.5");
  });

  it("strips Groq-style namespace prefix (same as DeepInfra for openai/*)", () => {
    expect(normalizeModelId("openai/gpt-oss-120b")).toBe("gpt-oss-120b");
  });

  it("handles Google-style paths (models/<id>)", () => {
    expect(normalizeModelId("models/gemini-2.0-flash")).toBe("gemini-2.0-flash");
  });

  it("returns last segment for multi-segment paths", () => {
    expect(normalizeModelId("a/b/c/model-name")).toBe("model-name");
  });

  it("returns empty string for trailing slash", () => {
    // Edge case; not a valid model id but should not throw.
    expect(normalizeModelId("openai/")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeModelId("")).toBe("");
  });
});

describe("Catalog + learner use normalized model IDs (alpha.22+)", () => {
  it("seedKnownConstraints matches gpt-oss family by canonical name regardless of namespace prefix", () => {
    // The catalog has `/^gpt-oss-/i`. After normalization,
    // `openai/gpt-oss-120b` and `gpt-oss-120b` both look up the same.
    seedKnownConstraints("gpt-oss-120b");
    expect(getEffectiveCapabilities("gpt-oss-120b", undefined).reasoningModel).toBe(true);

    _resetLearnedConstraints();
    seedKnownConstraints("openai/gpt-oss-120b");
    // After normalization, the lookup key is "gpt-oss-120b".
    expect(getEffectiveCapabilities("openai/gpt-oss-120b", undefined).reasoningModel).toBe(true);
    // And it should also work when read back via the canonical name.
    expect(getEffectiveCapabilities("gpt-oss-120b", undefined).reasoningModel).toBe(true);
  });

  it("seedKnownConstraints matches qwen3.6 family regardless of namespace prefix", () => {
    seedKnownConstraints("Qwen/Qwen3.6-235B");
    expect(getEffectiveCapabilities("Qwen/Qwen3.6-235B", undefined).reasoningModel).toBe(true);
  });

  it("seedKnownConstraints matches minimax-m2.7 family regardless of namespace prefix", () => {
    seedKnownConstraints("some-provider/MiniMax-M2.7");
    expect(getEffectiveCapabilities("some-provider/MiniMax-M2.7", undefined).reasoningModel).toBe(true);
  });

  it("non-reasoning models stay non-reasoning regardless of prefix", () => {
    // gpt-4o-mini is not in the catalog; it shouldn't be falsely flagged.
    // The learner stores only positive constraints; absence means "not
    // learned", which the rest of the adapter treats as non-reasoning.
    seedKnownConstraints("openai/gpt-4o-mini");
    const caps = getEffectiveCapabilities("openai/gpt-4o-mini", undefined);
    expect(caps.reasoningModel).toBeFalsy();
  });

  it("DeepInfra-hosted DeepSeek-V4-Flash stays non-reasoning (not in catalog)", () => {
    // DeepSeek-V4-Flash is the non-reasoning Flash variant, NOT the R1/R2
    // reasoning lineage. Pre-alpha.22 the prefix would have hidden any
    // catalog match anyway; post-alpha.22 we still don't mark it reasoning
    // because the catalog doesn't list it.
    seedKnownConstraints("deepseek-ai/DeepSeek-V4-Flash");
    expect(getEffectiveCapabilities("deepseek-ai/DeepSeek-V4-Flash", undefined).reasoningModel).toBeFalsy();
  });

  it("shared learner state: namespaced and canonical IDs reference the same entry", () => {
    // This is the architectural payoff: the same canonical model served by
    // two providers (Cerebras's `gpt-oss-120b` and DeepInfra's
    // `openai/gpt-oss-120b`) share learned state. A constraint learned at
    // runtime for one is visible to the other.
    seedKnownConstraints("openai/gpt-oss-120b");
    const caps1 = getEffectiveCapabilities("gpt-oss-120b", undefined);
    expect(caps1.reasoningModel).toBe(true);
    // And vice versa.
    _resetLearnedConstraints();
    seedKnownConstraints("gpt-oss-120b");
    const caps2 = getEffectiveCapabilities("openai/gpt-oss-120b", undefined);
    expect(caps2.reasoningModel).toBe(true);
  });

  it("user-supplied capabilities take precedence over normalized catalog match", () => {
    seedKnownConstraints("openai/gpt-oss-120b");
    const caps = getEffectiveCapabilities("openai/gpt-oss-120b", {
      reasoningModel: false,
    });
    expect(caps.reasoningModel).toBe(false);
  });
});
