/**
 * Tests for `checkSdkCompatibility` — the warning surfaced when the
 * installed @anthropic-ai/sdk version is outside the tested range.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSdkCompatibility } from "../../src/version-check.js";

describe("checkSdkCompatibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT warn when the SDK version is in range", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkSdkCompatibility("0.40.0");
    expect(spy).not.toHaveBeenCalled();
  });

  it("warns when the SDK version is below the supported range", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkSdkCompatibility("0.10.0");
    expect(spy).toHaveBeenCalledTimes(1);
    const message = spy.mock.calls[0]?.[0];
    expect(message).toContain("older than the tested minimum");
    expect(message).toContain("Either upgrade @anthropic-ai/sdk");
  });

  it("warns when the SDK version is at or above the exclusive upper bound", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkSdkCompatibility("0.50.0");
    expect(spy).toHaveBeenCalledTimes(1);
    const message = spy.mock.calls[0]?.[0];
    expect(message).toContain("newer than the tested range");
    expect(message).toContain("Either upgrade @llm-ports/adapter-anthropic");
  });

  it("silently no-ops when version is undefined", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkSdkCompatibility(undefined);
    expect(spy).not.toHaveBeenCalled();
  });

  it("handles malformed version strings without throwing", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => checkSdkCompatibility("not.a.version")).not.toThrow();
    // Behavior is best-effort; we only care that it doesn't throw.
    spy.mockRestore();
  });

  it("handles 'v'-prefixed versions", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkSdkCompatibility("v0.40.0");
    expect(spy).not.toHaveBeenCalled();
  });

  it("strips pre-release suffixes when comparing", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkSdkCompatibility("0.40.0-beta.1");
    expect(spy).not.toHaveBeenCalled();
  });
});
