---
"@llm-ports/core": patch
---

Three outages that were documented to fail over now do.

**A provider HTTP 5xx now fails over** under the default policy and the `"aggressive"` preset. Since alpha.18 a 5xx has been wrapped as `ServiceUnavailableError`, and both policies named only its subclasses, so a 502, 503 or 504 went back to the caller with the configured chain unused. The default policy also missed an empty response for the same reason.

**An unreachable provider now fails over under every policy.** Native `fetch` reports a refused connection, a DNS failure or a connect timeout as `TypeError: fetch failed`, and the `ollama` and `@google/genai` client libraries pass it through unchanged. `wrapProviderError` classified every `TypeError` as `AdapterInternalError`, so a stopped Ollama daemon was reported as an adapter bug and never failed over. It is now `ProviderUnavailableError`. Any other `TypeError` is still treated as a bug.

**The `"aggressive"` preset now walks on `ContentBlockUnsupportedError`**, as the default already did. Previously choosing the broader preset gave less document routing than configuring nothing.
