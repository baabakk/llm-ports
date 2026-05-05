import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/live/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Live tests can take 10-30s each due to real API calls; allow generous timeouts
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Serialize live tests. Running in parallel triggers provider burst
    // protection (OpenAI returns 401 "Incorrect API key" — a misleading
    // status — when too many requests arrive concurrently from new project
    // keys). Use forks+singleFork to run all live tests in one Node process
    // sequentially.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
