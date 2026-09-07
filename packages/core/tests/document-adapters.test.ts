/**
 * Alpha.33, item 3 — per-adapter `DocumentBlock` mapping.
 *
 * These live in `core` rather than in each adapter package so the whole
 * support matrix is asserted in one place. The point of a table like this
 * is that a reader can see at a glance which providers carry a document
 * and which refuse, and a future adapter cannot quietly join the union
 * without appearing here.
 *
 * Every mapping below was derived from the provider SDK's shipped typings
 * rather than from its documentation, and each refusal is
 * `ContentBlockUnsupportedError`, which the Registry treats as walk-worthy
 * (see `document-block.test.ts`).
 */

import { describe, expect, it } from "vitest";
import { type DocumentBlock } from "../src/index.js";

/**
 * Assert a refusal by error NAME, not by `instanceof`.
 *
 * The adapters resolve `@llm-ports/core` to its built `dist`, while this file
 * imports from `src`, so the two see different class objects and `instanceof`
 * is false even though the error is exactly right. That is an artifact of the
 * test setup here, but it is not only an artifact: `core` is a regular
 * dependency of every adapter rather than a peer dependency, so a consumer
 * with version skew can hold two copies and hit the same thing in production,
 * where it would silently disable fallback. Tracked as
 * `TD-LLMPORTS-CORE-IS-A-DEP-NOT-A-PEER-DEP`.
 */
function expectRefusal(fn: () => unknown): void {
  expect(fn).toThrow(/does not support content block type/);
  try {
    fn();
  } catch (err) {
    expect((err as Error).name).toBe("ContentBlockUnsupportedError");
  }
}

import { toOpenAIUserContent } from "../../adapter-openai/src/content.js";
import { toGeminiParts2 } from "../../adapter-google/src/content.js";
import { toVercelParts } from "../../adapter-vercel/src/content.js";
import { toAnthropicContent } from "../../adapter-anthropic/src/content.js";
import { toOllamaMessages } from "../../adapter-ollama/src/content.js";

const PDF_BYTES: DocumentBlock = {
  type: "document",
  source: { kind: "base64", mediaType: "application/pdf", data: "JVBERi0=" },
  filename: "report.pdf",
};

const PDF_UNNAMED: DocumentBlock = {
  type: "document",
  source: { kind: "base64", mediaType: "application/pdf", data: "JVBERi0=" },
};

const PDF_URL: DocumentBlock = {
  type: "document",
  source: { kind: "url", url: "https://example.com/report.pdf", mediaType: "application/pdf" },
};

const PDF_URL_UNTYPED: DocumentBlock = {
  type: "document",
  source: { kind: "url", url: "https://example.com/report.pdf" },
};

describe("adapter-openai", () => {
  it("maps base64 to the file content part as a data URI", () => {
    expect(toOpenAIUserContent([PDF_BYTES])).toEqual([
      {
        type: "file",
        file: {
          file_data: "data:application/pdf;base64,JVBERi0=",
          filename: "report.pdf",
        },
      },
    ]);
  });

  it("synthesizes a filename when the caller omitted one", () => {
    // OpenAI wants a name alongside the bytes; sending them unnamed is worse
    // than picking a defensible default from the media type.
    const parts = toOpenAIUserContent([PDF_UNNAMED]) as Array<{
      file: { filename: string };
    }>;
    expect(parts[0]?.file.filename).toBe("document.pdf");
  });

  it("refuses a URL, which its file part has no shape for", () => {
    expectRefusal(() => toOpenAIUserContent([PDF_URL]));
  });
});

describe("adapter-google", () => {
  it("maps base64 to inlineData", () => {
    expect(toGeminiParts2([PDF_BYTES])).toEqual([
      { inlineData: { mimeType: "application/pdf", data: "JVBERi0=" } },
    ]);
  });

  it("maps a typed URL to fileData", () => {
    expect(toGeminiParts2([PDF_URL])).toEqual([
      { fileData: { mimeType: "application/pdf", fileUri: "https://example.com/report.pdf" } },
    ]);
  });

  it("refuses a URL with no media type rather than guessing one", () => {
    // The image branch defaults to image/jpeg, which is safe because every
    // image is an image. A PDF and a CSV are not interchangeable, and a
    // wrong mimeType fails deep inside the provider.
    expectRefusal(() => toGeminiParts2([PDF_URL_UNTYPED]));
  });
});

describe("adapter-vercel", () => {
  it("maps base64 through its generic file part", () => {
    expect(toVercelParts([PDF_BYTES])).toEqual([
      { type: "file", data: "JVBERi0=", mimeType: "application/pdf" },
    ]);
  });

  it("maps a typed URL through the same part", () => {
    expect(toVercelParts([PDF_URL])).toEqual([
      { type: "file", data: "https://example.com/report.pdf", mimeType: "application/pdf" },
    ]);
  });
});

describe("adapter-anthropic", () => {
  it("refuses documents on the supported SDK range", () => {
    // The API has a document block; the pinned SDK cannot express it. The
    // refusal is honest and the Registry routes past it.
    expectRefusal(() => toAnthropicContent([PDF_BYTES]));
  });
});

describe("adapter-ollama", () => {
  it("refuses documents rather than dropping them silently", () => {
    // This is the important one. Ollama builds its message from `textOnly`,
    // so an unhandled block kind is discarded and the model answers
    // confidently about a document it never received. A throw is the only
    // safe behaviour.
    expectRefusal(() => toOllamaMessages([{ role: "user", content: [PDF_BYTES] }]));
  });
});
