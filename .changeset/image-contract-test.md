---
"@llm-ports/adapter-contract-tests": minor
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-openai": patch
"@llm-ports/adapter-ollama": patch
"@llm-ports/adapter-vercel": patch
---

Add image-content-block conformance tests to the shared contract suite. Closes a gap where a new adapter could ship with broken image handling and the conformance suite would still pass.

The contract suite now includes two conditional tests under `image content blocks (conditional)`:

1. `generateText accepts a base64 ImageBlock in the prompt`
2. `generateText accepts a URL ImageBlock in the prompt`

Each test gates on a new `ContractTestContext.imageContentSupport` flag:

- `"base64"` — Ollama (URL form is not supported by the underlying API)
- `"url"` — none today
- `"base64+url"` — Anthropic, OpenAI
- `"none"` / undefined — Vercel (v0.1 degrades images to placeholder strings)

Each per-adapter `contract.test.ts` now declares its support level. Total contract-suite tests per adapter went from 8 to 10.
