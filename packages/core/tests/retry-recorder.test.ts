/**
 * The retry recorder is bounded, newest-first, and shareable.
 *
 * Alpha.28 item 9 (Dramma) asked for a way to see recent retries without
 * subscribing to every event. The bound is the part worth testing hardest: the
 * feature exists to look at recent instability, and an unbounded log in a
 * long-running worker is a leak rather than a feature.
 */

import { describe, expect, it } from "vitest";
import { createRetryRecorder, type RetryEvent } from "../src/index.js";

function retry(alias: string, reason: RetryEvent["reason"] = "validation-feedback"): RetryEvent {
  return { providerAlias: alias, reason, attempt: 1 } as RetryEvent;
}

describe("createRetryRecorder", () => {
  it("records what it is given, newest first", () => {
    const r = createRetryRecorder();
    r.onRetry(retry("openai"));
    r.onRetry(retry("anthropic"));

    const recent = r.recent();
    expect(recent).toHaveLength(2);
    // Newest first, so "the last few" needs no reversing at the call site.
    expect(recent[0]!.event.providerAlias).toBe("anthropic");
    expect(recent[1]!.event.providerAlias).toBe("openai");
    expect(recent[0]!.at).toBeGreaterThan(0);
  });

  it("returns only as many as asked, and never more than it holds", () => {
    const r = createRetryRecorder();
    for (let i = 0; i < 5; i++) r.onRetry(retry(`p${i}`));

    expect(r.recent(2)).toHaveLength(2);
    expect(r.recent(2)[0]!.event.providerAlias).toBe("p4");
    // Asking for more than exists is not an error; it returns what there is.
    expect(r.recent(500)).toHaveLength(5);
    expect(r.recent(0)).toHaveLength(0);
  });

  it("stays bounded, evicting the oldest", () => {
    const r = createRetryRecorder(3);
    for (let i = 0; i < 10; i++) r.onRetry(retry(`p${i}`));

    const recent = r.recent();
    expect(recent).toHaveLength(3);
    expect(recent.map((x) => x.event.providerAlias)).toEqual(["p9", "p8", "p7"]);
    // The count of everything seen survives eviction, so a caller can tell
    // "three retries" from "three retained out of two hundred".
    expect(r.total).toBe(10);
  });

  it("treats a nonsensical capacity as one rather than zero or negative", () => {
    const r = createRetryRecorder(0);
    r.onRetry(retry("openai"));
    r.onRetry(retry("anthropic"));
    expect(r.recent()).toHaveLength(1);
    expect(r.recent()[0]!.event.providerAlias).toBe("anthropic");
  });

  it("is shareable across adapters, because events carry their own provider", () => {
    const r = createRetryRecorder();
    // One recorder handed to several adapters as their onRetry: the reason the
    // hook signature is a plain function rather than something per-adapter.
    const asOpenAI = r.onRetry;
    const asAnthropic = r.onRetry;
    asOpenAI(retry("openai", "rate-limit"));
    asAnthropic(retry("anthropic", "validation-feedback"));

    expect(r.recent().map((x) => x.event.providerAlias)).toEqual(["anthropic", "openai"]);
  });

  it("clears what it retains without forgetting how many it saw", () => {
    const r = createRetryRecorder();
    r.onRetry(retry("openai"));
    r.clear();
    expect(r.recent()).toHaveLength(0);
    expect(r.total).toBe(1);
  });
});
