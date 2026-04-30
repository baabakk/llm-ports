import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/live/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Live tests can take 10-30s each due to real API calls; allow generous timeouts
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
