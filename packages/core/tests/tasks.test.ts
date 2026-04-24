import { describe, expect, it } from "vitest";
import { declareTasks, getTaskConfig } from "../src/index.js";

describe("declareTasks", () => {
  it("returns string-literal keys equal to their names", () => {
    const tasks = declareTasks({
      triage: { priority: 1, defaultTemperature: 0 },
      draft: { priority: 2, defaultTemperature: 0.4 },
    });
    expect(tasks.triage).toBe("triage");
    expect(tasks.draft).toBe("draft");
  });

  it("preserves the original config under non-enumerable __meta", () => {
    const tasks = declareTasks({
      triage: { priority: 1, defaultTemperature: 0 },
    });
    const cfg = getTaskConfig(tasks, "triage");
    expect(cfg).toEqual({ priority: 1, defaultTemperature: 0 });
  });

  it("does not enumerate __meta in for...of or Object.keys", () => {
    const tasks = declareTasks({
      triage: { priority: 1 },
    });
    expect(Object.keys(tasks)).toEqual(["triage"]);
  });
});
