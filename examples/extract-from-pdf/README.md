# `@llm-ports/example-extract-from-pdf`

Document extraction: raw OCR'd text from invoices → fully-typed structured objects, validated by Zod. Demonstrates `generateStructured`, validation-retry-with-feedback, and the `createExtractor` capability factory.

## Run it

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter @llm-ports/example-extract-from-pdf start
```

The example runs three pre-OCR'd invoices through the extraction pipeline:

1. **`clean-invoice`** — well-formatted US-style invoice with all fields
2. **`no-due-date`** — missing the due date (tests nullable handling)
3. **`messy-ocr`** — UK-format invoice with garbled OCR (tests value normalization: `17/04/2026` → `2026-04-17`, `£` → `USD`, etc.)

You'll see something like:

```
📄 Sample: clean-invoice
   vendor: Acme Corporation
   invoice: INV-2026-0042, dated 2026-04-15, due 2026-05-15
   line items: 3
     - Professional services Q1 (1 × $15000.00 = $15000.00)
     - Onsite consulting (3 days) (3 × $2500.00 = $7500.00)
     - Software license renewal (1 × $4800.00 = $4800.00)
   subtotal: $27300.00, tax: $2320.50, total: $29620.50
   → cost: $0.000412, latency: 1832ms, validation attempts: 1

📄 Sample: messy-ocr
   ...
   → cost: $0.000489, latency: 2104ms, validation attempts: 2
```

The `messy-ocr` case will sometimes need a second validation attempt — the model's first pass might emit a date in the wrong format or skip a required field. The retry-with-feedback strategy surfaces the exact Zod issues to the model and asks it to correct.

## What's happening

### The Zod schema is the contract

```ts
const InvoiceSchema = z.object({
  vendor: z.object({ name: z.string().min(1), address: z.string().nullable(), taxID: z.string().nullable() }),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD").nullable(),
  lineItems: z.array(z.object({
    description: z.string().min(1),
    quantity: z.number().positive(),
    unitPriceUSD: z.number().nonnegative(),
    lineTotalUSD: z.number().nonnegative(),
  })).min(1, "At least one line item required"),
  subtotalUSD: z.number().nonnegative(),
  taxUSD: z.number().nonnegative(),
  totalUSD: z.number().positive(),
  notes: z.string().nullable(),
});

type Invoice = z.infer<typeof InvoiceSchema>;
```

The strictness drives the retry behavior: nullable fields don't trigger retries when absent; required fields do.

### The capability factory binds the schema + field guide once

```ts
const extractInvoice = createExtractor({
  port: llm,
  schema: InvoiceSchema,
  schemaName: "invoice",
  fieldGuide: `
    vendor.name: the company billing the customer (top of invoice)
    invoiceNumber: the unique invoice id (often INV-#### or similar)
    invoiceDate: when issued, normalize to YYYY-MM-DD
    ...
  `,
  onResult: (event) => { events.push(event); },
});
```

Improving the field guide improves every extraction call site. This is the difference between the field-extraction prompt being a system asset versus a string copy-pasted across 10 files.

### The validation-retry strategy is what makes this robust

When the model emits malformed output, `retry-with-feedback` (the default validation strategy) does exactly that: feeds the parse errors back to the model and asks it to correct.

```
[attempt 1] model: { "invoiceDate": "April 17, 2026", ... }
            zod:   ✗ "invoiceDate: ISO date YYYY-MM-DD"

[attempt 2] adapter passes the error back to the model:
            "Your previous response failed validation:
             - invoiceDate: ISO date YYYY-MM-DD
             Reply with a single corrected JSON object only."
            model: { "invoiceDate": "2026-04-17", ... }
            zod:   ✓
```

You see this in the example output as `validation attempts: 2`. After `maxAttempts` (default 2), if it still fails, you get a typed `ValidationError` to land in a "needs human review" queue.

## The vision-based upgrade path

This example uses pre-OCR'd text. To skip the OCR step entirely and pass a rendered PDF page directly to a vision-capable model:

```ts
// Render PDF page → PNG via pdf2pic, pdf-poppler, or similar
const pageBuffer = await renderPdfPageToPng(pdfPath, pageNum);

const invoice = await extractInvoice({
  content: [
    { type: "text", text: "Extract the invoice fields from this image." },
    { type: "image", source: { kind: "base64", mediaType: "image/png", data: pageBuffer.toString("base64") } },
  ],
});
```

Note: vision-based extraction is more expensive than text-based (typically 5-10× the input-token cost for a single page). For high-volume pipelines, OCR-then-extract is usually cheaper. For low-volume or noisy-source documents (handwriting, complex layouts), vision is more accurate.

## Production-shape extensions

What this example doesn't do but a real pipeline would:

- **Real OCR.** Tesseract for offline / local; Adobe Extract or AWS Textract for hosted. Output goes into the `content` field as text.
- **Validation in two passes.** After Zod-shape validation, run business-rule validation: `Math.abs(sum(lineItems.lineTotalUSD) - subtotalUSD) < 0.01`. Land mismatches in a review queue.
- **Confidence scoring.** Add a `confidence: z.number().min(0).max(1)` field; threshold below 0.85 routes to human review.
- **Multi-page invoices.** Render each PDF page → batch through the extractor → merge `lineItems[]` arrays.
- **Audit trail.** The `onResult` event has `usage`, `cost`, `latencyMs`, `providerAlias`, `modelId`, and `validationAttempts`. Persist these for every extraction.

## Compare to alternatives

| Library | What you'd write |
|---|---|
| Direct `@anthropic-ai/sdk` | Call `messages.create` with `response_format: 'json'`, then `JSON.parse`, then validate with Zod yourself, then implement retry-with-feedback by reconstructing the error message and re-calling. ~3-4× the code per extraction site. |
| Vercel AI SDK `generateObject` | Comparable shape for one-shot extraction, but no validation retry strategy, no capability factory pattern (each call site owns its rubric/field guide), no fallback chain. |
| LangChain `StructuredOutputParser` | Different abstraction; uses output parsers in chains. The validation-retry equivalent is `OutputFixingParser`; the field-guide pattern is `RetryWithErrorOutputParser`. More ceremony for the same result. |
