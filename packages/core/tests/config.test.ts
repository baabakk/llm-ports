import { describe, expect, it } from "vitest";
import { ConfigError, parseRegistryConfig } from "../src/index.js";

describe("parseRegistryConfig", () => {
  it("parses provider entries with request gating", () => {
    const config = parseRegistryConfig({
      env: {
        LLM_PROVIDER_FAST: "anthropic|claude-haiku-4-5|req:200/hour",
      },
    });
    expect(config.providers["fast"]).toEqual({
      alias: "fast",
      adapter: "anthropic",
      modelId: "claude-haiku-4-5",
      budgetLimit: { kind: "requests", requestsPerHour: 200 },
      costLimit: { kind: "unlimited" },
    });
  });

  it("parses provider entries with USD cost gating", () => {
    const config = parseRegistryConfig({
      env: {
        LLM_PROVIDER_PREMIUM: "anthropic|claude-sonnet-4-6|cost:100/day",
      },
    });
    expect(config.providers["premium"]?.costLimit).toMatchObject({
      kind: "usd",
      perDay: 100,
    });
  });

  it("parses combined req and cost gating", () => {
    const config = parseRegistryConfig({
      env: {
        LLM_PROVIDER_BALANCED: "openai|gpt-5|req:500/hour,cost:50/day",
      },
    });
    const entry = config.providers["balanced"];
    expect(entry?.budgetLimit).toEqual({ kind: "requests", requestsPerHour: 500 });
    expect(entry?.costLimit).toMatchObject({ kind: "usd", perDay: 50 });
  });

  it("parses unlimited gating for local models", () => {
    const config = parseRegistryConfig({
      env: {
        LLM_PROVIDER_LOCAL: "ollama|llama3.3|unlimited",
      },
    });
    expect(config.providers["local"]?.budgetLimit).toEqual({ kind: "unlimited" });
    expect(config.providers["local"]?.costLimit).toEqual({ kind: "unlimited" });
  });

  it("parses task routes with fallback chains", () => {
    const config = parseRegistryConfig({
      env: {
        LLM_TASK_ROUTE_TRIAGE: "fast,premium",
        LLM_TASK_ROUTE_DRAFT: "premium",
      },
    });
    expect(config.taskRoutes["triage"]).toEqual(["fast", "premium"]);
    expect(config.taskRoutes["draft"]).toEqual(["premium"]);
  });

  it("converts underscore-separated names to dash-separated aliases", () => {
    const config = parseRegistryConfig({
      env: {
        LLM_PROVIDER_CLAUDE_SONNET: "anthropic|claude-sonnet|cost:10/day",
        LLM_TASK_ROUTE_TONE_DRAFT: "claude-sonnet",
      },
    });
    expect(config.providers["claude-sonnet"]).toBeDefined();
    expect(config.taskRoutes["tone-draft"]).toEqual(["claude-sonnet"]);
  });

  it("supports a custom env prefix", () => {
    const config = parseRegistryConfig({
      envPrefix: "MYAPP_",
      env: {
        MYAPP_PROVIDER_FAST: "anthropic|haiku|unlimited",
      },
    });
    expect(config.providers["fast"]).toBeDefined();
  });

  it("ignores env vars without the configured prefix", () => {
    const config = parseRegistryConfig({
      env: {
        SOME_OTHER_VAR: "unrelated",
        LLM_PROVIDER_FAST: "anthropic|haiku|unlimited",
      },
    });
    expect(Object.keys(config.providers)).toEqual(["fast"]);
  });

  it("throws ConfigError on malformed provider entries", () => {
    expect(() =>
      parseRegistryConfig({
        env: { LLM_PROVIDER_BAD: "missing-pipes" },
      }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError on invalid gating tokens", () => {
    expect(() =>
      parseRegistryConfig({
        env: { LLM_PROVIDER_BAD: "anthropic|claude|nonsense" },
      }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError on empty task route chains", () => {
    expect(() =>
      parseRegistryConfig({
        env: { LLM_TASK_ROUTE_EMPTY: "  " },
      }),
    ).toThrow(ConfigError);
  });
});
