/**
 * RerankPort — sibling interface to LLMPort and EmbeddingsPort for document
 * reranking.
 *
 * Split from LLMPort because rerank is a separate computational primitive
 * from chat completion: the model takes (query, [docs]) and emits the same
 * documents re-scored and re-ordered by relevance. Cohere Rerank-3, Voyage
 * AI rerank-2, Jina Reranker, Mixedbread mxbai-rerank all ship dedicated
 * rerank APIs that are not chat-completion-shaped.
 *
 * Adapters implementing rerank wrap the provider's native rerank endpoint
 * (e.g. `cohere.rerank()`) directly. They MUST NOT route through the LLM
 * to fake rerank-via-LLM; that loses the cost and latency advantage of
 * dedicated reranker models (typically 50ms / $0.001 per 1000 docs vs
 * seconds / $0.01-$0.10 for an LLM-as-reranker).
 *
 * Added in alpha.17 (interface only; first implementing adapter is
 * adapter-cohere in beta.0). See roadmap §4.6 in the BEPA-internal release
 * plan for the locked design decisions.
 */

import type { CostUsage, TokenUsage } from "./llm-port.js";

/**
 * Input to a rerank call.
 *
 * Single query per call by design (no batching). Cohere and Voyage both
 * support batching but the field rarely uses it; keeping the surface
 * narrow lets the same `cacheKey`/budget semantics apply uniformly.
 */
export interface RerankInput {
  /**
   * The query string against which `documents` are ranked.
   */
  query: string;

  /**
   * Candidate documents to rerank. Order does not matter; each document is
   * scored independently against `query`. The returned `RerankedDocument.index`
   * field maps back to the original position in this array.
   */
  documents: string[];

  /**
   * Return only the top N most-relevant documents. If omitted, all input
   * documents are returned (re-scored and re-ordered).
   */
  topN?: number;

  /**
   * Cancellation signal. Mirrors the pattern in `LLMPort.GenerateTextOptions`;
   * adapters thread this into the underlying HTTP request.
   */
  signal?: AbortSignal;

  /**
   * Override task routing for this call (mirrors `LLMPort.forceProviderAlias`).
   * Per-provider budget + cost gates still apply.
   */
  forceProviderAlias?: string;

  /**
   * Per-call escape hatch for provider-specific request fields not modeled
   * on the port. Shallow-merged into the SDK request body after typed port
   * fields. Examples:
   *   - Cohere: `{ max_chunks_per_doc: 10 }` for long-document chunking
   *   - Voyage: `{ truncation: true }` for input truncation policy
   *   - Jina:   `{ return_documents: false }` to skip echoing doc text
   *
   * Same semantics as `providerExtras` on the LLMPort options. The port
   * does NOT validate; field semantics are provider-specific.
   */
  providerExtras?: Record<string, unknown>;
}

/**
 * A single rescored document in a rerank result.
 *
 * The `document` field echoes the input document text by design; consumers
 * typically need both the score AND the text together (e.g. for display
 * after a vector-search-then-rerank pipeline).
 */
export interface RerankedDocument {
  /**
   * Original position of this document in `RerankInput.documents` (zero-indexed).
   * Use this to correlate results with consumer-side data structures.
   */
  index: number;

  /**
   * Provider-normalized relevance score in the closed interval [0, 1].
   *
   * Cohere returns 0-1 natively. Voyage and Jina also return 0-1. If a
   * future adapter wraps a provider that returns a different range,
   * the adapter MUST normalize before returning.
   */
  relevanceScore: number;

  /**
   * The original document text, echoed for consumer convenience.
   *
   * Some providers can return only `index + relevanceScore` and skip the
   * text (Cohere `return_documents: false`); when callers opt into that
   * via `providerExtras`, this field will be an empty string. The default
   * shape includes the text.
   */
  document: string;
}

/**
 * Result of a successful rerank call.
 *
 * The `usage` and `cost` shapes mirror LLMPort and EmbeddingsPort so that
 * observability hooks (`onCost`, `onTokenUsage` from alpha.21) work
 * uniformly across the three port families.
 */
export interface RerankResult {
  /**
   * Reranked documents in descending order of `relevanceScore`. Length is
   * `min(topN, documents.length)`; defaults to `documents.length` when
   * `topN` is omitted.
   */
  results: RerankedDocument[];

  /**
   * Token / search-unit consumption telemetry. Rerank providers bill in
   * different units:
   *   - Cohere: search units (1 unit = 1 search of ≤100 documents)
   *   - Voyage / Jina / Mixedbread: input tokens
   *
   * The `usage` shape includes optional `searchUnits` and `rerankedDocuments`
   * fields specifically for rerank billing; standard `inputTokens` /
   * `outputTokens` from LLMPort.TokenUsage remain available for adapters
   * that report in tokens.
   */
  usage: TokenUsage;

  /**
   * USD cost computed from `usage` + the adapter's pricing table. Aligned
   * with the LLMPort.CostUsage shape so the same `onCost` observability
   * hook works for rerank calls.
   */
  cost: CostUsage;

  /** Provider-side model identifier that produced the ranking. */
  modelId: string;

  /** Registry alias that resolved to this provider. */
  providerAlias: string;
}

/**
 * Adapters that support reranking implement this interface.
 *
 * The factory returned by `create<Provider>Adapter` exposes
 * `createRerankPort(modelId, alias)` (parallel to `createLLMPort` and
 * `createEmbeddingsPort`) on the adapter. Consumers obtain a RerankPort
 * via the registry or directly from the adapter.
 *
 * See `packages/adapter-cohere` (first implementation, beta.0) for the
 * canonical example.
 */
export interface RerankPort {
  rerank(input: RerankInput): Promise<RerankResult>;
}
