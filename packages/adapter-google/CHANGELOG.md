# @llm-ports/adapter-google

## 0.1.0-alpha.5

### Minor Changes

- b00ff65: New native Google Gemini adapter (closes issue #14). Built on the unified `@google/genai` SDK (v2.x).

  **What it does that OpenAI-compat baseURL doesn't:**
  - Full multimodal: image content blocks pass through as `inlineData` (base64) or `fileData` (URL), NOT degraded to text placeholders.
  - Native `systemInstruction` as a top-level field instead of prepended user message (preserves Gemini's intended behavior).
  - Bundled pricing for Gemini 2.5 (pro / flash / flash-lite) and Gemini 2.0 (flash / flash-lite). Compat-baseURL users had to supply their own.
  - Image-block boundary validation (size + URL scheme) wired in alpha.5, consistent with adapter-anthropic and adapter-openai.

  **v0.1 alpha scope:**
  - `generateText` — full
  - `generateStructured` — prompted JSON + Zod + alpha.5 repair pass. (Native `responseSchema` constrained-decoding lands in v0.2.)
  - `streamText` / `streamStructured` — full
  - `runAgent` — single-turn shim (multi-turn native function-calling lands in v0.2, matching adapter-vercel's v0.1 shape)

  **Out of scope for v0.1 (each filed for v0.2):**
  - Embeddings (`gemini-embedding-001`)
  - Explicit context caching (Gemini's `cachedContent`)
  - Code execution tool (built-in code interpreter)

  **Install:**

  ```bash
  pnpm add @llm-ports/core @llm-ports/adapter-google @google/genai zod
  ```

  19 content-translation tests + 12 contract conformance tests.

### Patch Changes

- Updated dependencies [b00ff65]
- Updated dependencies [b00ff65]
- Updated dependencies [b00ff65]
  - @llm-ports/core@0.1.0-alpha.5
