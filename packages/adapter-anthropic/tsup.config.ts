import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  minify: false,
  treeshake: true,
  // The Anthropic SDK is a peer of the adapter; users install it themselves.
  external: ["@anthropic-ai/sdk", "@llm-ports/core"],
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },
});
