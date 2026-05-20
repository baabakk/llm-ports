/**
 * Tests for the click-to-file warning helpers in `notify-learning.ts`.
 *
 * The contract:
 *   - `buildLearningIssueUrl(event)` produces a GitHub New Issue URL with
 *     title + body + labels pre-filled and properly URL-encoded.
 *   - `emitFirstLearningWarning(event)` fires `console.warn` exactly once per
 *     (modelId, capability) pair per process.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildLearningIssueUrl,
  emitFirstLearningWarning,
  _resetWarnedState,
  type FirstLearningEvent,
} from "../src/notify-learning.js";

const baseEvent: FirstLearningEvent = {
  packageName: "@llm-ports/adapter-anthropic",
  modelId: "claude-opus-4-5-20251001",
  capability: "temperatureLocked",
  providerErrorMessage: "`temperature` is deprecated for this model.",
  adapterVersion: "0.1.0-alpha.3",
  sdkVersion: "0.32.1",
};

describe("buildLearningIssueUrl", () => {
  it("builds a GitHub New Issue URL", () => {
    const url = buildLearningIssueUrl(baseEvent);
    expect(url).toMatch(/^https:\/\/github\.com\/baabakk\/llm-ports\/issues\/new\?/);
  });

  it("includes title, body, and labels query params", () => {
    const url = buildLearningIssueUrl(baseEvent);
    expect(url).toContain("title=");
    expect(url).toContain("body=");
    expect(url).toContain("labels=");
  });

  it("title is URI-encoded and mentions the model id and capability", () => {
    const url = buildLearningIssueUrl(baseEvent);
    const params = new URL(url).searchParams;
    const title = params.get("title");
    expect(title).toBeDefined();
    expect(title).toContain(baseEvent.modelId);
    expect(title).toContain(baseEvent.capability);
  });

  it("body contains the provider error message + versions", () => {
    const url = buildLearningIssueUrl(baseEvent);
    const params = new URL(url).searchParams;
    const body = params.get("body") ?? "";
    expect(body).toContain(baseEvent.providerErrorMessage);
    expect(body).toContain(baseEvent.adapterVersion);
    expect(body).toContain(baseEvent.sdkVersion);
    expect(body).toContain(baseEvent.modelId);
  });

  it("includes a derived area:adapter-<name> label when package name matches", () => {
    const url = buildLearningIssueUrl(baseEvent);
    const params = new URL(url).searchParams;
    const labels = params.get("labels") ?? "";
    expect(labels).toContain("area:adapter-anthropic");
    expect(labels).toContain("bug");
    expect(labels).toContain("runtime-learned");
  });

  it("omits the area label when package name is not in the @llm-ports/adapter-* form", () => {
    const url = buildLearningIssueUrl({
      ...baseEvent,
      packageName: "@my-org/custom",
    });
    const params = new URL(url).searchParams;
    const labels = params.get("labels") ?? "";
    expect(labels).not.toContain("area:");
    expect(labels).toContain("bug");
    expect(labels).toContain("runtime-learned");
  });

  it("respects a custom repoUrl when provided", () => {
    const url = buildLearningIssueUrl({
      ...baseEvent,
      repoUrl: "https://github.com/example/fork",
    });
    expect(url).toMatch(/^https:\/\/github\.com\/example\/fork\/issues\/new\?/);
  });
});

describe("emitFirstLearningWarning", () => {
  beforeEach(() => {
    _resetWarnedState();
  });

  it("fires console.warn on first encounter", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitFirstLearningWarning(baseEvent);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toContain(baseEvent.packageName);
    expect(spy.mock.calls[0]?.[0]).toContain(baseEvent.modelId);
    expect(spy.mock.calls[0]?.[0]).toContain("https://github.com/baabakk/llm-ports/issues/new");
    spy.mockRestore();
  });

  it("does not fire a second time for the same (modelId, capability) pair", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitFirstLearningWarning(baseEvent);
    emitFirstLearningWarning(baseEvent);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("fires separately for different capabilities on the same model", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitFirstLearningWarning(baseEvent);
    emitFirstLearningWarning({ ...baseEvent, capability: "jsonModeUnsupported" });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("fires separately for the same capability on different models", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitFirstLearningWarning(baseEvent);
    emitFirstLearningWarning({ ...baseEvent, modelId: "claude-sonnet-4-5" });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("resets after _resetWarnedState (test isolation)", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitFirstLearningWarning(baseEvent);
    _resetWarnedState();
    emitFirstLearningWarning(baseEvent);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
