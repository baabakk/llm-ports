---
"@llm-ports/core": minor
"@llm-ports/adapter-openai": minor
---

Add optional `detail?: "auto" | "low" | "high"` field to `ImageSource` (both base64 and URL variants). Forwarded to OpenAI's `image_url.detail` to control the cost-vs-fidelity tradeoff:

- `"low"` ~85 tokens regardless of image size; suitable for triage / broad classification
- `"high"` ~170 tokens per 512×512 tile; needed for OCR and fine-grained reasoning
- `"auto"` (default) lets OpenAI decide based on image size

For screenshot-heavy or document-OCR workloads, switching to `"low"` for triage can cut per-image vision cost ~9x. The field is additive — existing call sites work unchanged.

Other adapters (Anthropic, Ollama) ignore the field. Anthropic and Ollama have no equivalent knob in their respective image APIs.

```ts
{
  type: "image",
  source: {
    kind: "base64",
    mediaType: "image/png",
    data: screenshotBase64,
    detail: "low",
  },
}
```
